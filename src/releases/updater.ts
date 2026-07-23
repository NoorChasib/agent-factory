import type {
  ReleaseAlertAdapter,
  ReleaseLedgerAdapter,
  ReleaseMaintenanceAdapter,
  ReleaseMigrationSourceAdapter,
  ReleaseServiceAdapter,
} from "../adapters/release-interfaces";
import { GitCommitShaSchema, type ReleaseManifest } from "../contracts/release-manifest";
import {
  type CandidateReleaseMetadata,
  CandidateReleaseMetadataSchema,
  FailedReleaseMetadataSchema,
} from "../contracts/release-update";
import { type LedgerMigration, type ReleaseRecord, validateLedgerMigrations } from "../ledger";
import type { ReleaseBuilder } from "./builder";
import type { ReleaseHealthChecker } from "./health";
import type { ReleaseStore } from "./store";
import type { ReleasePolicySnapshot, ReleaseUpdatePhase, ReleaseUpdateResult } from "./types";

export const RELEASE_UPDATE_CAPABILITIES = [
  "factory-release-build",
  "immutable-release-store",
  "ledger-backup-migrations-restore",
  "maintenance-drain",
  "post-switch-health-reconciliation",
  "service-restart",
] as const;

const PHASE_ORDER: Readonly<Record<ReleaseUpdatePhase, number>> = {
  candidate: 0,
  queued: 1,
  validated: 2,
  "backup-created": 3,
  migrated: 4,
  "restart-requested": 5,
  installed: 6,
  failed: 6,
  "rolled-back": 6,
};

function updateReason(releaseId: string): string {
  return `self-update-${releaseId.slice(0, 12)}`;
}

function errorReason(error: unknown): string {
  return error instanceof Error && error.message.includes("schema")
    ? "ledger-schema-incompatible"
    : "release-update-failed";
}

export class ReleaseUpdater {
  readonly #builder: ReleaseBuilder;
  readonly #store: ReleaseStore;
  readonly #ledger: ReleaseLedgerAdapter;
  readonly #maintenance: ReleaseMaintenanceAdapter;
  readonly #migrations: ReleaseMigrationSourceAdapter;
  readonly #service: ReleaseServiceAdapter;
  readonly #health: ReleaseHealthChecker;
  readonly #alerts: ReleaseAlertAdapter;

  public constructor(input: {
    readonly builder: ReleaseBuilder;
    readonly store: ReleaseStore;
    readonly ledger: ReleaseLedgerAdapter;
    readonly maintenance: ReleaseMaintenanceAdapter;
    readonly migrations: ReleaseMigrationSourceAdapter;
    readonly service: ReleaseServiceAdapter;
    readonly health: ReleaseHealthChecker;
    readonly alerts: ReleaseAlertAdapter;
  }) {
    this.#builder = input.builder;
    this.#store = input.store;
    this.#ledger = input.ledger;
    this.#maintenance = input.maintenance;
    this.#migrations = input.migrations;
    this.#service = input.service;
    this.#health = input.health;
    this.#alerts = input.alerts;
  }

  public async status(): Promise<{
    readonly currentReleaseId: string | null;
    readonly runningReleaseId: string | null;
    readonly releases: readonly ReleaseRecord[];
  }> {
    return {
      currentReleaseId: await this.#store.currentReleaseId(),
      runningReleaseId: await this.#service.runningReleaseId(),
      releases: this.#ledger.listReleases(),
    };
  }

  public async queue(commitShaInput: string): Promise<ReleaseRecord> {
    const commitSha = GitCommitShaSchema.parse(commitShaInput);
    const existing = this.#ledger.listReleases().find((release) => release.releaseId === commitSha);
    if (existing?.status === "queued") {
      return existing;
    }
    if (
      existing !== undefined &&
      (existing.status === "installed" ||
        existing.status === "failed" ||
        existing.status === "rolled-back")
    ) {
      throw new Error(`release '${commitSha}' cannot be queued from state '${existing.status}'`);
    }
    if (this.#ledger.listReleases().some((release) => release.status === "queued")) {
      throw new Error("another release is already queued");
    }

    let manifest: ReleaseManifest;
    try {
      manifest =
        existing?.status === "candidate"
          ? await this.#store.validate(commitSha)
          : await this.#builder.build(commitSha);
    } catch (error) {
      this.#ledger.saveRelease({
        releaseId: commitSha,
        commitSha,
        status: "failed",
        artifactPath: null,
        requiredSchemaVersion: this.#ledger.schemaVersion,
        metadata: FailedReleaseMetadataSchema.parse({
          schemaVersion: 1,
          failureCode: "candidate-build-validation-failed",
        }),
      });
      throw error;
    }

    if (existing === undefined) {
      this.#ledger.saveRelease({
        releaseId: commitSha,
        commitSha,
        status: "candidate",
        artifactPath: this.#store.relativeArtifactPath(commitSha),
        requiredSchemaVersion: manifest.requiredLedgerSchemaVersion,
        metadata: this.#metadata(manifest, "candidate"),
      });
    }

    const installed = this.#ledger.listReleases().find((release) => release.status === "installed");
    if (installed === undefined) {
      throw new Error("self-update requires a previously installed release");
    }
    const current = await this.#store.currentReleaseId();
    if (current !== installed.releaseId) {
      throw new Error("installed release state does not match the atomic current pointer");
    }
    const priorPolicy = await this.#maintenance.snapshotPolicy();
    const metadata = this.#metadata(manifest, "queued", {
      priorPolicy,
      previousReleaseId: installed.releaseId,
      previousSchemaVersion: this.#ledger.schemaVersion,
    });
    const queued = this.#ledger.saveRelease({
      releaseId: commitSha,
      commitSha,
      status: "queued",
      artifactPath: this.#store.relativeArtifactPath(commitSha),
      requiredSchemaVersion: manifest.requiredLedgerSchemaVersion,
      metadata,
    });
    try {
      await this.#maintenance.requestDrain(updateReason(commitSha));
      return queued;
    } catch (error) {
      this.#saveRecord(queued, "candidate", this.#metadata(manifest, "candidate"));
      throw error;
    }
  }

  public async applyWhenIdle(): Promise<ReleaseUpdateResult> {
    const queued = this.#ledger.listReleases().find((release) => release.status === "queued");
    if (queued === undefined) {
      return { state: "idle" };
    }
    const metadata = CandidateReleaseMetadataSchema.parse(queued.metadata);
    const context = this.#context(queued, metadata);

    if ((await this.#maintenance.activeWorkCount()) > 0) {
      return { state: "waiting-for-drain", releaseId: queued.releaseId };
    }

    const current = await this.#store.currentReleaseId();
    if (
      metadata.update.phase === "restart-requested" ||
      (current === queued.releaseId && PHASE_ORDER[metadata.update.phase] >= PHASE_ORDER.migrated)
    ) {
      if ((await this.#service.runningReleaseId()) !== queued.releaseId) {
        return { state: "restart-requested", releaseId: queued.releaseId };
      }
      return this.#postSwitch(context);
    }

    let migrations: readonly LedgerMigration[] = [];
    let backupCreated = PHASE_ORDER[metadata.update.phase] >= PHASE_ORDER["backup-created"];
    try {
      const manifest = await this.#store.validate(queued.releaseId);
      if (JSON.stringify(manifest) !== JSON.stringify(metadata.manifest)) {
        throw new Error("queued release metadata does not match its immutable manifest");
      }
      if (manifest.requiredLedgerSchemaVersion < this.#ledger.schemaVersion) {
        return await this.#failWithoutBackup(context, "ledger-schema-downgrade-forbidden");
      }
      migrations = await this.#migrations.load(this.#store.artifactPath(queued.releaseId));
      validateLedgerMigrations(migrations);
      if (migrations.length !== manifest.requiredLedgerSchemaVersion) {
        return await this.#failWithoutBackup(
          context,
          "candidate-migration-set-does-not-match-manifest",
        );
      }
      this.#savePhase(context, "validated");

      if (!backupCreated) {
        this.#ledger.backupRelease(queued.releaseId);
        backupCreated = true;
        this.#savePhase(context, "backup-created");
      }

      this.#ledger.applyMigrations(migrations);
      if (this.#ledger.schemaVersion !== manifest.requiredLedgerSchemaVersion) {
        throw new Error("ledger schema does not match the candidate requirement after migration");
      }
      this.#savePhase(context, "migrated");

      const pointerBeforeSwitch = await this.#store.currentReleaseId();
      if (pointerBeforeSwitch !== context.previousReleaseId) {
        throw new Error("current pointer changed after candidate validation");
      }
      await this.#store.activate(queued.releaseId);
      this.#savePhase(context, "restart-requested");
      await this.#service.requestRestart();
      return { state: "restart-requested", releaseId: queued.releaseId };
    } catch (error) {
      if (backupCreated) {
        return this.#restoreAfterFailure(
          context,
          migrations,
          (await this.#store.currentReleaseId()) === queued.releaseId,
          errorReason(error),
        );
      }
      return this.#failWithoutBackup(context, errorReason(error));
    }
  }

  async #postSwitch(context: UpdateContext): Promise<ReleaseUpdateResult> {
    let healthy = false;
    try {
      const report = await this.#health.check({
        releaseId: context.release.releaseId,
        manifest: context.metadata.manifest,
        priorPolicy: context.priorPolicy,
      });
      healthy = report.ok;
    } catch {
      healthy = false;
    }
    if (!healthy) {
      const migrations = await this.#migrations.load(
        this.#store.artifactPath(context.release.releaseId),
      );
      return this.#restoreAfterFailure(context, migrations, true, "post-switch-health-failed");
    }

    try {
      this.#ledger.activateRelease(
        context.release.releaseId,
        this.#metadata(context.metadata.manifest, "installed", {
          priorPolicy: context.priorPolicy,
          previousReleaseId: context.previousReleaseId,
          previousSchemaVersion: context.previousSchemaVersion,
        }),
      );
      await this.#maintenance.finish(updateReason(context.release.releaseId), context.priorPolicy);
      return { state: "installed", releaseId: context.release.releaseId };
    } catch {
      const migrations = await this.#migrations.load(
        this.#store.artifactPath(context.release.releaseId),
      );
      return this.#restoreAfterFailure(context, migrations, true, "post-switch-health-failed");
    }
  }

  async #failWithoutBackup(context: UpdateContext, reason: string): Promise<ReleaseUpdateResult> {
    this.#saveRecord(
      context.release,
      "failed",
      this.#metadata(context.metadata.manifest, "failed", {
        priorPolicy: context.priorPolicy,
        previousReleaseId: context.previousReleaseId,
        previousSchemaVersion: context.previousSchemaVersion,
        failureCode: reason,
      }),
    );
    await this.#maintenance.finish(updateReason(context.release.releaseId), context.priorPolicy);
    await this.#sendAlert("update-failed", {
      releaseId: context.release.releaseId,
      previousReleaseId: context.previousReleaseId,
      reason,
    });
    return { state: "failed", releaseId: context.release.releaseId, reason };
  }

  async #restoreAfterFailure(
    context: UpdateContext,
    migrations: readonly LedgerMigration[],
    pointerSwitched: boolean,
    reason: string,
  ): Promise<ReleaseUpdateResult> {
    if (pointerSwitched) {
      await this.#store.activate(context.previousReleaseId);
    }
    if (migrations.length < context.previousSchemaVersion) {
      throw new Error("candidate migration set cannot restore the previous schema");
    }
    this.#ledger.restoreReleaseBackup(
      context.release.releaseId,
      migrations.slice(0, context.previousSchemaVersion),
    );
    const restored = this.#ledger
      .listReleases()
      .find((release) => release.releaseId === context.release.releaseId);
    if (restored === undefined) {
      throw new Error("restored ledger lost the queued release record");
    }
    const status = pointerSwitched ? "rolled-back" : "failed";
    this.#saveRecord(
      restored,
      status,
      this.#metadata(context.metadata.manifest, status, {
        priorPolicy: context.priorPolicy,
        previousReleaseId: context.previousReleaseId,
        previousSchemaVersion: context.previousSchemaVersion,
        failureCode: reason,
      }),
    );
    await this.#maintenance.finish(updateReason(context.release.releaseId), context.priorPolicy);
    await this.#sendAlert(pointerSwitched ? "update-rollback" : "update-failed", {
      releaseId: context.release.releaseId,
      previousReleaseId: context.previousReleaseId,
      reason,
    });
    if (pointerSwitched) {
      try {
        await this.#service.requestRestart();
      } catch {
        // The rollback is already durable; systemd can retry the prior pointer independently.
      }
    }
    return {
      state: status,
      releaseId: context.release.releaseId,
      reason,
    };
  }

  #savePhase(context: UpdateContext, phase: ReleaseUpdatePhase): ReleaseRecord {
    return this.#saveRecord(
      context.release,
      "queued",
      this.#metadata(context.metadata.manifest, phase, {
        priorPolicy: context.priorPolicy,
        previousReleaseId: context.previousReleaseId,
        previousSchemaVersion: context.previousSchemaVersion,
      }),
    );
  }

  async #sendAlert(
    kind: "update-failed" | "update-rollback",
    detail: {
      readonly releaseId: string;
      readonly previousReleaseId: string | null;
      readonly reason: string;
    },
  ): Promise<void> {
    try {
      await this.#alerts.alert(kind, detail);
    } catch {
      // A notification transport failure cannot undo or block durable update recovery.
    }
  }

  #saveRecord(
    release: ReleaseRecord,
    status: ReleaseRecord["status"],
    metadata: unknown,
  ): ReleaseRecord {
    return this.#ledger.saveRelease({
      releaseId: release.releaseId,
      commitSha: release.commitSha,
      status,
      artifactPath: release.artifactPath,
      requiredSchemaVersion: release.requiredSchemaVersion,
      metadata,
    });
  }

  #context(release: ReleaseRecord, metadata: CandidateReleaseMetadata): UpdateContext {
    if (
      metadata.update.priorPolicy === null ||
      metadata.update.previousReleaseId === null ||
      metadata.update.previousSchemaVersion === null
    ) {
      throw new Error("queued release is missing its pre-update recovery context");
    }
    return {
      release,
      metadata,
      priorPolicy: metadata.update.priorPolicy,
      previousReleaseId: metadata.update.previousReleaseId,
      previousSchemaVersion: metadata.update.previousSchemaVersion,
    };
  }

  #metadata(
    manifest: ReleaseManifest,
    phase: ReleaseUpdatePhase,
    input: {
      readonly priorPolicy?: ReleasePolicySnapshot;
      readonly previousReleaseId?: string;
      readonly previousSchemaVersion?: number;
      readonly failureCode?: string;
    } = {},
  ): CandidateReleaseMetadata {
    return CandidateReleaseMetadataSchema.parse({
      schemaVersion: 1,
      manifest,
      update: {
        phase,
        priorPolicy: input.priorPolicy ?? null,
        previousReleaseId: input.previousReleaseId ?? null,
        previousSchemaVersion: input.previousSchemaVersion ?? null,
        failureCode: input.failureCode ?? null,
      },
    });
  }
}

interface UpdateContext {
  readonly release: ReleaseRecord;
  readonly metadata: CandidateReleaseMetadata;
  readonly priorPolicy: ReleasePolicySnapshot;
  readonly previousReleaseId: string;
  readonly previousSchemaVersion: number;
}
