import { AsyncLocalStorage } from "node:async_hooks";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import type {
	ClockAdapter,
	CommandAdapter,
	CommandExecutionResult,
	CommandRequest,
	DelayAdapter,
} from "@/adapters/interfaces.ts";
import { parseCommandExecutionResult } from "@/contracts/command-result.ts";
import { safeId } from "@/contracts/primitives.ts";
import {
	parseWorkerCommandSpecification,
	type WorkerCommandSpecification,
} from "@/contracts/worker-command.ts";
import type { SqliteLedger } from "@/ledger/index.ts";

export const DEFAULT_HERDR_COMMAND_RESULT_DEADLINE_MS = 6 * 60 * 60 * 1_000;
const RESULT_POLL_INTERVAL_MS = 1_000;

interface ExecutionContext {
	readonly executionId: string;
}

export interface HerdrCommandSupervisor {
	createPane(input: {
		readonly executionId: string;
		readonly attemptNumber: number;
		readonly providerSessionId: string | null;
		readonly command: CommandRequest;
	}): Promise<{ readonly processId: number | null }>;
	isExecutionAlive(executionId: string): Promise<boolean>;
}

export class HerdrCommandExecutionAdapter implements CommandAdapter {
	readonly #herdr: HerdrCommandSupervisor;
	readonly #ledger: SqliteLedger;
	readonly #delay: DelayAdapter;
	readonly #clock: ClockAdapter;
	readonly #resultDirectory: string;
	readonly #workerExecutable: string;
	readonly #resultDeadlineMs: number;
	readonly #context = new AsyncLocalStorage<ExecutionContext>();

	public constructor(input: {
		readonly herdr: HerdrCommandSupervisor;
		readonly ledger: SqliteLedger;
		readonly delay: DelayAdapter;
		readonly clock: ClockAdapter;
		readonly stateDirectory: string;
		readonly workerExecutable: string;
		readonly resultDeadlineMs?: number;
	}) {
		this.#herdr = input.herdr;
		this.#ledger = input.ledger;
		this.#delay = input.delay;
		this.#clock = input.clock;
		this.#resultDirectory = join(input.stateDirectory, "execution-details");
		this.#workerExecutable = input.workerExecutable;
		this.#resultDeadlineMs = z
			.number()
			.int()
			.positive()
			.max(7 * 24 * 60 * 60 * 1_000)
			.parse(input.resultDeadlineMs ?? DEFAULT_HERDR_COMMAND_RESULT_DEADLINE_MS);
		mkdirSync(this.#resultDirectory, { recursive: true, mode: 0o700 });
		chmodSync(this.#resultDirectory, 0o700);
	}

	public runForExecution<T>(executionId: string, run: () => Promise<T>): Promise<T> {
		return this.#context.run({ executionId: safeId.parse(executionId) }, run);
	}

	public async execute(request: CommandRequest): Promise<CommandExecutionResult> {
		const context = this.#context.getStore();
		if (context === undefined) {
			throw new Error("Herdr command execution requires an execution context");
		}
		const recovery = this.#ledger.readExecutionRecovery(context.executionId);
		const attempt = recovery.attempts.at(-1);
		if (attempt === undefined || attempt.status !== "active") {
			throw new Error("Herdr command execution requires one active ledger attempt");
		}
		const resultPath = join(
			this.#resultDirectory,
			`${context.executionId}-${attempt.attemptNumber}.json`,
		);
		if (existsSync(resultPath)) {
			return parseCommandExecutionResult(JSON.parse(readFileSync(resultPath, "utf8")));
		}
		const specificationPath = join(
			this.#resultDirectory,
			`${context.executionId}-${attempt.attemptNumber}.spec.json`,
		);
		const specification = parseWorkerCommandSpecification({
			schemaVersion: 1,
			executable: request.executable,
			argv: request.argv,
			cwd: request.cwd,
			env: request.env,
			stdin: request.stdin,
			resultPath,
		});
		this.#writeSpecification(specificationPath, specification);
		const waitStartedAt = this.#now();
		let processId: number | null = null;
		try {
			const process = await this.#herdr.createPane({
				executionId: context.executionId,
				attemptNumber: attempt.attemptNumber,
				providerSessionId: this.#providerSessionId(request),
				command: {
					executable: "bun",
					argv: [this.#workerExecutable, specificationPath],
					cwd: request.cwd,
					env: {},
					stdin: "",
					stdout: "capture-json-lines",
					stderr: "capture",
				},
			});
			processId = process.processId;
		} catch (error) {
			this.#deleteSpecification(specificationPath);
			throw error;
		}
		const maximumPolls = Math.ceil(this.#resultDeadlineMs / RESULT_POLL_INTERVAL_MS);
		for (let poll = 0; poll < maximumPolls; poll += 1) {
			if (existsSync(resultPath)) {
				return parseCommandExecutionResult(JSON.parse(readFileSync(resultPath, "utf8")));
			}
			const elapsed = this.#now() - waitStartedAt;
			if (elapsed < 0) {
				throw new Error("Herdr command result clock moved backwards");
			}
			if (elapsed >= this.#resultDeadlineMs) {
				return this.#failedResult("timeout", processId, specificationPath);
			}
			if (!(await this.#herdr.isExecutionAlive(context.executionId))) {
				if (existsSync(resultPath)) {
					return parseCommandExecutionResult(JSON.parse(readFileSync(resultPath, "utf8")));
				}
				return this.#failedResult("wrapper-death", processId, specificationPath);
			}
			await this.#delay.wait(Math.min(RESULT_POLL_INTERVAL_MS, this.#resultDeadlineMs - elapsed));
		}
		if (existsSync(resultPath)) {
			return parseCommandExecutionResult(JSON.parse(readFileSync(resultPath, "utf8")));
		}
		return this.#failedResult("timeout", processId, specificationPath);
	}

	#providerSessionId(request: CommandRequest): string | null {
		const sessionIndex = request.argv.indexOf("--session-id");
		if (sessionIndex >= 0) {
			return request.argv[sessionIndex + 1] ?? null;
		}
		const resumeIndex = request.argv.indexOf("resume");
		if (resumeIndex >= 0 && request.argv[0] === "exec") {
			return request.argv[resumeIndex + 1] ?? null;
		}
		return null;
	}

	#writeSpecification(path: string, specification: WorkerCommandSpecification): void {
		const serialized = JSON.stringify(specification);
		try {
			writeFileSync(path, serialized, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			chmodSync(path, 0o600);
			return;
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				Reflect.get(error, "code") !== "EEXIST"
			) {
				throw error;
			}
		}
		const metadata = lstatSync(path);
		if (
			!metadata.isFile() ||
			(metadata.mode & 0o777) !== 0o600 ||
			JSON.stringify(parseWorkerCommandSpecification(JSON.parse(readFileSync(path, "utf8")))) !==
				serialized
		) {
			throw new Error("existing worker command specification failed custody validation");
		}
	}

	#now(): number {
		const now = this.#clock.now().getTime();
		if (!Number.isFinite(now)) {
			throw new Error("Herdr command result clock returned an invalid date");
		}
		return now;
	}

	#failedResult(
		classification: "timeout" | "wrapper-death",
		processId: number | null,
		specificationPath: string,
	): CommandExecutionResult {
		this.#deleteSpecification(specificationPath);
		return {
			status: "failed",
			classification,
			stdout: "",
			stderr: "",
			processId,
		};
	}

	#deleteSpecification(path: string): void {
		try {
			if (existsSync(path) && lstatSync(path).isFile()) {
				unlinkSync(path);
			}
		} catch {
			// Best-effort custody cleanup tolerates wrapper deletion and concurrent recovery.
		}
	}
}
