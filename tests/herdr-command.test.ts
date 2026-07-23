import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrCommandExecutionAdapter } from "../src/adapters/herdr-command";
import type {
	CommandExecutionResult,
	CommandRequest,
	DelayAdapter,
} from "../src/adapters/interfaces";
import type { ControllerLocalState, ExecutionRecord } from "../src/controller/model";
import { GuardedHerdrCommandAdapter, HerdrSessionManager } from "../src/herdr";
import { type LedgerIdSource, openSqliteLedger } from "../src/ledger";
import {
	createInitialControllerState,
	FixedClockAdapter,
	ScriptedCommandAdapter,
	ScriptedProcessTreeAdapter,
} from "../src/testing";

const startedAt = "2026-07-23T00:00:00.000Z";
const token = "ghs_worker-specification-token";
const prompt = "private workflow prompt text";

class Ids implements LedgerIdSource {
	#next = 1;

	public nextId(
		kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session",
	): string {
		const id = `${kind}-herdr-command-${this.#next}`;
		this.#next += 1;
		return id;
	}
}

class AdvancingDelay implements DelayAdapter {
	public readonly waits: number[] = [];

	public constructor(
		private readonly clock: FixedClockAdapter,
		private readonly afterWait: (waitCount: number) => void = () => {},
	) {}

	public async wait(milliseconds: number): Promise<void> {
		this.waits.push(milliseconds);
		this.clock.advance(milliseconds);
		this.afterWait(this.waits.length);
	}
}

function execution(): ExecutionRecord {
	return {
		executionId: "execution-1",
		projectId: "project-one",
		lane: "implementation",
		provider: "claude",
		workflow: "fixture-workflow",
		claimState: "verified",
		issueNumber: 1,
		pullRequestNumber: null,
		branch: "factory/issue-1",
		worktreeId: "worktree-1",
		headSha: "1".repeat(40),
		status: "active",
	};
}

function state(): ControllerLocalState {
	const value = createInitialControllerState([]);
	value.projectEnabled["project-one"] = true;
	value.executions.push(execution());
	return value;
}

function ok(stdout = ""): CommandExecutionResult {
	return {
		status: "exited",
		exitCode: 0,
		stdout,
		stderr: "",
		processId: null,
	};
}

function protocolPane(name: string | null): Record<string, unknown> {
	return {
		pane_id: "pane-1",
		terminal_id: "terminal-pane-1",
		workspace_id: "workspace-factory",
		tab_id: "tab-factory",
		focused: false,
		agent_status: "working",
		revision: 1,
		label: name,
	};
}

function splitOutput(): string {
	return JSON.stringify({
		id: "response-pane",
		result: {
			type: "pane_info",
			pane: protocolPane(null),
		},
	});
}

function paneListOutput(includePane: boolean): string {
	return JSON.stringify({
		id: "response-list",
		result: {
			type: "pane_list",
			panes: includePane ? [protocolPane("execution-1")] : [],
		},
	});
}

function processInfoOutput(): string {
	return JSON.stringify({
		id: "response-process",
		result: {
			type: "pane_process_info",
			process_info: {
				pane_id: "pane-1",
				shell_pid: 101,
			},
		},
	});
}

function liveProcessTree() {
	return {
		rootProcessId: 101,
		tree: [
			{ processId: 101, parentProcessId: null, startedAt },
			{ processId: 102, parentProcessId: 101, startedAt },
		],
	} as const;
}

function request(): CommandRequest {
	return {
		executable: "claude",
		argv: ["--print"],
		cwd: "/factory/worktrees/project-one/issue-1",
		env: {
			GH_TOKEN: token,
			GITHUB_TOKEN: token,
			PATH: "/usr/bin",
		},
		stdin: prompt,
		stdout: "capture-json-lines",
		stderr: "capture",
	};
}

async function temporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-factory-herdr-command-"));
	try {
		await run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("Herdr command result custody", () => {
	test("carries env and stdin only in a mode-0600 specification and reads a normal result", async () => {
		await temporaryDirectory(async (directory) => {
			const clock = new FixedClockAdapter();
			const ledger = openSqliteLedger({
				stateDirectory: directory,
				instanceId: "controller-a",
				clock,
				ids: new Ids(),
				initialState: state(),
			});
			ledger.startAttempt("execution-1");
			const commands = new ScriptedCommandAdapter([
				ok(),
				ok(splitOutput()),
				ok(),
				ok(),
				ok(processInfoOutput()),
				ok(paneListOutput(true)),
				ok(processInfoOutput()),
			]);
			const processes = new ScriptedProcessTreeAdapter([liveProcessTree(), liveProcessTree()]);
			const manager = new HerdrSessionManager({
				herdr: new GuardedHerdrCommandAdapter({
					commands,
					workingDirectory: directory,
				}),
				processes,
				repository: ledger,
				clock,
				hostIdentity: "factory-host",
			});
			const resultPath = join(directory, "execution-details", "execution-1-1.json");
			const delay = new AdvancingDelay(clock, () => {
				writeFileSync(
					resultPath,
					JSON.stringify({
						status: "exited",
						exitCode: 0,
						stdout: "worker output",
						stderr: "",
						processId: 202,
					}),
					{ mode: 0o600 },
				);
			});
			const adapter = new HerdrCommandExecutionAdapter({
				herdr: manager,
				ledger,
				delay,
				clock,
				stateDirectory: directory,
				workerExecutable: "/factory/bin/worker-command.ts",
				resultDeadlineMs: 5_000,
			});

			expect(
				await adapter.runForExecution("execution-1", () => adapter.execute(request())),
			).toEqual({
				status: "exited",
				exitCode: 0,
				stdout: "worker output",
				stderr: "",
				processId: 202,
			});

			const specificationPath = join(directory, "execution-details", "execution-1-1.spec.json");
			expect(statSync(specificationPath).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(specificationPath, "utf8"))).toEqual({
				schemaVersion: 1,
				executable: "claude",
				argv: ["--print"],
				cwd: "/factory/worktrees/project-one/issue-1",
				env: {
					GH_TOKEN: token,
					GITHUB_TOKEN: token,
					PATH: "/usr/bin",
				},
				stdin: prompt,
				resultPath,
			});
			const herdrArgv = commands.requests.flatMap((command) => command.argv);
			expect(herdrArgv).not.toContain("GH_TOKEN");
			expect(herdrArgv).not.toContain("GITHUB_TOKEN");
			expect(herdrArgv).not.toContain(token);
			expect(herdrArgv).not.toContain(prompt);
			expect(herdrArgv).not.toContain("--env");
			expect(herdrArgv).not.toContain("send-text");
			expect(commands.requests[3]?.argv).toEqual([
				"--session",
				"agent-factory",
				"pane",
				"run",
				"pane-1",
				"--",
				"bun",
				"/factory/bin/worker-command.ts",
				specificationPath,
			]);
			expect(commands.requests.every((command) => Object.keys(command.env).length === 0)).toBe(
				true,
			);
			expect(delay.waits).toEqual([1_000]);
			expect(processes.inspections).toEqual([101, 101]);
			expect(commands.remaining()).toBe(0);
			ledger.close();
		});
	});

	test("classifies wrapper death without waiting when the recorded process is gone", async () => {
		await temporaryDirectory(async (directory) => {
			const clock = new FixedClockAdapter();
			const ledger = openSqliteLedger({
				stateDirectory: directory,
				instanceId: "controller-a",
				clock,
				ids: new Ids(),
				initialState: state(),
			});
			ledger.startAttempt("execution-1");
			const commands = new ScriptedCommandAdapter([
				ok(),
				ok(splitOutput()),
				ok(),
				ok(),
				ok(processInfoOutput()),
				ok(paneListOutput(false)),
			]);
			const processes = new ScriptedProcessTreeAdapter([
				liveProcessTree(),
				{
					rootProcessId: 101,
					tree: [{ processId: 101, parentProcessId: null, startedAt }],
				},
			]);
			const manager = new HerdrSessionManager({
				herdr: new GuardedHerdrCommandAdapter({
					commands,
					workingDirectory: directory,
				}),
				processes,
				repository: ledger,
				clock,
				hostIdentity: "factory-host",
			});
			const delay = new AdvancingDelay(clock);
			const adapter = new HerdrCommandExecutionAdapter({
				herdr: manager,
				ledger,
				delay,
				clock,
				stateDirectory: directory,
				workerExecutable: "/factory/bin/worker-command.ts",
				resultDeadlineMs: 5_000,
			});

			expect(
				await adapter.runForExecution("execution-1", () => adapter.execute(request())),
			).toEqual({
				status: "failed",
				classification: "wrapper-death",
				stdout: "",
				stderr: "",
				processId: 101,
			});
			expect(delay.waits).toEqual([]);
			expect(existsSync(join(directory, "execution-details", "execution-1-1.spec.json"))).toBe(
				false,
			);
			expect(processes.inspections).toEqual([101, 101]);
			expect(commands.remaining()).toBe(0);
			ledger.close();
		});
	});

	test("classifies deadline expiry after bounded live-process polls", async () => {
		await temporaryDirectory(async (directory) => {
			const clock = new FixedClockAdapter();
			const ledger = openSqliteLedger({
				stateDirectory: directory,
				instanceId: "controller-a",
				clock,
				ids: new Ids(),
				initialState: state(),
			});
			ledger.startAttempt("execution-1");
			const commands = new ScriptedCommandAdapter([
				ok(),
				ok(splitOutput()),
				ok(),
				ok(),
				ok(processInfoOutput()),
				ok(paneListOutput(true)),
				ok(processInfoOutput()),
				ok(paneListOutput(true)),
				ok(processInfoOutput()),
			]);
			const processes = new ScriptedProcessTreeAdapter([
				liveProcessTree(),
				liveProcessTree(),
				liveProcessTree(),
			]);
			const manager = new HerdrSessionManager({
				herdr: new GuardedHerdrCommandAdapter({
					commands,
					workingDirectory: directory,
				}),
				processes,
				repository: ledger,
				clock,
				hostIdentity: "factory-host",
			});
			const delay = new AdvancingDelay(clock);
			const adapter = new HerdrCommandExecutionAdapter({
				herdr: manager,
				ledger,
				delay,
				clock,
				stateDirectory: directory,
				workerExecutable: "/factory/bin/worker-command.ts",
				resultDeadlineMs: 2_000,
			});

			expect(
				await adapter.runForExecution("execution-1", () => adapter.execute(request())),
			).toEqual({
				status: "failed",
				classification: "timeout",
				stdout: "",
				stderr: "",
				processId: 101,
			});
			expect(delay.waits).toEqual([1_000, 1_000]);
			expect(existsSync(join(directory, "execution-details", "execution-1-1.spec.json"))).toBe(
				false,
			);
			expect(processes.inspections).toEqual([101, 101, 101]);
			expect(commands.remaining()).toBe(0);
			ledger.close();
		});
	});
});
