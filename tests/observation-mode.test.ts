import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	DoctorSystemAdapter,
	FileMetadata,
	GitHubObserveOptions,
	RuntimeFileSystemAdapter,
} from "@/adapters/interfaces.ts";
import { composeDaemon } from "@/daemon/composition.ts";
import { CURRENT_LEDGER_SCHEMA_VERSION, type LedgerIdSource } from "@/ledger/index.ts";
import { Doctor } from "@/operations/doctor.ts";
import { loadFactoryConfiguration, resolveXdgPaths } from "@/operations/runtime.ts";
import type { ReleaseBuilder, ReleaseStore } from "@/releases/index.ts";
import {
	FixedClockAdapter,
	InMemoryGitHubAdapter,
	InMemoryNotificationAdapter,
	InMemoryReleaseLedgerAdapter,
	InMemoryWorkerProcessAdapter,
	ScriptedReleaseMigrationSourceAdapter,
	ScriptedReleaseServiceAdapter,
	SequenceRandomAdapter,
} from "@/testing/index.ts";

class RuntimeFiles implements RuntimeFileSystemAdapter {
	readonly #files = new Map<string, { content: string; metadata: FileMetadata }>();

	public put(path: string, content: string, metadata: FileMetadata): void {
		this.#files.set(path, { content, metadata: structuredClone(metadata) });
	}

	public async stat(path: string): Promise<FileMetadata> {
		const file = this.#files.get(path);
		if (file === undefined) {
			throw new Error(`missing scripted file '${path}'`);
		}
		return structuredClone(file.metadata);
	}

	public async readText(path: string): Promise<string> {
		const file = this.#files.get(path);
		if (file === undefined) {
			throw new Error(`missing scripted file '${path}'`);
		}
		return file.content;
	}

	public async ensureDirectory(path: string, mode: number): Promise<void> {
		this.put(path, "", { kind: "directory", mode });
	}

	public async listFiles(path: string): Promise<readonly string[]> {
		return [...this.#files.keys()].filter((candidate) => candidate.startsWith(`${path}/`)).sort();
	}
}

class DoctorSystem implements DoctorSystemAdapter {
	readonly liveCalls: string[] = [];

	public async binaryVersion(name: string): Promise<string | null> {
		return `${name} fixture-version`;
	}

	public async socketReachable(): Promise<boolean> {
		return true;
	}

	public async systemdUnitPresent(): Promise<boolean> {
		return true;
	}

	public async ledgerSchemaVersion(): Promise<number | null> {
		return CURRENT_LEDGER_SCHEMA_VERSION;
	}

	public async liveProbe(provider: "claude" | "codex" | "github") {
		this.liveCalls.push(provider);
		return { ok: true, detail: `${provider} fixture probe` };
	}
}

class Ids implements LedgerIdSource {
	#sequence = 0;

	public nextId(
		kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session",
	): string {
		this.#sequence += 1;
		return `${kind}-${this.#sequence}`;
	}
}

describe("composed daemon observation-mode proof", () => {
	test("starts and reconciles repeatedly with no GitHub mutation, worker, or notification effects", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-factory-observation-"));
		const paths = resolveXdgPaths({
			XDG_CONFIG_HOME: join(directory, "config"),
			XDG_STATE_HOME: join(directory, "state"),
			XDG_DATA_HOME: join(directory, "data"),
		});
		mkdirSync(paths.logDirectory, { recursive: true, mode: 0o700 });
		mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
		mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });

		const fileSystem = new RuntimeFiles();
		for (const path of [paths.configDirectory, paths.stateDirectory, paths.dataDirectory]) {
			fileSystem.put(path, "", { kind: "directory", mode: 0o700 });
		}
		const exampleRoot = join(import.meta.dir, "..", "config", "examples", "multi-project");
		fileSystem.put(paths.configFile, readFileSync(join(exampleRoot, "config.yaml"), "utf8"), {
			kind: "file",
			mode: 0o600,
		});
		for (const name of ["hhc-aep.yaml", "lumen-notes.yaml"]) {
			fileSystem.put(
				join(paths.profilesDirectory, name),
				readFileSync(join(exampleRoot, "profiles", name), "utf8"),
				{ kind: "file", mode: 0o600 },
			);
		}

		const configuration = await loadFactoryConfiguration(paths, fileSystem);
		const hhc = configuration.profiles[0];
		const lumen = configuration.profiles[1];
		if (hhc === undefined || lumen === undefined) {
			throw new Error("shipped observation fixture profiles are missing");
		}
		const observations = [
			{
				projectId: hhc.id,
				issues: [
					{
						number: 1,
						state: "open" as const,
						labels: [hhc.labels.implementationReady],
						branch: null,
						worktreeId: null,
						pullRequestNumber: null,
					},
				],
				pullRequests: [
					{
						number: 11,
						state: "open" as const,
						labels: [hhc.labels.feedbackReady],
						linkedIssueNumber: 1,
						branch: "factory/issue-1",
						headSha: "1".repeat(40),
					},
				],
			},
			{
				projectId: lumen.id,
				issues: [
					{
						number: 2,
						state: "open" as const,
						labels: [lumen.labels.implementationReady],
						branch: null,
						worktreeId: null,
						pullRequestNumber: null,
					},
				],
				pullRequests: [
					{
						number: 12,
						state: "open" as const,
						labels: [lumen.labels.feedbackReady],
						linkedIssueNumber: 2,
						branch: "factory/issue-2",
						headSha: "2".repeat(40),
					},
				],
			},
		];
		const githubBase = new InMemoryGitHubAdapter(observations);
		const observeOptions: GitHubObserveOptions[] = [];
		const github = {
			async observe(
				projectIds: readonly string[],
				options?: GitHubObserveOptions,
			): Promise<unknown> {
				if (options !== undefined) {
					observeOptions.push(structuredClone(options));
				}
				return githubBase.observe(projectIds);
			},
		};
		const workers = new InMemoryWorkerProcessAdapter();
		const controllerNotifications = new InMemoryNotificationAdapter();
		const operationalNotifications = new InMemoryNotificationAdapter();
		const doctorSystem = new DoctorSystem();
		const disk = {
			async usage() {
				return { usedBytes: 10, totalBytes: 100 };
			},
		};
		const doctor = new Doctor({
			paths,
			fileSystem,
			disk,
			system: doctorSystem,
			loadConfiguration: () => loadFactoryConfiguration(paths, fileSystem),
		});
		let status: unknown;
		let doctorReport: Awaited<ReturnType<Doctor["run"]>> | undefined;
		let ledgerRevision: number | undefined;
		let delayCalls = 0;
		let socketStarts = 0;
		let recoveryScans = 0;
		let labelCalls = 0;
		let composed: ReturnType<typeof composeDaemon>;
		const delay = {
			async wait() {
				delayCalls += 1;
				if (delayCalls === 3) {
					status = await composed.router.dispatch({ operation: "status" });
					doctorReport = await doctor.run({ live: false });
					ledgerRevision = (await composed.ledger.read()).revision;
					await composed.stop();
				}
			},
		};
		const releaseLedger = new InMemoryReleaseLedgerAdapter(CURRENT_LEDGER_SCHEMA_VERSION);

		composed = composeDaemon({
			paths,
			configuration,
			fileSystem,
			disk,
			doctorSystem,
			clock: new FixedClockAdapter(),
			random: new SequenceRandomAdapter([0.5]),
			delay,
			ids: new Ids(),
			instanceId: "observation-proof-controller",
			notificationAdapter: operationalNotifications,
			environment: {},
			prior: {
				controllerAdapters: {
					github,
					clock: new FixedClockAdapter(),
					random: new SequenceRandomAdapter([0.5]),
					fileSystem,
					processes: workers,
					notifications: controllerNotifications,
				},
				workers: {
					async attach() {
						throw new Error("worker operator must not run in observation proof");
					},
					async takeover() {
						throw new Error("worker operator must not run in observation proof");
					},
					async resume() {
						throw new Error("worker operator must not run in observation proof");
					},
					async stop() {
						throw new Error("worker operator must not run in observation proof");
					},
					async kill() {
						throw new Error("worker operator must not run in observation proof");
					},
				},
				labels: {
					async plan() {
						labelCalls += 1;
					},
					async preview() {
						labelCalls += 1;
					},
					async apply() {
						labelCalls += 1;
					},
				},
				recoveryScanner: {
					async recover() {
						recoveryScans += 1;
						return [];
					},
				},
				recoveryVerifier: {
					async verify() {
						return { durable: true, failures: [] };
					},
				},
				ownedProcesses: {
					async stopFactoryOwned() {
						return [];
					},
				},
				retentionArtifacts: {
					async candidates() {
						return [];
					},
					async removeWorktree() {
						throw new Error("no retention candidate expected");
					},
					async removeExecutionLogs() {
						throw new Error("no retention candidate expected");
					},
				},
				claudeRunner: {} as never,
				codexRunner: {} as never,
				herdr: {} as never,
				worktrees: {} as never,
				convergence: {} as never,
				recoveryHandoff: {} as never,
			},
			releases: {
				builder: {} as unknown as ReleaseBuilder,
				store: {} as unknown as ReleaseStore,
				ledger: releaseLedger,
				migrations: new ScriptedReleaseMigrationSourceAdapter([]),
				service: new ScriptedReleaseServiceAdapter(null),
			},
			startSocket() {
				socketStarts += 1;
				return {
					socketPath: paths.socketPath,
					async stop() {},
				};
			},
		});

		try {
			await composed.start();

			expect(recoveryScans).toBe(1);
			expect(socketStarts).toBe(1);
			expect(delayCalls).toBe(3);
			expect(observeOptions).toHaveLength(8);
			expect(observeOptions.every((options) => options.allowMutations === false)).toBe(true);
			expect(workers.starts).toEqual([]);
			expect(workers.activations).toEqual([]);
			expect(workers.stops).toEqual([]);
			expect(labelCalls).toBe(0);
			expect(controllerNotifications.sent).toEqual([]);
			expect(operationalNotifications.sent).toEqual([]);
			expect(status).toMatchObject({
				mode: "observation",
				rolloutStage: "observation",
				executions: [],
			});
			expect(doctorReport).toMatchObject({ ok: true, live: false });
			expect(doctorReport?.checks).toHaveLength(15);
			expect(doctorSystem.liveCalls).toEqual([]);
			expect(ledgerRevision).toBe(0);
		} finally {
			await composed.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
