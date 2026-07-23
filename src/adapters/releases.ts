import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  GitCommitShaSchema,
  parseReleaseBuildMetadata,
  type ReleaseInventoryEntry,
} from "../contracts/release-manifest";
import type { Controller } from "../controller/controller";
import type { LedgerMigration, NewReleaseRecord, ReleaseRecord, SqliteLedger } from "../ledger";
import { validateLedgerMigrations } from "../ledger";
import type { MaintenanceCoordinator } from "../operations/lifecycle";
import type { FactoryNotifications } from "../operations/observability";
import { normalizedAbsolutePath, within } from "../path-guard";
import type { ReleasePolicySnapshot } from "../releases";
import type { CommandAdapter, CommandExecutionResult, CommandRequest } from "./interfaces";
import type {
  FactoryReleaseBuildAdapter,
  ReleaseAlertAdapter,
  ReleaseArtifactFileSystemAdapter,
  ReleaseLedgerAdapter,
  ReleaseMaintenanceAdapter,
  ReleaseMigrationSourceAdapter,
  ReleaseReconciliationAdapter,
  ReleaseServiceAdapter,
} from "./release-interfaces";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function relativeInventoryPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export interface LocalReleaseFileSystemOptions {
  readonly beforeRename?: (source: string, destination: string) => void;
}

export class LocalReleaseFileSystemAdapter implements ReleaseArtifactFileSystemAdapter {
  readonly #beforeRename: ((source: string, destination: string) => void) | undefined;

  public constructor(options: LocalReleaseFileSystemOptions = {}) {
    this.#beforeRename = options.beforeRename;
  }

  public async ensureDirectory(path: string, mode: number): Promise<void> {
    mkdirSync(path, { recursive: true, mode });
    chmodSync(path, mode);
  }

  public async pathExists(path: string): Promise<boolean> {
    return existsSync(path);
  }

  public async readText(path: string): Promise<string> {
    return readFileSync(path, "utf8");
  }

  public async writeTextExclusive(path: string, content: string, mode: number): Promise<void> {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode });
  }

  public async inventory(
    rootInput: string,
    excludedRelativePaths: readonly string[],
  ): Promise<ReleaseInventoryEntry[]> {
    const root = resolve(rootInput);
    const excluded = new Set(excludedRelativePaths);
    const entries: ReleaseInventoryEntry[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        const path = join(directory, entry.name);
        const relativePath = relativeInventoryPath(root, path);
        if (excluded.has(relativePath)) {
          continue;
        }
        const metadata = lstatSync(path);
        if (metadata.isDirectory()) {
          visit(path);
          continue;
        }
        if (metadata.isFile()) {
          entries.push({
            path: relativePath,
            kind: "file",
            bytes: metadata.size,
            mode: metadata.mode & 0o777,
            sha256: sha256(readFileSync(path)),
          });
          continue;
        }
        if (metadata.isSymbolicLink()) {
          const target = readlinkSync(path);
          if (isAbsolute(target) || !within(root, resolve(dirname(path), target))) {
            throw new Error(`release artifact symlink escapes its root '${relativePath}'`);
          }
          entries.push({
            path: relativePath,
            kind: "symbolic-link",
            bytes: Buffer.byteLength(target),
            mode: metadata.mode & 0o777,
            sha256: sha256(target),
          });
          continue;
        }
        throw new Error(`release artifact contains unsupported file kind '${relativePath}'`);
      }
    };
    visit(root);
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  public async rename(source: string, destination: string): Promise<void> {
    this.#beforeRename?.(source, destination);
    renameSync(source, destination);
  }

  public async createSymbolicLink(target: string, path: string): Promise<void> {
    symlinkSync(target, path);
  }

  public async readSymbolicLink(path: string): Promise<string | null> {
    try {
      const metadata = lstatSync(path);
      if (!metadata.isSymbolicLink()) {
        throw new Error(`release pointer '${path}' is not a symbolic link`);
      }
      return readlinkSync(path);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  public async removeTree(path: string): Promise<void> {
    rmSync(path, { recursive: true, force: true });
  }

  public async makeImmutable(root: string): Promise<void> {
    const visit = (path: string): void => {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        return;
      }
      if (metadata.isDirectory()) {
        for (const entry of readdirSync(path)) {
          visit(join(path, entry));
        }
        chmodSync(path, 0o555);
        return;
      }
      if (metadata.isFile()) {
        const executable = (metadata.mode & 0o111) !== 0;
        chmodSync(path, executable ? 0o555 : 0o444);
        return;
      }
      throw new Error("release artifact contains an unsupported file kind");
    };
    visit(root);
  }
}

function requireCommandSuccess(
  result: CommandExecutionResult,
  description: string,
): CommandExecutionResult & { readonly status: "exited" } {
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new Error(`${description} failed`);
  }
  return result;
}

export class LocalFactoryReleaseBuildAdapter implements FactoryReleaseBuildAdapter {
  readonly #commands: CommandAdapter;
  readonly #repositoryRoot: string;
  readonly #checkoutRoot: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #gitExecutable: string;
  readonly #bunExecutable: string;

  public constructor(input: {
    readonly commands: CommandAdapter;
    readonly repositoryRoot: string;
    readonly checkoutRoot: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly gitExecutable?: string;
    readonly bunExecutable?: string;
  }) {
    this.#commands = input.commands;
    this.#repositoryRoot = normalizedAbsolutePath(input.repositoryRoot, "factory repository root");
    this.#checkoutRoot = normalizedAbsolutePath(input.checkoutRoot, "release checkout root");
    this.#environment = { ...input.environment };
    this.#gitExecutable = input.gitExecutable ?? "git";
    this.#bunExecutable = input.bunExecutable ?? "bun";
  }

  public async build(input: {
    readonly commitSha: string;
    readonly buildId: string;
    readonly stagingPath: string;
  }): Promise<{ readonly requiredLedgerSchemaVersion: number }> {
    const commitSha = GitCommitShaSchema.parse(input.commitSha);
    const checkout = join(this.#checkoutRoot, `${commitSha}-${input.buildId}`);
    if (existsSync(checkout) || existsSync(input.stagingPath)) {
      throw new Error("release build path already exists");
    }
    mkdirSync(this.#checkoutRoot, { recursive: true, mode: 0o700 });

    const resolved = requireCommandSuccess(
      await this.#execute(this.#gitExecutable, [
        "-C",
        this.#repositoryRoot,
        "rev-parse",
        "--verify",
        `${commitSha}^{commit}`,
      ]),
      "factory commit verification",
    );
    if (resolved.stdout.trim() !== commitSha) {
      throw new Error("factory commit verification resolved a different commit");
    }

    let worktreeCreated = false;
    try {
      requireCommandSuccess(
        await this.#execute(this.#gitExecutable, [
          "-C",
          this.#repositoryRoot,
          "worktree",
          "add",
          "--detach",
          "--",
          checkout,
          commitSha,
        ]),
        "factory release checkout",
      );
      worktreeCreated = true;
      requireCommandSuccess(
        await this.#execute(this.#bunExecutable, ["install", "--frozen-lockfile"], checkout),
        "frozen candidate dependency install",
      );
      requireCommandSuccess(
        await this.#execute(this.#bunExecutable, ["run", "validate"], checkout),
        "candidate validation",
      );
      const clean = requireCommandSuccess(
        await this.#execute(
          this.#gitExecutable,
          ["-C", checkout, "status", "--porcelain", "--untracked-files=no"],
          checkout,
        ),
        "candidate cleanliness verification",
      );
      if (clean.stdout.trim() !== "") {
        throw new Error("candidate validation modified tracked factory files");
      }
      const metadata = parseReleaseBuildMetadata(
        JSON.parse(readFileSync(join(checkout, "release.json"), "utf8")) as unknown,
      );
      cpSync(checkout, input.stagingPath, {
        recursive: true,
        dereference: false,
        filter: (source) => source !== join(checkout, ".git"),
      });
      return {
        requiredLedgerSchemaVersion: metadata.requiredLedgerSchemaVersion,
      };
    } finally {
      if (worktreeCreated) {
        requireCommandSuccess(
          await this.#execute(this.#gitExecutable, [
            "-C",
            this.#repositoryRoot,
            "worktree",
            "remove",
            "--force",
            "--",
            checkout,
          ]),
          "factory release checkout cleanup",
        );
      }
    }
  }

  async #execute(
    executable: string,
    argv: readonly string[],
    cwd = this.#repositoryRoot,
  ): Promise<CommandExecutionResult> {
    const request: CommandRequest = {
      executable,
      argv,
      cwd,
      env: this.#environment,
      stdin: "",
      stdout: "capture-json-lines",
      stderr: "capture",
    };
    return this.#commands.execute(request);
  }
}

export class LocalReleaseMigrationSourceAdapter implements ReleaseMigrationSourceAdapter {
  public async load(releasePathInput: string): Promise<readonly LedgerMigration[]> {
    const releasePath = normalizedAbsolutePath(releasePathInput, "release artifact path");
    const moduleUrl = pathToFileURL(join(releasePath, "src", "ledger", "migrations.ts")).href;
    const loaded = (await import(moduleUrl)) as { readonly LEDGER_MIGRATIONS?: unknown };
    if (!Array.isArray(loaded.LEDGER_MIGRATIONS)) {
      throw new Error("candidate release does not export ledger migrations");
    }
    const migrations = structuredClone(loaded.LEDGER_MIGRATIONS) as readonly LedgerMigration[];
    validateLedgerMigrations(migrations);
    return migrations;
  }
}

export class SqliteReleaseLedgerAdapter implements ReleaseLedgerAdapter {
  readonly #ledger: SqliteLedger;
  readonly #backupDirectory: string;

  public constructor(input: { readonly ledger: SqliteLedger; readonly backupDirectory: string }) {
    this.#ledger = input.ledger;
    this.#backupDirectory = normalizedAbsolutePath(
      input.backupDirectory,
      "release backup directory",
    );
  }

  public get schemaVersion(): number {
    return this.#ledger.schemaVersion;
  }

  public listReleases(): readonly ReleaseRecord[] {
    return this.#ledger.listReleases();
  }

  public saveRelease(input: NewReleaseRecord): ReleaseRecord {
    return this.#ledger.saveRelease(input);
  }

  public activateRelease(releaseId: string, metadata: unknown): ReleaseRecord {
    return this.#ledger.activateRelease(releaseId, metadata);
  }

  public backupRelease(releaseId: string): void {
    const path = this.#backupPath(releaseId);
    if (!existsSync(path)) {
      this.#ledger.backup(path);
    }
  }

  public applyMigrations(migrations: readonly LedgerMigration[]): number {
    return this.#ledger.applyMigrations(migrations);
  }

  public restoreReleaseBackup(releaseId: string, migrations: readonly LedgerMigration[]): number {
    return this.#ledger.restoreFromBackup(this.#backupPath(releaseId), migrations).schemaVersion;
  }

  #backupPath(releaseId: string): string {
    return join(this.#backupDirectory, `${GitCommitShaSchema.parse(releaseId)}.sqlite3`);
  }
}

export class ControllerReleaseMaintenanceAdapter implements ReleaseMaintenanceAdapter {
  readonly #controller: Controller;
  readonly #maintenance: MaintenanceCoordinator;

  public constructor(input: {
    readonly controller: Controller;
    readonly maintenance: MaintenanceCoordinator;
  }) {
    this.#controller = input.controller;
    this.#maintenance = input.maintenance;
  }

  public async snapshotPolicy(): Promise<ReleasePolicySnapshot> {
    const status = await this.#controller.status();
    return {
      mode: status.mode,
      rolloutStage: status.rolloutStage,
      limits: status.limits,
    };
  }

  public async requestDrain(reasonCode: string): Promise<void> {
    await this.#maintenance.drain(reasonCode);
  }

  public async activeWorkCount(): Promise<number> {
    return (await this.#controller.status()).executions.filter(
      (execution) => execution.status === "active",
    ).length;
  }

  public async finish(reasonCode: string, priorPolicy: ReleasePolicySnapshot): Promise<void> {
    this.#maintenance.clearReasons([reasonCode]);
    const status = await this.#controller.status();
    if (
      status.rolloutStage !== priorPolicy.rolloutStage ||
      JSON.stringify(status.limits) !== JSON.stringify(priorPolicy.limits)
    ) {
      throw new Error("rollout stage or limits changed during self-update");
    }
    const otherMaintenance = this.#maintenance
      .list()
      .some(
        (request) =>
          (request.status === "active" || request.status === "pending") &&
          request.reasonCode !== reasonCode,
      );
    const restoredMode = otherMaintenance ? "observation" : priorPolicy.mode;
    if (status.mode !== restoredMode) {
      await this.#controller.command({ type: "set-mode", mode: restoredMode });
    }
  }
}

export class ControllerReleaseReconciliationAdapter implements ReleaseReconciliationAdapter {
  readonly #controller: Controller;

  public constructor(controller: Controller) {
    this.#controller = controller;
  }

  public async snapshotPolicy(): Promise<ReleasePolicySnapshot> {
    const status = await this.#controller.status();
    return {
      mode: status.mode,
      rolloutStage: status.rolloutStage,
      limits: status.limits,
    };
  }

  public async reconcile(): Promise<{
    readonly revision: number;
    readonly invariantViolations: readonly string[];
  }> {
    const result = await this.#controller.reconcile({ reason: "recovery" });
    return {
      revision: result.revision,
      invariantViolations: result.invariantViolations,
    };
  }
}

export class SystemdReleaseServiceAdapter implements ReleaseServiceAdapter {
  readonly #commands: CommandAdapter;
  readonly #releaseDirectory: string;
  readonly #runtimeRoot: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #executable: string;
  readonly #unit: string;

  public constructor(input: {
    readonly commands: CommandAdapter;
    readonly releaseDirectory: string;
    readonly runtimeRoot: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly executable?: string;
    readonly unit?: string;
  }) {
    this.#commands = input.commands;
    this.#releaseDirectory = normalizedAbsolutePath(input.releaseDirectory, "release directory");
    this.#runtimeRoot = normalizedAbsolutePath(input.runtimeRoot, "running factory root");
    this.#environment = { ...input.environment };
    this.#executable = input.executable ?? "systemctl";
    this.#unit = z
      .string()
      .regex(/^[A-Za-z0-9_.@-]+\.service$/u)
      .parse(input.unit ?? "agent-factory.service");
  }

  public async runningReleaseId(): Promise<string | null> {
    let runtimeRoot: string;
    try {
      runtimeRoot = realpathSync(this.#runtimeRoot);
    } catch {
      return null;
    }
    if (resolve(runtimeRoot, "..") !== this.#releaseDirectory) {
      return null;
    }
    const parsed = GitCommitShaSchema.safeParse(runtimeRoot.split(sep).at(-1));
    return parsed.success ? parsed.data : null;
  }

  public async requestRestart(): Promise<void> {
    requireCommandSuccess(
      await this.#commands.execute({
        executable: this.#executable,
        argv: ["--user", "--no-block", "restart", this.#unit],
        cwd: this.#releaseDirectory,
        env: this.#environment,
        stdin: "",
        stdout: "capture-json-lines",
        stderr: "capture",
      }),
      "Agent Factory service restart request",
    );
  }

  public async probe(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    const releaseId = await this.runningReleaseId();
    return releaseId === null
      ? { ok: false, detail: "daemon is not running from an immutable release" }
      : { ok: true, detail: "daemon is running from an immutable release" };
  }
}

export class FactoryReleaseAlertAdapter implements ReleaseAlertAdapter {
  readonly #notifications: FactoryNotifications;

  public constructor(notifications: FactoryNotifications) {
    this.#notifications = notifications;
  }

  public async alert(
    kind: "update-failed" | "update-rollback",
    detail: {
      readonly releaseId: string;
      readonly previousReleaseId: string | null;
      readonly reason: string;
    },
  ): Promise<void> {
    await this.#notifications.alert(kind, detail);
  }
}
