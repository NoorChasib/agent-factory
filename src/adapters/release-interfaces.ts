import type { ReleaseInventoryEntry, ReleaseManifest } from "../contracts/release-manifest";
import type { LedgerMigration, NewReleaseRecord, ReleaseRecord } from "../ledger";
import type {
  ReleasePolicySnapshot,
  ReleaseReconcileSignal,
  ReleaseUpdateResult,
} from "../releases/types";

export interface ReleaseIdSource {
  nextReleaseId(): string;
}

export interface ReleaseArtifactFileSystemAdapter {
  ensureDirectory(path: string, mode: number): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeTextExclusive(path: string, content: string, mode: number): Promise<void>;
  inventory(
    root: string,
    excludedRelativePaths: readonly string[],
  ): Promise<ReleaseInventoryEntry[]>;
  rename(source: string, destination: string): Promise<void>;
  createSymbolicLink(target: string, path: string): Promise<void>;
  readSymbolicLink(path: string): Promise<string | null>;
  removeTree(path: string): Promise<void>;
  makeImmutable(path: string): Promise<void>;
}

export interface FactoryReleaseBuildAdapter {
  build(input: {
    readonly commitSha: string;
    readonly buildId: string;
    readonly stagingPath: string;
  }): Promise<{ readonly requiredLedgerSchemaVersion: number }>;
}

export interface ReleaseServiceAdapter {
  runningReleaseId(): Promise<string | null>;
  requestRestart(): Promise<void>;
  probe(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

export interface ReleaseMigrationSourceAdapter {
  load(releasePath: string): Promise<readonly LedgerMigration[]>;
}

export interface ReleaseLedgerAdapter {
  readonly schemaVersion: number;
  listReleases(): readonly ReleaseRecord[];
  saveRelease(input: NewReleaseRecord): ReleaseRecord;
  activateRelease(releaseId: string, metadata: unknown): ReleaseRecord;
  backupRelease(releaseId: string): void;
  applyMigrations(migrations: readonly LedgerMigration[]): number;
  restoreReleaseBackup(releaseId: string, migrations: readonly LedgerMigration[]): number;
}

export interface ReleaseMaintenanceAdapter {
  snapshotPolicy(): Promise<ReleasePolicySnapshot>;
  requestDrain(reasonCode: string): Promise<void>;
  activeWorkCount(): Promise<number>;
  finish(reasonCode: string, priorPolicy: ReleasePolicySnapshot): Promise<void>;
}

export interface ReleaseReconciliationAdapter {
  snapshotPolicy(): Promise<ReleasePolicySnapshot>;
  reconcile(): Promise<ReleaseReconcileSignal>;
}

export interface ReleaseUpdateOperator {
  status(): Promise<unknown>;
  queue(commitSha: string): Promise<ReleaseRecord>;
  applyWhenIdle(): Promise<ReleaseUpdateResult>;
}

export interface ReleaseAlertAdapter {
  alert(
    kind: "update-failed" | "update-rollback",
    detail: {
      readonly releaseId: string;
      readonly previousReleaseId: string | null;
      readonly reason: string;
    },
  ): Promise<void>;
}

export interface BuiltRelease {
  readonly manifest: ReleaseManifest;
  readonly artifactPath: string;
}
