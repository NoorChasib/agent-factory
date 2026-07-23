import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseIdSource } from "../src/adapters/release-interfaces";
import {
	LocalFactoryReleaseBuildAdapter,
	LocalReleaseFileSystemAdapter,
	SqliteReleaseLedgerAdapter,
} from "../src/adapters/releases";
import { parseReleaseBuildMetadata } from "../src/contracts/release-manifest";
import {
	CURRENT_LEDGER_SCHEMA_VERSION,
	LEDGER_MIGRATIONS,
	type LedgerIdSource,
	openSqliteLedger,
	type SqliteLedger,
} from "../src/ledger";
import {
	RELEASE_UPDATE_CAPABILITIES,
	ReleaseBootstrapper,
	ReleaseBuilder,
	ReleaseHealthChecker,
	ReleaseStore,
	ReleaseUpdater,
	releaseInventoryHash,
	validateReleaseManifest,
} from "../src/releases";
import {
	createInitialControllerState,
	FixedClockAdapter,
	InMemoryReleaseAlertAdapter,
	InMemoryReleaseLedgerAdapter,
	ScriptedFactoryReleaseBuildAdapter,
	ScriptedLocalReleaseCommandAdapter,
	ScriptedReleaseMaintenanceAdapter,
	ScriptedReleaseMigrationSourceAdapter,
	ScriptedReleaseReconciliationAdapter,
	ScriptedReleaseServiceAdapter,
	SequenceReleaseIdSource,
} from "../src/testing";

const oldSha = "1".repeat(40);
const candidateSha = "2".repeat(40);
const otherSha = "3".repeat(40);

const activePolicy = {
	mode: "active" as const,
	rolloutStage: "stage3" as const,
	limits: { implementation: 3, feedback: 2, readyToMerge: 1 },
};

async function inTemporaryDirectory(
	run: (directory: string) => void | Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-factory-release-"));
	try {
		await run(directory);
	} finally {
		const makeWritable = (path: string): void => {
			const metadata = lstatSync(path);
			if (metadata.isSymbolicLink()) {
				return;
			}
			if (metadata.isDirectory()) {
				chmodSync(path, 0o700);
				for (const entry of readdirSync(path)) {
					makeWritable(join(path, entry));
				}
			} else {
				chmodSync(path, 0o600);
			}
		};
		makeWritable(directory);
		rmSync(directory, { recursive: true, force: true });
	}
}

interface Harness {
	readonly store: ReleaseStore;
	readonly builder: ReleaseBuilder;
	readonly builds: ScriptedFactoryReleaseBuildAdapter;
	readonly ledger: InMemoryReleaseLedgerAdapter;
	readonly maintenance: ScriptedReleaseMaintenanceAdapter;
	readonly service: ScriptedReleaseServiceAdapter;
	readonly reconciliation: ScriptedReleaseReconciliationAdapter;
	readonly alerts: InMemoryReleaseAlertAdapter;
	readonly updater: ReleaseUpdater;
}

async function createHarness(
	directory: string,
	input: {
		readonly currentSchema?: number;
		readonly candidateSchema?: number;
		readonly fileSystem?: LocalReleaseFileSystemAdapter;
	} = {},
): Promise<Harness> {
	const currentSchema = input.currentSchema ?? 4;
	const candidateSchema = input.candidateSchema ?? currentSchema;
	const store = new ReleaseStore({
		root: join(directory, "releases"),
		fileSystem: input.fileSystem ?? new LocalReleaseFileSystemAdapter(),
		clock: new FixedClockAdapter(),
		ids: new SequenceReleaseIdSource(),
	});
	await store.prepare();
	const builds = new ScriptedFactoryReleaseBuildAdapter({
		requiredLedgerSchemaVersion: currentSchema,
	});
	const builder = new ReleaseBuilder({ builds, store });
	const oldManifest = await builder.build(oldSha);
	await store.activate(oldSha);
	const ledger = new InMemoryReleaseLedgerAdapter(currentSchema, [
		{
			releaseId: oldSha,
			commitSha: oldSha,
			status: "installed",
			artifactPath: oldSha,
			requiredSchemaVersion: oldManifest.requiredLedgerSchemaVersion,
			metadata: { bootstrap: true },
		},
	]);
	builds.requiredLedgerSchemaVersion = candidateSchema;
	const maintenance = new ScriptedReleaseMaintenanceAdapter(activePolicy);
	const service = new ScriptedReleaseServiceAdapter(oldSha);
	const reconciliation = new ScriptedReleaseReconciliationAdapter(() => maintenance.policy);
	const alerts = new InMemoryReleaseAlertAdapter();
	const health = new ReleaseHealthChecker({
		store,
		ledger,
		service,
		reconciliation,
	});
	const updater = new ReleaseUpdater({
		builder,
		store,
		ledger,
		maintenance,
		migrations: new ScriptedReleaseMigrationSourceAdapter(
			LEDGER_MIGRATIONS.slice(0, candidateSchema),
		),
		service,
		health,
		alerts,
	});
	return {
		store,
		builder,
		builds,
		ledger,
		maintenance,
		service,
		reconciliation,
		alerts,
		updater,
	};
}

describe("release manifest and immutable store", () => {
	test("keeps checked-in release metadata aligned with the ledger migration set", () => {
		const metadata = parseReleaseBuildMetadata(
			JSON.parse(readFileSync(join(import.meta.dir, "..", "release.json"), "utf8")) as unknown,
		);
		const packageMetadata = JSON.parse(
			readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
		) as { readonly version?: unknown };
		expect(packageMetadata.version).toBe(metadata.version);
		expect(metadata.requiredLedgerSchemaVersion).toBe(CURRENT_LEDGER_SCHEMA_VERSION);
		expect(LEDGER_MIGRATIONS).toHaveLength(CURRENT_LEDGER_SCHEMA_VERSION);
	});

	test("builds only the addressed factory checkout with frozen install and full validation", async () => {
		await inTemporaryDirectory(async (directory) => {
			const repositoryRoot = join(directory, "factory-repository");
			const checkoutRoot = join(directory, "factory-release-builds");
			const stagingPath = join(directory, "candidate-staging");
			const commands = new ScriptedLocalReleaseCommandAdapter(4);
			await new LocalFactoryReleaseBuildAdapter({
				commands,
				repositoryRoot,
				checkoutRoot,
				environment: { PATH: "/scripted/bin" },
			}).build({
				commitSha: candidateSha,
				buildId: "scripted-build",
				stagingPath,
			});

			expect(commands.requests.map((request) => [request.executable, ...request.argv])).toEqual([
				["git", "-C", repositoryRoot, "rev-parse", "--verify", `${candidateSha}^{commit}`],
				[
					"git",
					"-C",
					repositoryRoot,
					"worktree",
					"add",
					"--detach",
					"--",
					join(checkoutRoot, `${candidateSha}-scripted-build`),
					candidateSha,
				],
				["bun", "install", "--frozen-lockfile"],
				["bun", "run", "validate"],
				[
					"git",
					"-C",
					join(checkoutRoot, `${candidateSha}-scripted-build`),
					"status",
					"--porcelain",
					"--untracked-files=no",
				],
				[
					"git",
					"-C",
					repositoryRoot,
					"worktree",
					"remove",
					"--force",
					"--",
					join(checkoutRoot, `${candidateSha}-scripted-build`),
				],
			]);
			expect(commands.requests.map((request) => request.executable)).not.toContain("gh");
			expect(commands.requests.map((request) => request.executable)).not.toContain("herdr");
			expect(commands.requests.map((request) => request.executable)).not.toContain("claude");
			expect(commands.requests.map((request) => request.executable)).not.toContain("codex");
			expect(existsSync(join(stagingPath, "src", "index.ts"))).toBe(true);
			expect(existsSync(join(stagingPath, ".git"))).toBe(false);
		});
	});

	test("generates and verifies a sorted hash inventory with a schema requirement", async () => {
		await inTemporaryDirectory(async (directory) => {
			const harness = await createHarness(directory);
			const manifest = await harness.builder.build(candidateSha);
			expect(manifest.commitSha).toBe(candidateSha);
			expect(manifest.requiredLedgerSchemaVersion).toBe(4);
			expect(manifest.inventory.map((entry) => entry.path)).toEqual(
				[...manifest.inventory.map((entry) => entry.path)].sort(),
			);
			expect(manifest.inventory.some((entry) => entry.path === "release.json")).toBe(true);
			expect(manifest.inventoryHash).toBe(releaseInventoryHash(manifest.inventory));
			expect(await harness.store.validate(candidateSha)).toEqual(manifest);

			const changed = manifest.inventory.map((entry, index) =>
				index === 0 ? { ...entry, sha256: "f".repeat(64) } : entry,
			);
			expect(() => validateReleaseManifest(manifest, changed, candidateSha)).toThrow(
				"inventory does not match",
			);
		});
	});

	test("keeps the old pointer intact when the write-new-then-rename swap fails", async () => {
		await inTemporaryDirectory(async (directory) => {
			let failCurrentRename = false;
			const fileSystem = new LocalReleaseFileSystemAdapter({
				beforeRename(_source, destination) {
					if (failCurrentRename && destination.endsWith("/current")) {
						throw new Error("scripted rename failure");
					}
				},
			});
			const harness = await createHarness(directory, { fileSystem });
			await harness.builder.build(candidateSha);
			failCurrentRename = true;

			await expect(harness.store.activate(candidateSha)).rejects.toThrow("scripted rename failure");
			expect(await harness.store.currentReleaseId()).toBe(oldSha);
			expect(readdirSync(harness.store.root).some((name) => name.startsWith(".current-"))).toBe(
				false,
			);
		});
	});
});

describe("initial immutable release bootstrap", () => {
	test("builds, activates, records, and idempotently verifies the first observation-mode release", async () => {
		await inTemporaryDirectory(async (directory) => {
			const store = new ReleaseStore({
				root: join(directory, "releases"),
				fileSystem: new LocalReleaseFileSystemAdapter(),
				clock: new FixedClockAdapter(),
				ids: new SequenceReleaseIdSource(),
			});
			await store.prepare();
			const builds = new ScriptedFactoryReleaseBuildAdapter({
				requiredLedgerSchemaVersion: CURRENT_LEDGER_SCHEMA_VERSION,
			});
			const ledger = new InMemoryReleaseLedgerAdapter(CURRENT_LEDGER_SCHEMA_VERSION);
			const bootstrap = new ReleaseBootstrapper({
				builder: new ReleaseBuilder({ builds, store }),
				store,
				ledger,
			});

			expect(await bootstrap.bootstrap(oldSha)).toMatchObject({
				releaseId: oldSha,
				currentReleaseId: oldSha,
				alreadyInstalled: false,
			});
			expect(await store.currentReleaseId()).toBe(oldSha);
			expect(ledger.listReleases()).toMatchObject([
				{
					releaseId: oldSha,
					status: "installed",
					metadata: {
						schemaVersion: 1,
						update: { phase: "installed", priorPolicy: null },
					},
				},
			]);

			expect(await bootstrap.bootstrap(oldSha)).toMatchObject({
				releaseId: oldSha,
				currentReleaseId: oldSha,
				alreadyInstalled: true,
			});
			expect(builds.builds).toHaveLength(1);
			await expect(bootstrap.bootstrap(candidateSha)).rejects.toThrow(
				"cannot replace an installed release",
			);
			expect(await store.currentReleaseId()).toBe(oldSha);

			const nonInstalledLedger = new InMemoryReleaseLedgerAdapter(CURRENT_LEDGER_SCHEMA_VERSION, [
				{
					releaseId: candidateSha,
					commitSha: candidateSha,
					status: "failed",
					artifactPath: null,
					requiredSchemaVersion: CURRENT_LEDGER_SCHEMA_VERSION,
					metadata: { reason: "fixture" },
				},
			]);
			await expect(
				new ReleaseBootstrapper({
					builder: new ReleaseBuilder({ builds, store }),
					store,
					ledger: nonInstalledLedger,
				}).bootstrap(candidateSha),
			).rejects.toThrow("empty or matching installed release ledger");
		});
	});
});

describe("queued update state machine", () => {
	test("marks a validation failure failed and never makes it queue-eligible", async () => {
		await inTemporaryDirectory(async (directory) => {
			const harness = await createHarness(directory);
			harness.builds.failure = new Error("scripted validation failure");

			await expect(harness.updater.queue(candidateSha)).rejects.toThrow("failed build validation");
			expect(harness.ledger.listReleases()).toContainEqual(
				expect.objectContaining({ releaseId: candidateSha, status: "failed" }),
			);
			expect(harness.ledger.listReleases().some((release) => release.status === "queued")).toBe(
				false,
			);
			await expect(harness.updater.queue(candidateSha)).rejects.toThrow(
				"cannot be queued from state 'failed'",
			);
			expect(await harness.store.currentReleaseId()).toBe(oldSha);
		});
	});

	test("waits for active work, then backs up, switches, restarts, checks health, and installs", async () => {
		await inTemporaryDirectory(async (directory) => {
			const harness = await createHarness(directory);
			harness.maintenance.activeWork = 1;
			await harness.updater.queue(candidateSha);

			expect(harness.maintenance.policy.mode).toBe("observation");
			expect(await harness.updater.applyWhenIdle()).toEqual({
				state: "waiting-for-drain",
				releaseId: candidateSha,
			});
			expect(await harness.store.currentReleaseId()).toBe(oldSha);
			expect(harness.ledger.events.some((event) => event.startsWith("backup:"))).toBe(false);

			harness.maintenance.activeWork = 0;
			expect(await harness.updater.applyWhenIdle()).toEqual({
				state: "restart-requested",
				releaseId: candidateSha,
			});
			expect(await harness.store.currentReleaseId()).toBe(candidateSha);
			expect(harness.service.restartRequests).toBe(1);

			harness.service.running = candidateSha;
			expect(await harness.updater.applyWhenIdle()).toEqual({
				state: "installed",
				releaseId: candidateSha,
			});
			expect(harness.ledger.listReleases()).toContainEqual(
				expect.objectContaining({ releaseId: candidateSha, status: "installed" }),
			);
			expect(harness.ledger.listReleases()).toContainEqual(
				expect.objectContaining({ releaseId: oldSha, status: "candidate" }),
			);
			expect(harness.maintenance.policy).toEqual(activePolicy);
			expect(harness.reconciliation.reconciliations).toBe(1);
			expect(harness.alerts.alerts).toEqual([]);
		});
	});

	test("refuses a schema downgrade before backup, migration, or pointer switch", async () => {
		await inTemporaryDirectory(async (directory) => {
			const harness = await createHarness(directory, {
				currentSchema: 4,
				candidateSchema: 3,
			});
			await harness.updater.queue(candidateSha);

			expect(await harness.updater.applyWhenIdle()).toEqual({
				state: "failed",
				releaseId: candidateSha,
				reason: "ledger-schema-downgrade-forbidden",
			});
			expect(await harness.store.currentReleaseId()).toBe(oldSha);
			expect(harness.ledger.events.some((event) => event.startsWith("backup:"))).toBe(false);
			expect(harness.ledger.events.some((event) => event.startsWith("migrate:"))).toBe(false);
			expect(harness.maintenance.policy).toEqual(activePolicy);
		});
	});

	test("rolls back pointer, ledger, policy, and service after failed post-switch health", async () => {
		await inTemporaryDirectory(async (directory) => {
			const harness = await createHarness(directory, {
				currentSchema: 3,
				candidateSchema: 4,
			});
			await harness.updater.queue(candidateSha);
			expect((await harness.updater.applyWhenIdle()).state).toBe("restart-requested");
			expect(harness.ledger.schemaVersion).toBe(4);
			harness.service.running = candidateSha;
			harness.service.probeOk = false;

			expect(await harness.updater.applyWhenIdle()).toEqual({
				state: "rolled-back",
				releaseId: candidateSha,
				reason: "post-switch-health-failed",
			});
			expect(await harness.store.currentReleaseId()).toBe(oldSha);
			expect(harness.ledger.schemaVersion).toBe(3);
			expect(harness.ledger.listReleases()).toContainEqual(
				expect.objectContaining({ releaseId: oldSha, status: "installed" }),
			);
			expect(harness.ledger.listReleases()).toContainEqual(
				expect.objectContaining({ releaseId: candidateSha, status: "rolled-back" }),
			);
			expect(harness.alerts.alerts).toEqual([
				{
					kind: "update-rollback",
					detail: {
						releaseId: candidateSha,
						previousReleaseId: oldSha,
						reason: "post-switch-health-failed",
					},
				},
			]);
			expect(harness.service.restartRequests).toBe(2);
			expect(harness.maintenance.policy).toEqual(activePolicy);
			const backupIndex = harness.ledger.events.findIndex((event) => event.startsWith("backup:"));
			const migrationIndex = harness.ledger.events.findIndex((event) =>
				event.startsWith("migrate:"),
			);
			const restoreIndex = harness.ledger.events.findIndex((event) => event.startsWith("restore:"));
			expect(backupIndex).toBeGreaterThan(-1);
			expect(migrationIndex).toBeGreaterThan(backupIndex);
			expect(restoreIndex).toBeGreaterThan(migrationIndex);
		});
	});

	test("exposes only release-specific capabilities and never target or CLI-upgrade custody", () => {
		const capabilities = RELEASE_UPDATE_CAPABILITIES.join("\n");
		expect(capabilities).not.toMatch(
			/\b(?:claude|codex|gh|herdr|mirror|target|worktree|upgrade-cli)\b/u,
		);
		expect(capabilities).toContain("factory-release-build");
		expect(capabilities).toContain("ledger-backup-migrations-restore");
	});
});

class DrillIds implements LedgerIdSource, ReleaseIdSource {
	#sequence = 0;

	public nextId(
		kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session",
	): string {
		this.#sequence += 1;
		return `${kind}-${this.#sequence}`;
	}

	public nextReleaseId(): string {
		this.#sequence += 1;
		return `release-drill-${this.#sequence}`;
	}
}

describe("isolated SQLite update and rollback drill", () => {
	test("backs up schema 3, applies additive schema 4, then restores schema 3 on failed health", async () => {
		await inTemporaryDirectory(async (directory) => {
			const stateDirectory = join(directory, "state");
			const backupDirectory = join(directory, "backups");
			const releaseDirectory = join(directory, "releases");
			const fileSystem = new LocalReleaseFileSystemAdapter();
			await fileSystem.ensureDirectory(stateDirectory, 0o700);
			await fileSystem.ensureDirectory(backupDirectory, 0o700);
			await fileSystem.ensureDirectory(releaseDirectory, 0o700);
			const ids = new DrillIds();
			const clock = new FixedClockAdapter();
			const store = new ReleaseStore({
				root: releaseDirectory,
				fileSystem,
				clock,
				ids,
			});
			const builds = new ScriptedFactoryReleaseBuildAdapter({
				requiredLedgerSchemaVersion: 3,
			});
			const builder = new ReleaseBuilder({ builds, store });
			await builder.build(oldSha);
			await store.activate(oldSha);
			builds.requiredLedgerSchemaVersion = 4;

			const sqlite: SqliteLedger = openSqliteLedger({
				stateDirectory,
				instanceId: "release-drill-controller",
				clock,
				ids,
				initialState: createInitialControllerState([]),
				migrations: LEDGER_MIGRATIONS.slice(0, 3),
			});
			sqlite.saveRelease({
				releaseId: oldSha,
				commitSha: oldSha,
				status: "installed",
				artifactPath: oldSha,
				requiredSchemaVersion: 3,
				metadata: { bootstrap: true },
			});
			const ledger = new SqliteReleaseLedgerAdapter({ ledger: sqlite, backupDirectory });
			const maintenance = new ScriptedReleaseMaintenanceAdapter(activePolicy);
			const service = new ScriptedReleaseServiceAdapter(oldSha);
			const reconciliation = new ScriptedReleaseReconciliationAdapter(() => maintenance.policy);
			const alerts = new InMemoryReleaseAlertAdapter();
			const updater = new ReleaseUpdater({
				builder,
				store,
				ledger,
				maintenance,
				migrations: new ScriptedReleaseMigrationSourceAdapter(LEDGER_MIGRATIONS),
				service,
				health: new ReleaseHealthChecker({ store, ledger, service, reconciliation }),
				alerts,
			});

			await updater.queue(candidateSha);
			expect((await updater.applyWhenIdle()).state).toBe("restart-requested");
			expect(sqlite.schemaVersion).toBe(4);
			expect(existsSync(join(backupDirectory, `${candidateSha}.sqlite3`))).toBe(true);
			service.running = candidateSha;
			service.probeOk = false;

			expect((await updater.applyWhenIdle()).state).toBe("rolled-back");
			expect(sqlite.schemaVersion).toBe(3);
			expect(await store.currentReleaseId()).toBe(oldSha);
			expect(sqlite.listReleases()).toContainEqual(
				expect.objectContaining({ releaseId: candidateSha, status: "rolled-back" }),
			);
			expect(
				readdirSync(stateDirectory).some((name) => name.startsWith("ledger.sqlite3.pre-rollback-")),
			).toBe(true);
			expect(alerts.alerts).toHaveLength(1);
			sqlite.close();
		});
	});

	test("uses distinct commit identities for every immutable release", async () => {
		await inTemporaryDirectory(async (directory) => {
			const harness = await createHarness(directory);
			await harness.builder.build(candidateSha);
			await harness.builder.build(otherSha);
			expect(await harness.store.hasRelease(oldSha)).toBe(true);
			expect(await harness.store.hasRelease(candidateSha)).toBe(true);
			expect(await harness.store.hasRelease(otherSha)).toBe(true);
		});
	});
});
