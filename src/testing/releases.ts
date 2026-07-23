import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CommandAdapter,
  CommandExecutionResult,
  CommandRequest,
} from "../adapters/interfaces";
import type {
  FactoryReleaseBuildAdapter,
  ReleaseAlertAdapter,
  ReleaseIdSource,
  ReleaseLedgerAdapter,
  ReleaseMaintenanceAdapter,
  ReleaseMigrationSourceAdapter,
  ReleaseReconciliationAdapter,
  ReleaseServiceAdapter,
} from "../adapters/release-interfaces";
import {
  type LedgerMigration,
  type NewReleaseRecord,
  NewReleaseRecordSchema,
  type ReleaseRecord,
  ReleaseRecordSchema,
} from "../ledger";
import type { ReleasePolicySnapshot } from "../releases";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class SequenceReleaseIdSource implements ReleaseIdSource {
  #sequence = 0;

  public nextReleaseId(): string {
    this.#sequence += 1;
    return `release-build-${this.#sequence}`;
  }
}

export class ScriptedLocalReleaseCommandAdapter implements CommandAdapter {
  public readonly requests: CommandRequest[] = [];
  public validationExitCode = 0;
  readonly #requiredLedgerSchemaVersion: number;

  public constructor(requiredLedgerSchemaVersion: number) {
    this.#requiredLedgerSchemaVersion = requiredLedgerSchemaVersion;
  }

  public async execute(request: CommandRequest): Promise<CommandExecutionResult> {
    this.requests.push(clone(request));
    if (request.executable === "git" && request.argv.includes("rev-parse")) {
      const addressed = request.argv.at(-1)?.replace(/\^\{commit\}$/u, "") ?? "";
      return this.#success(addressed);
    }
    if (
      request.executable === "git" &&
      request.argv.includes("worktree") &&
      request.argv.includes("add")
    ) {
      const separator = request.argv.indexOf("--");
      const checkout = request.argv[separator + 1];
      if (checkout === undefined) {
        throw new Error("scripted worktree add omitted checkout path");
      }
      mkdirSync(join(checkout, "bin"), { recursive: true });
      mkdirSync(join(checkout, "src"), { recursive: true });
      writeFileSync(join(checkout, ".git"), "gitdir: scripted\n");
      writeFileSync(
        join(checkout, "release.json"),
        JSON.stringify({
          schemaVersion: 1,
          requiredLedgerSchemaVersion: this.#requiredLedgerSchemaVersion,
        }),
      );
      writeFileSync(join(checkout, "bin", "agent-factory-daemon"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      writeFileSync(join(checkout, "src", "index.ts"), "export {};\n");
      return this.#success();
    }
    if (request.executable === "bun" && request.argv[0] === "run") {
      return {
        ...this.#success(),
        exitCode: this.validationExitCode,
      };
    }
    if (request.executable === "git" && request.argv.includes("status")) {
      return this.#success();
    }
    if (
      request.executable === "git" &&
      request.argv.includes("worktree") &&
      request.argv.includes("remove")
    ) {
      const checkout = request.argv.at(-1);
      if (checkout !== undefined) {
        rmSync(checkout, { recursive: true, force: true });
      }
      return this.#success();
    }
    return this.#success();
  }

  #success(stdout = ""): CommandExecutionResult & { readonly status: "exited" } {
    return {
      status: "exited",
      exitCode: 0,
      stdout: stdout === "" ? "" : `${stdout}\n`,
      stderr: "",
      processId: 101,
    };
  }
}

export class ScriptedFactoryReleaseBuildAdapter implements FactoryReleaseBuildAdapter {
  public readonly builds: {
    readonly commitSha: string;
    readonly buildId: string;
    readonly stagingPath: string;
  }[] = [];
  public failure: Error | null = null;
  public requiredLedgerSchemaVersion: number;
  public files: Readonly<Record<string, string>>;

  public constructor(input: {
    readonly requiredLedgerSchemaVersion: number;
    readonly files?: Readonly<Record<string, string>>;
  }) {
    this.requiredLedgerSchemaVersion = input.requiredLedgerSchemaVersion;
    this.files = input.files ?? {
      "bin/agent-factory-daemon": "#!/bin/sh\nexit 0\n",
      "release.json": JSON.stringify({
        schemaVersion: 1,
        requiredLedgerSchemaVersion: input.requiredLedgerSchemaVersion,
      }),
      "src/index.ts": "export const releaseFixture = true;\n",
    };
  }

  public async build(input: {
    readonly commitSha: string;
    readonly buildId: string;
    readonly stagingPath: string;
  }): Promise<{ readonly requiredLedgerSchemaVersion: number }> {
    this.builds.push(clone(input));
    if (this.failure !== null) {
      throw this.failure;
    }
    mkdirSync(input.stagingPath, { recursive: true, mode: 0o700 });
    for (const [relativePath, content] of Object.entries(this.files)) {
      const path = join(input.stagingPath, relativePath);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: relativePath.startsWith("bin/") ? 0o755 : 0o644 });
    }
    return { requiredLedgerSchemaVersion: this.requiredLedgerSchemaVersion };
  }
}

export class InMemoryReleaseLedgerAdapter implements ReleaseLedgerAdapter {
  #schemaVersion: number;
  #sequence = 0;
  readonly #releases = new Map<string, ReleaseRecord>();
  readonly #backups = new Map<
    string,
    { readonly schemaVersion: number; readonly releases: readonly ReleaseRecord[] }
  >();
  public readonly events: string[] = [];

  public constructor(schemaVersion: number, releases: readonly NewReleaseRecord[] = []) {
    this.#schemaVersion = schemaVersion;
    for (const release of releases) {
      this.saveRelease(release);
    }
    this.events.length = 0;
  }

  public get schemaVersion(): number {
    return this.#schemaVersion;
  }

  public listReleases(): readonly ReleaseRecord[] {
    return [...this.#releases.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  public saveRelease(input: NewReleaseRecord): ReleaseRecord {
    const validated = NewReleaseRecordSchema.parse(clone(input));
    if (
      validated.status === "queued" &&
      [...this.#releases.values()].some(
        (release) => release.status === "queued" && release.releaseId !== validated.releaseId,
      )
    ) {
      throw new Error("another release is queued");
    }
    if (
      validated.status === "installed" &&
      [...this.#releases.values()].some(
        (release) => release.status === "installed" && release.releaseId !== validated.releaseId,
      )
    ) {
      throw new Error("another release is installed");
    }
    const current = this.#releases.get(validated.releaseId);
    this.#sequence += 1;
    const at = new Date(Date.UTC(2026, 6, 23, 0, 0, 0, this.#sequence)).toISOString();
    const record = ReleaseRecordSchema.parse({
      ...validated,
      createdAt: current?.createdAt ?? at,
      updatedAt: at,
    });
    this.#releases.set(record.releaseId, record);
    this.events.push(`save:${record.releaseId}:${record.status}`);
    return clone(record);
  }

  public activateRelease(releaseId: string, metadata: unknown): ReleaseRecord {
    const target = this.#releases.get(releaseId);
    if (target === undefined || target.status !== "queued") {
      throw new Error("release is not queued");
    }
    for (const release of this.#releases.values()) {
      if (release.status === "installed") {
        this.#write({ ...release, status: "candidate" });
      }
    }
    const activated = this.#write({ ...target, status: "installed", metadata });
    this.events.push(`activate:${releaseId}`);
    return clone(activated);
  }

  public backupRelease(releaseId: string): void {
    if (!this.#backups.has(releaseId)) {
      this.#backups.set(releaseId, {
        schemaVersion: this.#schemaVersion,
        releases: this.listReleases(),
      });
      this.events.push(`backup:${releaseId}:${this.#schemaVersion}`);
    }
  }

  public applyMigrations(migrations: readonly LedgerMigration[]): number {
    this.#schemaVersion = migrations.length;
    this.events.push(`migrate:${this.#schemaVersion}`);
    return this.#schemaVersion;
  }

  public restoreReleaseBackup(releaseId: string, _migrations: readonly LedgerMigration[]): number {
    const backup = this.#backups.get(releaseId);
    if (backup === undefined) {
      throw new Error("release backup is unavailable");
    }
    this.#schemaVersion = backup.schemaVersion;
    this.#releases.clear();
    for (const release of backup.releases) {
      this.#releases.set(release.releaseId, clone(release));
    }
    this.events.push(`restore:${releaseId}:${this.#schemaVersion}`);
    return this.#schemaVersion;
  }

  #write(input: ReleaseRecord): ReleaseRecord {
    this.#sequence += 1;
    const record = ReleaseRecordSchema.parse({
      ...clone(input),
      updatedAt: new Date(Date.UTC(2026, 6, 23, 0, 0, 0, this.#sequence)).toISOString(),
    });
    this.#releases.set(record.releaseId, record);
    return record;
  }
}

export class ScriptedReleaseMaintenanceAdapter implements ReleaseMaintenanceAdapter {
  public policy: ReleasePolicySnapshot;
  public activeWork = 0;
  public readonly drains: string[] = [];
  public readonly finishes: string[] = [];

  public constructor(policy: ReleasePolicySnapshot) {
    this.policy = clone(policy);
  }

  public async snapshotPolicy(): Promise<ReleasePolicySnapshot> {
    return clone(this.policy);
  }

  public async requestDrain(reasonCode: string): Promise<void> {
    this.drains.push(reasonCode);
    this.policy = { ...this.policy, mode: "observation" };
  }

  public async activeWorkCount(): Promise<number> {
    return this.activeWork;
  }

  public async finish(reasonCode: string, priorPolicy: ReleasePolicySnapshot): Promise<void> {
    this.finishes.push(reasonCode);
    this.policy = clone(priorPolicy);
  }
}

export class ScriptedReleaseServiceAdapter implements ReleaseServiceAdapter {
  public running: string | null;
  public probeOk = true;
  public restartFailure: Error | null = null;
  public restartRequests = 0;

  public constructor(running: string | null) {
    this.running = running;
  }

  public async runningReleaseId(): Promise<string | null> {
    return this.running;
  }

  public async requestRestart(): Promise<void> {
    this.restartRequests += 1;
    if (this.restartFailure !== null) {
      throw this.restartFailure;
    }
  }

  public async probe(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    return {
      ok: this.probeOk,
      detail: this.probeOk ? "scripted service healthy" : "scripted service unhealthy",
    };
  }
}

export class ScriptedReleaseMigrationSourceAdapter implements ReleaseMigrationSourceAdapter {
  public readonly loads: string[] = [];
  public migrations: readonly LedgerMigration[];

  public constructor(migrations: readonly LedgerMigration[]) {
    this.migrations = clone(migrations);
  }

  public async load(releasePath: string): Promise<readonly LedgerMigration[]> {
    this.loads.push(releasePath);
    return clone(this.migrations);
  }
}

export class ScriptedReleaseReconciliationAdapter implements ReleaseReconciliationAdapter {
  readonly #policy: () => ReleasePolicySnapshot;
  public invariantViolations: readonly string[] = [];
  public reconciliations = 0;

  public constructor(policy: () => ReleasePolicySnapshot) {
    this.#policy = policy;
  }

  public async snapshotPolicy(): Promise<ReleasePolicySnapshot> {
    return clone(this.#policy());
  }

  public async reconcile(): Promise<{
    readonly revision: number;
    readonly invariantViolations: readonly string[];
  }> {
    this.reconciliations += 1;
    return {
      revision: this.reconciliations,
      invariantViolations: [...this.invariantViolations],
    };
  }
}

export class InMemoryReleaseAlertAdapter implements ReleaseAlertAdapter {
  public readonly alerts: {
    readonly kind: "update-failed" | "update-rollback";
    readonly detail: {
      readonly releaseId: string;
      readonly previousReleaseId: string | null;
      readonly reason: string;
    };
  }[] = [];

  public async alert(
    kind: "update-failed" | "update-rollback",
    detail: {
      readonly releaseId: string;
      readonly previousReleaseId: string | null;
      readonly reason: string;
    },
  ): Promise<void> {
    this.alerts.push({ kind, detail: clone(detail) });
  }
}
