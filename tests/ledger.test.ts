import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControllerLocalState, ExecutionRecord } from "../src/controller/model";
import {
	applyLedgerMigrations,
	CURRENT_LEDGER_SCHEMA_VERSION,
	LEDGER_FILENAME,
	LEDGER_MIGRATIONS,
	LedgerCorruptionError,
	type LedgerIdSource,
	type LedgerMigration,
	LedgerMigrationError,
	LedgerOwnershipError,
	LedgerRevisionConflictError,
	openSqliteLedger,
	restoreSqliteLedger,
	type SqliteLedger,
} from "../src/ledger";
import { createInitialControllerState, FixedClockAdapter } from "../src/testing";

const headSha = "1234567890abcdef1234567890abcdef12345678";
const releaseSha = "abcdef1234567890abcdef1234567890abcdef12";

class SequenceIds implements LedgerIdSource {
	#sequence = 0;

	public nextId(
		kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session",
	): string {
		this.#sequence += 1;
		return `${kind}-${this.#sequence}`;
	}
}

function activeExecution(): ExecutionRecord {
	return {
		executionId: "execution-1",
		projectId: "project-one",
		lane: "implementation",
		provider: "claude",
		workflow: "project-workflow",
		claimState: "verified",
		issueNumber: 42,
		pullRequestNumber: null,
		branch: "factory/issue-42",
		worktreeId: "worktree-42",
		headSha,
		status: "active",
	};
}

function initialState(withExecution = false): ControllerLocalState {
	const state = createInitialControllerState([]);
	state.projectEnabled["project-one"] = true;
	if (withExecution) {
		state.executions.push(activeExecution());
	}
	return state;
}

function open(
	stateDirectory: string,
	instanceId: string,
	state = initialState(),
	clock = new FixedClockAdapter(),
	ids = new SequenceIds(),
): SqliteLedger {
	return openSqliteLedger({
		stateDirectory,
		instanceId,
		clock,
		ids,
		initialState: state,
	});
}

async function inTemporaryDirectory(
	run: (directory: string) => void | Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-factory-ledger-"));
	try {
		await run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("ledger migrations and SQLite configuration", () => {
	test("migrates an empty state directory, enables WAL, and reopens idempotently", async () => {
		await inTemporaryDirectory(async (directory) => {
			const clock = new FixedClockAdapter();
			const first = open(directory, "controller-a", initialState(), clock);

			expect(first.databasePath).toBe(join(directory, LEDGER_FILENAME));
			expect(statSync(first.databasePath).mode & 0o777).toBe(0o600);
			expect(first.schemaVersion).toBe(CURRENT_LEDGER_SCHEMA_VERSION);
			expect(first.pragmas).toEqual({
				journalMode: "wal",
				synchronous: 1,
				foreignKeys: 1,
			});
			expect((await first.read()).revision).toBe(0);
			first.close();

			clock.advance(1_000);
			const second = open(directory, "controller-b", initialState(true), clock);
			expect(second.schemaVersion).toBe(CURRENT_LEDGER_SCHEMA_VERSION);
			expect((await second.read()).state.executions).toEqual([]);
			second.close();

			const database = new Database(join(directory, LEDGER_FILENAME), {
				readonly: true,
				strict: true,
			});
			try {
				const versions = database
					.query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
					.all()
					.map((row) => row.version);
				expect(versions).toEqual([1, 2, 3, 4]);
			} finally {
				database.close();
			}
		});
	});

	test("applies additive migrations in order and rolls a failed migration back", () => {
		const clock = new FixedClockAdapter();
		const ordered = new Database(":memory:", { strict: true });
		const migrations: readonly LedgerMigration[] = [
			{
				version: 1,
				name: "create-example",
				statements: ["CREATE TABLE example (id INTEGER PRIMARY KEY) STRICT"],
			},
			{
				version: 2,
				name: "extend-example",
				statements: ["ALTER TABLE example ADD COLUMN value TEXT"],
			},
			{
				version: 3,
				name: "create-related",
				statements: [
					"CREATE TABLE related (id INTEGER PRIMARY KEY, example_id INTEGER REFERENCES example(id)) STRICT",
				],
			},
		];
		try {
			expect(applyLedgerMigrations(ordered, clock, migrations)).toBe(3);
			expect(
				ordered
					.query<{ name: string }, []>("SELECT name FROM schema_migrations ORDER BY version")
					.all()
					.map((row) => row.name),
			).toEqual(["create-example", "extend-example", "create-related"]);
		} finally {
			ordered.close();
		}

		const faulty = new Database(":memory:", { strict: true });
		const faultyMigrations: readonly LedgerMigration[] = [
			{
				version: 1,
				name: "stable-base",
				statements: ["CREATE TABLE stable (id INTEGER PRIMARY KEY) STRICT"],
			},
			{
				version: 2,
				name: "faulty-addition",
				statements: [
					"CREATE TABLE must_rollback (id INTEGER PRIMARY KEY) STRICT",
					"THIS IS NOT SQL",
				],
			},
		];
		try {
			expect(() => applyLedgerMigrations(faulty, clock, faultyMigrations)).toThrow();
			expect(
				faulty
					.query<{ version: number }, []>("SELECT version FROM schema_migrations")
					.all()
					.map((row) => row.version),
			).toEqual([1]);
			expect(
				faulty
					.query<{ present: number }, []>(
						"SELECT COUNT(*) AS present FROM sqlite_master WHERE name = 'must_rollback'",
					)
					.get()?.present,
			).toBe(0);
		} finally {
			faulty.close();
		}
	});

	test("rejects downgrade and unknown migration histories", () => {
		const clock = new FixedClockAdapter();
		const downgrade = new Database(":memory:", { strict: true });
		try {
			applyLedgerMigrations(downgrade, clock);
			expect(() => applyLedgerMigrations(downgrade, clock, LEDGER_MIGRATIONS.slice(0, 2))).toThrow(
				LedgerMigrationError,
			);
			expect(() => applyLedgerMigrations(downgrade, clock, LEDGER_MIGRATIONS.slice(0, 2))).toThrow(
				"downgrade is forbidden",
			);
		} finally {
			downgrade.close();
		}

		const unknown = new Database(":memory:", { strict: true });
		try {
			unknown.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (1, 'unknown-history', '2026-07-23T00:00:00.000Z');
      `);
			expect(() => applyLedgerMigrations(unknown, clock)).toThrow("is unknown");
		} finally {
			unknown.close();
		}
	});
});

describe("controller snapshot and one-writer ownership", () => {
	test("rejects stale revisions without changing durable state", async () => {
		await inTemporaryDirectory(async (directory) => {
			const ledger = open(directory, "controller-a");
			const original = await ledger.read();
			const active = structuredClone(original.state);
			active.mode = "active";
			const committed = await ledger.commit(original.revision, active);
			expect(committed.revision).toBe(1);

			const stale = structuredClone(original.state);
			stale.projectEnabled["unexpected-project"] = true;
			await expect(ledger.commit(original.revision, stale)).rejects.toBeInstanceOf(
				LedgerRevisionConflictError,
			);
			expect(await ledger.read()).toEqual(committed);
			ledger.close();
		});
	});

	test("allows only one live controller owner and releases ownership on close", async () => {
		await inTemporaryDirectory(async (directory) => {
			const first = open(directory, "controller-a");
			expect(() => open(directory, "controller-b")).toThrow(LedgerOwnershipError);
			expect(first.owner().instanceId).toBe("controller-a");

			const snapshot = await first.read();
			await expect(first.commit(snapshot.revision, snapshot.state)).resolves.toMatchObject({
				revision: 1,
			});
			first.close();

			const replacement = open(directory, "controller-b");
			expect(replacement.owner().instanceId).toBe("controller-b");
			replacement.close();
		});
	});

	test("permits recovery takeover only after an injected owner lease expires", async () => {
		await inTemporaryDirectory(async (directory) => {
			const clock = new FixedClockAdapter();
			const options = {
				stateDirectory: directory,
				clock,
				ids: new SequenceIds(),
				initialState: initialState(),
				ownerLeaseDurationMs: 1_000,
			};
			const first = openSqliteLedger({ ...options, instanceId: "controller-a" });
			expect(() => openSqliteLedger({ ...options, instanceId: "controller-b" })).toThrow(
				LedgerOwnershipError,
			);

			clock.advance(1_001);
			const recovered = openSqliteLedger({ ...options, instanceId: "controller-b" });
			expect(recovered.owner()).toMatchObject({
				instanceId: "controller-b",
				acquiredAt: "2026-07-23T00:00:01.001Z",
				expiresAt: "2026-07-23T00:00:02.001Z",
			});
			await expect(first.read()).rejects.toThrow(LedgerOwnershipError);
			expect(() => first.close()).toThrow(LedgerOwnershipError);
			recovered.close();
		});
	});
});

describe("audit, mutation reconciliation, and recovery", () => {
	test("sanitizes audit payloads and enforces append-only rows with SQL triggers", async () => {
		await inTemporaryDirectory((directory) => {
			const ledger = open(directory, "controller-a");
			const appended = ledger.appendAudit("recovery-recorded", {
				executionId: "execution-1",
				token: "should-not-survive",
				detail: "/private/server/path",
			});
			expect(appended.payload).toEqual({
				detail: "[REDACTED_PATH]",
				executionId: "execution-1",
				token: "[REDACTED]",
			});

			const direct = new Database(ledger.databasePath, {
				readwrite: true,
				strict: true,
			});
			try {
				expect(() =>
					direct.run("UPDATE audit_events SET kind = 'changed' WHERE sequence = ?", [
						appended.sequence,
					]),
				).toThrow("append-only");
				expect(() =>
					direct.run("DELETE FROM audit_events WHERE sequence = ?", [appended.sequence]),
				).toThrow("append-only");
			} finally {
				direct.close();
			}
			expect(ledger.listAudit().find((event) => event.sequence === appended.sequence)).toEqual(
				appended,
			);
			ledger.close();
		});
	});

	test("enforces reconcile-before-retry mutation transitions and idempotency", async () => {
		await inTemporaryDirectory((directory) => {
			const ledger = open(directory, "controller-a");
			const input = {
				projectId: "project-one",
				executionId: null,
				kind: "set-stage",
				subjectType: "issue" as const,
				subjectNumber: 42,
				intendedMutation: { add: ["in-progress"], remove: ["eligible"] },
				idempotencyKey: "project-one:issue:42:set-stage:claim",
			};
			const pending = ledger.recordMutation(input);
			expect(pending.state).toBe("pending");
			expect(ledger.recordMutation(input)).toEqual(pending);
			expect(() =>
				ledger.recordMutation({ ...input, intendedMutation: { add: ["different"] } }),
			).toThrow("different mutation");

			const ambiguous = ledger.transitionMutation(pending.mutationId, "ambiguous", {
				errorClass: "transport",
			});
			expect(ambiguous.state).toBe("ambiguous");
			const reconciled = ledger.transitionMutation(pending.mutationId, "reconciled", {
				observed: true,
			});
			expect(reconciled.state).toBe("reconciled");
			expect(() => ledger.transitionMutation(pending.mutationId, "pending")).toThrow(
				"invalid mutation transition",
			);
			expect(ledger.listMutations(["reconciled"])).toEqual([reconciled]);
			ledger.close();
		});
	});

	test("reads executions, attempts, sessions, and process identity after restart", async () => {
		await inTemporaryDirectory(async (directory) => {
			const clock = new FixedClockAdapter();
			const first = open(directory, "controller-a", initialState(true), clock);
			const attempt = first.startAttempt("execution-1");
			const session = first.registerProviderSession({
				executionId: "execution-1",
				attemptNumber: attempt.attemptNumber,
				provider: "claude",
				providerSessionId: "claude-session-1",
				model: "claude-fable-5",
				reasoningEffort: "high",
				runtimeMetadata: { resumeMode: "exact", fallback: false },
			});
			first.saveProcessMetadata({
				executionId: "execution-1",
				attemptNumber: attempt.attemptNumber,
				paneId: "pane-1",
				processId: 4242,
				processStartedAt: "2026-07-23T00:00:00.000Z",
				hostIdentity: "factory-host",
				runtimeMetadata: { processGroup: 4242 },
			});
			clock.advance(5_000);
			first.updateAttempt({
				executionId: "execution-1",
				attemptNumber: attempt.attemptNumber,
				status: "blocked",
				checkpoint: "verification",
				outcome: "handoff",
				reasonCode: "provider-limit",
			});
			first.close();

			const restarted = open(directory, "controller-b", initialState(), clock);
			const recovery = restarted.readExecutionRecovery("execution-1");
			expect(recovery.execution).toEqual(activeExecution());
			expect(recovery.attempts).toEqual([
				{
					...attempt,
					status: "blocked",
					finishedAt: "2026-07-23T00:00:05.000Z",
					checkpoint: "verification",
					outcome: "handoff",
					reasonCode: "provider-limit",
				},
			]);
			expect(recovery.sessions).toEqual([session]);
			expect(recovery.process).toMatchObject({
				executionId: "execution-1",
				paneId: "pane-1",
				processId: 4242,
				runtimeMetadata: { processGroup: 4242 },
			});
			restarted.close();
		});
	});
});

describe("backup, restore, and repository state", () => {
	test("restores a consistent serialized WAL snapshot with all repository state", async () => {
		await inTemporaryDirectory(async (root) => {
			const sourceDirectory = join(root, "source");
			const restoreDirectory = join(root, "restore");
			const backupDirectory = join(root, "backups");
			mkdirSync(sourceDirectory);
			mkdirSync(restoreDirectory);
			mkdirSync(backupDirectory);

			const clock = new FixedClockAdapter();
			const ids = new SequenceIds();
			const source = open(sourceDirectory, "controller-a", initialState(true), clock, ids);
			const snapshot = await source.read();
			const committedState = structuredClone(snapshot.state);
			committedState.mode = "active";
			committedState.circuits.codex = {
				status: "open",
				reasonCode: "account-limit",
			};
			await source.commit(snapshot.revision, committedState);
			const attempt = source.startAttempt("execution-1");
			source.registerProviderSession({
				executionId: "execution-1",
				attemptNumber: attempt.attemptNumber,
				provider: "claude",
				providerSessionId: "session-backup",
				model: "claude-fable-5",
				reasoningEffort: "high",
				runtimeMetadata: { resume: true },
			});
			source.saveReviewBaseline({
				projectId: "project-one",
				pullRequestNumber: 84,
				headSha,
				reviewObservation: { codex: "complete" },
				checkObservation: { build: "success" },
				quiescentPollCount: 2,
			});
			source.createMaintenanceRequest({
				kind: "drain",
				status: "active",
				reasonCode: "operator-request",
			});
			source.saveRelease({
				releaseId: releaseSha,
				commitSha: releaseSha,
				status: "installed",
				artifactPath: releaseSha,
				requiredSchemaVersion: CURRENT_LEDGER_SCHEMA_VERSION,
				metadata: { health: "verified" },
			});
			const backupPath = join(backupDirectory, "ledger-backup.sqlite3");
			source.backup(backupPath);
			expect(existsSync(backupPath)).toBe(true);
			expect(statSync(backupPath).mode & 0o777).toBe(0o600);
			expect(readdirSync(backupDirectory)).toEqual(["ledger-backup.sqlite3"]);
			source.close();

			clock.advance(10_000);
			const restored = restoreSqliteLedger({
				stateDirectory: restoreDirectory,
				backupPath,
				instanceId: "controller-restored",
				clock,
				ids,
				initialState: initialState(),
			});
			expect(await restored.read()).toMatchObject({
				revision: 1,
				state: {
					mode: "active",
					circuits: {
						codex: { status: "open", reasonCode: "account-limit" },
					},
				},
			});
			expect(restored.readExecutionRecovery("execution-1").sessions).toHaveLength(1);
			expect(restored.getReviewBaseline("project-one", 84)).toMatchObject({
				headSha,
				quiescentPollCount: 2,
			});
			expect(restored.listProviderCircuits()).toContainEqual({
				provider: "codex",
				status: "open",
				reasonCode: "account-limit",
				openedAt: "2026-07-23T00:00:00.000Z",
				updatedAt: "2026-07-23T00:00:00.000Z",
			});
			expect(restored.listMaintenanceRequests()).toHaveLength(1);
			expect(restored.listReleases()).toHaveLength(1);
			expect(restored.listAudit().some((event) => event.kind === "ledger-backup-created")).toBe(
				true,
			);
			restored.close();
		});
	});
});

describe("ledger faults", () => {
	test("rejects corrupt databases and missing state directories", async () => {
		await inTemporaryDirectory((directory) => {
			writeFileSync(join(directory, LEDGER_FILENAME), "not a sqlite database");
			expect(() => open(directory, "controller-a")).toThrow(LedgerCorruptionError);
		});

		await inTemporaryDirectory((directory) => {
			const missing = join(directory, "missing");
			expect(() => open(missing, "controller-a")).toThrow("is unavailable");
			expect(existsSync(missing)).toBe(false);
		});
	});

	test("rejects corrupt backups and restore targets that already contain a ledger", async () => {
		await inTemporaryDirectory((root) => {
			const sourceDirectory = join(root, "source");
			const targetDirectory = join(root, "target");
			const corruptTarget = join(root, "corrupt-target");
			mkdirSync(sourceDirectory);
			mkdirSync(targetDirectory);
			mkdirSync(corruptTarget);
			const source = open(sourceDirectory, "controller-a");
			const backupPath = join(root, "backup.sqlite3");
			source.backup(backupPath);
			source.close();

			const occupied = open(targetDirectory, "controller-b");
			occupied.close();
			expect(() =>
				restoreSqliteLedger({
					stateDirectory: targetDirectory,
					backupPath,
					instanceId: "controller-c",
					clock: new FixedClockAdapter(),
					ids: new SequenceIds(),
					initialState: initialState(),
				}),
			).toThrow("already contains ledger files");

			const corruptBackup = join(root, "corrupt.sqlite3");
			writeFileSync(corruptBackup, "not a backup");
			expect(() =>
				restoreSqliteLedger({
					stateDirectory: corruptTarget,
					backupPath: corruptBackup,
					instanceId: "controller-d",
					clock: new FixedClockAdapter(),
					ids: new SequenceIds(),
					initialState: initialState(),
				}),
			).toThrow(LedgerCorruptionError);
		});
	});
});
