import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import type { ExecutionRecord } from "../controller/model";
import type { LabelOperator, WorkerOperator } from "../daemon/router";
import {
  applyLabelMigration,
  type GitHubMutationExecutor,
  type LabelMigrationPlan,
  planLabelMigration,
  renderLabelMigrationPreview,
} from "../github";
import type { HerdrSessionManager } from "../herdr";
import type { AuditEvent, ExecutionRecovery, LedgerIdSource, SqliteLedger } from "../ledger";
import type { DurableRecoveryVerifier, FactoryOwnedProcessStopper } from "../operations/lifecycle";
import type { RetentionArtifacts, RetentionCandidate } from "../operations/retention";
import type { ClaudeSessionIdSource } from "../providers";
import type { ProviderExecutionRepository } from "../providers/persistence";
import type { WorktreeCustody } from "../worktrees";
import type {
  ClockAdapter,
  ProcessIdentity,
  ProcessTreeAdapter,
  RandomAdapter,
} from "./interfaces";
import type { ReleaseIdSource } from "./release-interfaces";

export class SystemClockAdapter implements ClockAdapter {
  public now(): Date {
    return new Date();
  }
}

export class SystemRandomAdapter implements RandomAdapter {
  public next(): number {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return (bytes[0] ?? 0) / 2 ** 32;
  }
}

export class CryptoIdSource implements LedgerIdSource, ClaudeSessionIdSource, ReleaseIdSource {
  public nextId(kind: Parameters<LedgerIdSource["nextId"]>[0]): string {
    return `${kind}-${crypto.randomUUID()}`;
  }

  public nextClaudeSessionId(): string {
    return crypto.randomUUID();
  }

  public nextReleaseId(): string {
    return `release-${crypto.randomUUID()}`;
  }
}

interface ProcRecord {
  readonly processId: number;
  readonly parentProcessId: number;
  readonly startTicks: number;
}

function procRecord(processId: number): ProcRecord | null {
  try {
    const stat = readFileSync(`/proc/${processId}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    const fields = stat.slice(closing + 2).split(" ");
    const parentProcessId = Number(fields[1]);
    const startTicks = Number(fields[19]);
    if (
      !Number.isSafeInteger(parentProcessId) ||
      parentProcessId < 0 ||
      !Number.isSafeInteger(startTicks) ||
      startTicks < 0
    ) {
      return null;
    }
    return { processId, parentProcessId, startTicks };
  } catch {
    return null;
  }
}

function bootTimeSeconds(): number {
  const line = readFileSync("/proc/stat", "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith("btime "));
  const value = Number(line?.slice(6));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Linux process boot time is unavailable");
  }
  return value;
}

export class LinuxProcessTreeAdapter implements ProcessTreeAdapter {
  readonly #clockTicksPerSecond: number;

  public constructor(clockTicksPerSecond = 100) {
    this.#clockTicksPerSecond = z.number().int().positive().max(10_000).parse(clockTicksPerSecond);
  }

  public async inspectTree(rootProcessId: number): Promise<readonly ProcessIdentity[]> {
    const records = readdirSync("/proc")
      .filter((name) => /^\d+$/u.test(name))
      .map(Number)
      .flatMap((processId) => {
        const record = procRecord(processId);
        return record === null ? [] : [record];
      });
    const included = new Set([rootProcessId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        if (included.has(record.parentProcessId) && !included.has(record.processId)) {
          included.add(record.processId);
          changed = true;
        }
      }
    }
    const boot = bootTimeSeconds();
    return records
      .filter((record) => included.has(record.processId))
      .map((record) => ({
        processId: record.processId,
        parentProcessId: record.parentProcessId === 0 ? null : record.parentProcessId,
        startedAt: new Date(
          (boot + record.startTicks / this.#clockTicksPerSecond) * 1_000,
        ).toISOString(),
      }))
      .sort((left, right) => left.processId - right.processId);
  }
}

export class LedgerRecoveryVerifier implements DurableRecoveryVerifier {
  readonly #ledger: SqliteLedger;

  public constructor(ledger: SqliteLedger) {
    this.#ledger = ledger;
  }

  public async verify(
    executionIds: readonly string[],
  ): Promise<{ readonly durable: boolean; readonly failures: readonly string[] }> {
    const failures: string[] = [];
    for (const executionId of executionIds) {
      const recovery = this.#ledger.readExecutionRecovery(executionId);
      if (recovery.execution.status === "active") {
        failures.push(`${executionId}:active`);
        continue;
      }
      const latest = recovery.attempts.at(-1);
      if (latest?.status === "active") {
        failures.push(`${executionId}:attempt-active`);
      }
      if (
        (latest?.status === "stalled" || latest?.status === "operator-required") &&
        (recovery.sessions.length === 0 || recovery.process === null)
      ) {
        failures.push(`${executionId}:recovery-incomplete`);
      }
    }
    return { durable: failures.length === 0, failures };
  }
}

export class HerdrProviderExecutionRepository implements ProviderExecutionRepository {
  readonly #ledger: SqliteLedger;

  public constructor(ledger: SqliteLedger) {
    this.#ledger = ledger;
  }

  public readExecutionRecovery(
    executionId: string,
  ): ReturnType<SqliteLedger["readExecutionRecovery"]> {
    return this.#ledger.readExecutionRecovery(executionId);
  }

  public findCodexSessionForPullRequest(
    projectId: string,
    pullRequestNumber: number,
  ): ReturnType<SqliteLedger["findCodexSessionForPullRequest"]> {
    return this.#ledger.findCodexSessionForPullRequest(projectId, pullRequestNumber);
  }

  public startAttempt(executionId: string): ReturnType<SqliteLedger["startAttempt"]> {
    return this.#ledger.startAttempt(executionId);
  }

  public updateAttempt(
    input: Parameters<SqliteLedger["updateAttempt"]>[0],
  ): ReturnType<SqliteLedger["updateAttempt"]> {
    return this.#ledger.updateAttempt(input);
  }

  public registerProviderSession(
    input: Parameters<SqliteLedger["registerProviderSession"]>[0],
  ): ReturnType<SqliteLedger["registerProviderSession"]> {
    return this.#ledger.registerProviderSession(input);
  }

  public markProviderSessionResumed(
    sessionKey: string,
  ): ReturnType<SqliteLedger["markProviderSessionResumed"]> {
    return this.#ledger.markProviderSessionResumed(sessionKey);
  }

  public saveProcessMetadata(
    input: Parameters<SqliteLedger["saveProcessMetadata"]>[0],
  ): ReturnType<SqliteLedger["saveProcessMetadata"]> {
    const existing = this.#ledger.readExecutionRecovery(input.executionId).process;
    if (existing === null || existing.paneId === null) {
      return this.#ledger.saveProcessMetadata(input);
    }
    const existingRuntime =
      existing.runtimeMetadata !== null &&
      typeof existing.runtimeMetadata === "object" &&
      !Array.isArray(existing.runtimeMetadata)
        ? existing.runtimeMetadata
        : {};
    return this.#ledger.saveProcessMetadata({
      executionId: input.executionId,
      attemptNumber: input.attemptNumber,
      paneId: existing.paneId,
      processId: existing.processId,
      processStartedAt: existing.processStartedAt,
      hostIdentity: existing.hostIdentity,
      runtimeMetadata: {
        ...existingRuntime,
        providerRun: input.runtimeMetadata,
      },
    });
  }
}

export class LedgerOwnedProcessStopper implements FactoryOwnedProcessStopper {
  readonly #ledger: SqliteLedger;
  readonly #processes: ProcessTreeAdapter;

  public constructor(ledger: SqliteLedger, processes: ProcessTreeAdapter) {
    this.#ledger = ledger;
    this.#processes = processes;
  }

  public async stopFactoryOwned(): Promise<readonly number[]> {
    const stopped: number[] = [];
    for (const execution of this.#ledger.listExecutions()) {
      const metadata = this.#ledger.readExecutionRecovery(execution.executionId).process;
      if (metadata?.processId === null || metadata?.processId === undefined) {
        continue;
      }
      const runtime = z
        .object({
          sessionName: z.literal("agent-factory"),
          custody: z.literal("factory"),
        })
        .safeParse(metadata.runtimeMetadata);
      if (!runtime.success) {
        continue;
      }
      const tree = await this.#processes.inspectTree(metadata.processId);
      if (
        metadata.processStartedAt === null ||
        !tree.some(
          (candidate) =>
            candidate.processId === metadata.processId &&
            candidate.startedAt === metadata.processStartedAt,
        )
      ) {
        continue;
      }
      process.kill(metadata.processId, "SIGTERM");
      stopped.push(metadata.processId);
    }
    return stopped.sort((left, right) => left - right);
  }
}

function recoveryState(recovery: ExecutionRecovery): RetentionCandidate["recoveryState"] {
  const status = recovery.attempts.at(-1)?.status;
  return status === "stalled"
    ? "stalled"
    : status === "operator-required"
      ? "operator-required"
      : "none";
}

function mergedAt(recovery: ExecutionRecovery): string | null {
  const parsed = z
    .object({
      retention: z.object({ mergedAt: z.iso.datetime({ offset: true }).nullable() }),
    })
    .safeParse(recovery.process?.runtimeMetadata);
  return parsed.success ? parsed.data.retention.mergedAt : null;
}

export class LedgerRetentionArtifacts implements RetentionArtifacts {
  readonly #ledger: SqliteLedger;
  readonly #worktrees: WorktreeCustody;
  readonly #logDirectory: string;
  readonly #clock: ClockAdapter;
  readonly #observedMergedAt:
    | ((projectId: string, pullRequestNumber: number) => string | null)
    | undefined;

  public constructor(input: {
    readonly ledger: SqliteLedger;
    readonly worktrees: WorktreeCustody;
    readonly logDirectory: string;
    readonly clock: ClockAdapter;
    readonly observedMergedAt?: (projectId: string, pullRequestNumber: number) => string | null;
  }) {
    this.#ledger = input.ledger;
    this.#worktrees = input.worktrees;
    this.#logDirectory = input.logDirectory;
    this.#clock = input.clock;
    this.#observedMergedAt = input.observedMergedAt;
  }

  public async candidates(): Promise<readonly RetentionCandidate[]> {
    return this.#ledger.listExecutions().flatMap((execution) => {
      if (
        execution.issueNumber === null ||
        execution.branch === null ||
        execution.status === "active"
      ) {
        return [];
      }
      const recovery = this.#ledger.readExecutionRecovery(execution.executionId);
      const observationMergedAt =
        execution.pullRequestNumber === null
          ? null
          : (this.#observedMergedAt?.(execution.projectId, execution.pullRequestNumber) ?? null);
      return [
        {
          executionId: execution.executionId,
          projectId: execution.projectId,
          issueNumber: execution.issueNumber,
          branch: execution.branch,
          mergedAt: observationMergedAt ?? mergedAt(recovery),
          recoveryState: recoveryState(recovery),
          explicitlyReleased: execution.status === "released",
        },
      ];
    });
  }

  public async removeWorktree(candidate: RetentionCandidate): Promise<boolean> {
    return (
      await this.#worktrees.removeEligible({
        projectId: candidate.projectId,
        issueNumber: candidate.issueNumber,
        branch: candidate.branch,
        cleanup: {
          mergedAt: candidate.mergedAt,
          recoveryState: candidate.recoveryState,
          explicitlyReleased: candidate.explicitlyReleased,
        },
        now: this.#clock.now(),
      })
    ).removed;
  }

  public async removeExecutionLogs(executionId: string): Promise<boolean> {
    const safeExecutionId = z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u)
      .parse(executionId);
    const names = existsSync(this.#logDirectory) ? readdirSync(this.#logDirectory) : [];
    const targets = names.filter((name) => {
      if (name === `${safeExecutionId}.jsonl`) {
        return true;
      }
      if (!name.startsWith(`${safeExecutionId}-`) || !name.endsWith(".json")) {
        return false;
      }
      return /^\d+$/u.test(name.slice(safeExecutionId.length + 1, -5));
    });
    for (const name of targets) {
      const path = join(this.#logDirectory, name);
      if (!lstatSync(path).isFile()) {
        throw new Error("refusing to remove a non-file execution log");
      }
      unlinkSync(path);
    }
    return targets.length > 0;
  }
}

export class HerdrWorkerOperator implements WorkerOperator {
  readonly #herdr: HerdrSessionManager;
  readonly #ledger: SqliteLedger;
  readonly #processes: ProcessTreeAdapter;
  readonly #resume: (executionId: string) => Promise<unknown>;

  public constructor(input: {
    readonly herdr: HerdrSessionManager;
    readonly ledger: SqliteLedger;
    readonly processes: ProcessTreeAdapter;
    readonly resume: (executionId: string) => Promise<unknown>;
  }) {
    this.#herdr = input.herdr;
    this.#ledger = input.ledger;
    this.#processes = input.processes;
    this.#resume = input.resume;
  }

  public attach(executionId: string): Promise<unknown> {
    return this.#herdr.attach(executionId);
  }

  public takeover(executionId: string): Promise<unknown> {
    return this.#herdr.takeover(executionId);
  }

  public resume(executionId: string): Promise<unknown> {
    return this.#resume(executionId);
  }

  public async stop(executionId: string): Promise<unknown> {
    const recovery = this.#ledger.readExecutionRecovery(executionId);
    const processId = recovery.process?.processId;
    if (processId === null || processId === undefined) {
      throw new Error(`execution '${executionId}' has no recorded process`);
    }
    const startedAt = recovery.process?.processStartedAt;
    const runtime = z
      .object({
        sessionName: z.literal("agent-factory"),
        custody: z.enum(["factory", "operator"]),
      })
      .safeParse(recovery.process?.runtimeMetadata);
    const tree = await this.#processes.inspectTree(processId);
    const root = tree.find((candidate) => candidate.processId === processId);
    if (!runtime.success || startedAt === null || root?.startedAt !== startedAt) {
      throw new Error(`execution '${executionId}' process identity is no longer factory-owned`);
    }
    process.kill(processId, "SIGTERM");
    return { executionId, signal: "SIGTERM" };
  }

  public kill(executionId: string): Promise<unknown> {
    return this.#herdr.kill(executionId);
  }
}

export class GitHubLabelOperator implements LabelOperator {
  readonly #profiles: ReadonlyMap<string, Parameters<typeof planLabelMigration>[0]>;
  readonly #mutations: GitHubMutationExecutor;
  readonly #plans = new Map<string, LabelMigrationPlan>();

  public constructor(
    profiles: readonly Parameters<typeof planLabelMigration>[0][],
    mutations: GitHubMutationExecutor,
  ) {
    this.#profiles = new Map(profiles.map((profile) => [profile.id, profile]));
    this.#mutations = mutations;
  }

  public async plan(projectId: string): Promise<unknown> {
    const profile = this.#profile(projectId);
    const plan = planLabelMigration(
      profile,
      await this.#mutations.gateway.listRepositoryLabels(projectId, false),
    );
    this.#plans.set(projectId, plan);
    return plan;
  }

  public async preview(projectId: string): Promise<unknown> {
    const plan = (await this.plan(projectId)) as LabelMigrationPlan;
    return { plan, preview: renderLabelMigrationPreview(plan) };
  }

  public async apply(projectId: string, hash: string): Promise<unknown> {
    const plan = this.#plans.get(projectId);
    if (plan === undefined || plan.hash !== hash) {
      throw new Error("label apply requires the exact hash from this daemon's latest preview");
    }
    return applyLabelMigration({
      profile: this.#profile(projectId),
      plan,
      approvedHash: hash,
      mutations: this.#mutations,
    });
  }

  #profile(projectId: string): Parameters<typeof planLabelMigration>[0] {
    const profile = this.#profiles.get(projectId);
    if (profile === undefined) {
      throw new Error(`unknown project '${projectId}'`);
    }
    return profile;
  }
}

export interface OperationsAuditRepository {
  listExecutions(): readonly ExecutionRecord[];
  readExecutionRecovery(executionId: string): ExecutionRecovery;
  appendAudit(kind: string, payload: unknown): AuditEvent;
}
