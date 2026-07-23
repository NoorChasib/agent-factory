import { z } from "zod";

import { assertExecutionMatchesLaunch, type ControllerAdapters } from "../adapters/interfaces";
import type { ProjectProfile } from "../contracts/project-profile";
import { resolveCanonicalLabels } from "../domain/stages";
import { ControllerCommandSchema, ReconcileRequestSchema } from "./commands";
import { type ControllerConfig, type GlobalLimits, parseControllerConfig } from "./config";
import {
  type ControllerLocalState,
  ControllerLocalStateSchema,
  type ExecutionRecord,
  ExecutionRecordSchema,
  type GitHubProjectObservation,
  GitHubProjectObservationSchema,
  type LedgerSnapshot,
  type PlannedTransition,
  type PlannerPlan,
} from "./model";
import { buildPlannerPlan } from "./planner";

export interface ProjectStatus {
  readonly id: string;
  readonly enabled: boolean;
  readonly effectiveLimits: GlobalLimits;
  readonly observedIssues: number;
  readonly observedPullRequests: number;
  readonly readyToMerge: number;
  readonly activeImplementation: number;
  readonly activeFeedback: number;
}

export interface ControllerStatus {
  readonly observedAt: string;
  readonly mode: ControllerLocalState["mode"];
  readonly revision: number;
  readonly limits: GlobalLimits;
  readonly circuits: ControllerLocalState["circuits"];
  readonly projects: readonly ProjectStatus[];
  readonly executions: readonly ExecutionRecord[];
  readonly blocks: PlannerPlan["blocks"];
  readonly invariantViolations: readonly string[];
}

export interface CommandResult {
  readonly revision: number;
  readonly mode: ControllerLocalState["mode"];
  readonly circuits: ControllerLocalState["circuits"];
  readonly projectEnabled: Readonly<Record<string, boolean>>;
}

export interface ReconcileResult {
  readonly reason: z.infer<typeof ReconcileRequestSchema>["reason"];
  readonly observedAt: string;
  readonly applied: boolean;
  readonly revision: number;
  readonly startedExecutionIds: readonly string[];
  readonly stoppedExecutionIds: readonly string[];
  readonly verifiedExecutionIds: readonly string[];
  readonly blocks: PlannerPlan["blocks"];
  readonly invariantViolations: readonly string[];
  readonly nextPollDelayMs: number;
}

export interface Controller {
  status(): Promise<ControllerStatus>;
  command(input: unknown): Promise<CommandResult>;
  reconcile(input?: unknown): Promise<ReconcileResult>;
}

interface Context {
  readonly observedAt: string;
  readonly ledger: LedgerSnapshot;
  readonly observations: readonly GitHubProjectObservation[];
  readonly plan: PlannerPlan;
}

function cloneState(state: ControllerLocalState): ControllerLocalState {
  return structuredClone(state);
}

function effectiveLimits(profile: ProjectProfile, limits: GlobalLimits): GlobalLimits {
  return {
    implementation: Math.min(
      limits.implementation,
      profile.ceilings?.implementation ?? limits.implementation,
    ),
    feedback: Math.min(limits.feedback, profile.ceilings?.feedback ?? limits.feedback),
    readyToMerge: Math.min(
      limits.readyToMerge,
      profile.ceilings?.readyToMerge ?? limits.readyToMerge,
    ),
  };
}

function assertLedgerSnapshot(input: LedgerSnapshot): LedgerSnapshot {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error("ledger adapter returned an invalid revision");
  }
  return {
    revision: input.revision,
    state: ControllerLocalStateSchema.parse(input.state),
  };
}

function executionAfterTransition(
  execution: ExecutionRecord,
  transition: PlannedTransition,
): ExecutionRecord {
  if (transition.kind === "verify-claim") {
    return { ...execution, claimState: "verified" };
  }
  return { ...execution, status: "released" };
}

function hasActiveIdentityCollision(
  candidate: ExecutionRecord,
  executions: readonly ExecutionRecord[],
): boolean {
  return executions.some((execution) => {
    if (execution.status !== "active" || execution.executionId === candidate.executionId) {
      return false;
    }
    if (execution.projectId !== candidate.projectId) {
      return false;
    }
    return (
      (candidate.issueNumber !== null && execution.issueNumber === candidate.issueNumber) ||
      (candidate.pullRequestNumber !== null &&
        execution.pullRequestNumber === candidate.pullRequestNumber) ||
      (candidate.branch !== null && execution.branch === candidate.branch) ||
      (candidate.worktreeId !== null && execution.worktreeId === candidate.worktreeId)
    );
  });
}

function normalizedExecution(
  input: unknown,
  request: PlannerPlan["launches"][number],
): ExecutionRecord {
  const parsed = ExecutionRecordSchema.parse(input);
  assertExecutionMatchesLaunch(parsed, request);

  const normalized = ExecutionRecordSchema.parse({
    ...parsed,
    issueNumber: request.issueNumber ?? parsed.issueNumber,
    pullRequestNumber: request.pullRequestNumber,
    branch: request.branch ?? parsed.branch,
    headSha: request.headSha ?? parsed.headSha,
    claimState:
      request.lane === "feedback" || parsed.issueNumber !== null
        ? "awaiting-verification"
        : "selecting",
    status: "active",
  });
  if (normalized.lane === "feedback" && normalized.pullRequestNumber === null) {
    throw new Error("feedback launch did not produce a pull-request owner");
  }
  return normalized;
}

class DeterministicController implements Controller {
  readonly #config: ControllerConfig;
  readonly #adapters: ControllerAdapters;

  public constructor(config: ControllerConfig, adapters: ControllerAdapters) {
    this.#config = config;
    this.#adapters = adapters;
  }

  async #context(): Promise<Context> {
    const ledger = assertLedgerSnapshot(await this.#adapters.ledger.read());
    const projectIds = this.#config.profiles.map((profile) => profile.id);
    const rawObservations = await this.#adapters.github.observe(projectIds);
    const observations = z.array(GitHubProjectObservationSchema).parse(rawObservations);
    const known = new Set(projectIds);
    const seen = new Set<string>();
    for (const observation of observations) {
      if (!known.has(observation.projectId)) {
        throw new Error(`GitHub adapter returned unknown project '${observation.projectId}'`);
      }
      if (seen.has(observation.projectId)) {
        throw new Error(`GitHub adapter returned project '${observation.projectId}' twice`);
      }
      seen.add(observation.projectId);
    }

    const now = this.#adapters.clock.now();
    if (Number.isNaN(now.getTime())) {
      throw new Error("clock adapter returned an invalid date");
    }
    const observedAt = now.toISOString();
    const plan = buildPlannerPlan({
      config: this.#config,
      state: ledger.state,
      observations,
    });
    return { observedAt, ledger, observations, plan };
  }

  public async status(): Promise<ControllerStatus> {
    const context = await this.#context();
    const observations = new Map(
      context.observations.map((observation) => [observation.projectId, observation]),
    );
    const projects = this.#config.profiles
      .map((profile): ProjectStatus => {
        const observation = observations.get(profile.id);
        const projectExecutions = context.ledger.state.executions.filter(
          (execution) => execution.projectId === profile.id && execution.status === "active",
        );
        const readyToMerge =
          observation?.pullRequests.filter(
            (pullRequest) =>
              pullRequest.state === "open" &&
              resolveCanonicalLabels(profile.labels, pullRequest.labels).stage === "ready-to-merge",
          ).length ?? 0;
        return {
          id: profile.id,
          enabled: context.ledger.state.projectEnabled[profile.id] ?? profile.enabled,
          effectiveLimits: effectiveLimits(profile, this.#config.limits),
          observedIssues: observation?.issues.length ?? 0,
          observedPullRequests: observation?.pullRequests.length ?? 0,
          readyToMerge,
          activeImplementation: projectExecutions.filter(
            (execution) => execution.lane === "implementation",
          ).length,
          activeFeedback: projectExecutions.filter((execution) => execution.lane === "feedback")
            .length,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));

    return {
      observedAt: context.observedAt,
      mode: context.ledger.state.mode,
      revision: context.ledger.revision,
      limits: this.#config.limits,
      circuits: context.ledger.state.circuits,
      projects,
      executions: context.ledger.state.executions,
      blocks: context.plan.blocks,
      invariantViolations: context.plan.invariantViolations,
    };
  }

  public async command(input: unknown): Promise<CommandResult> {
    const command = ControllerCommandSchema.parse(input);
    const ledger = assertLedgerSnapshot(await this.#adapters.ledger.read());
    const state = cloneState(ledger.state);

    switch (command.type) {
      case "set-mode":
        state.mode = command.mode;
        break;
      case "set-project-enabled":
        if (!this.#config.profiles.some((profile) => profile.id === command.projectId)) {
          throw new Error(`unknown project '${command.projectId}'`);
        }
        state.projectEnabled[command.projectId] = command.enabled;
        break;
      case "set-provider-circuit":
        state.circuits[command.provider] = {
          status: command.status,
          reasonCode: command.status === "closed" ? null : command.reasonCode,
        };
        break;
    }

    const committed = assertLedgerSnapshot(
      await this.#adapters.ledger.commit(ledger.revision, ControllerLocalStateSchema.parse(state)),
    );
    return {
      revision: committed.revision,
      mode: committed.state.mode,
      circuits: committed.state.circuits,
      projectEnabled: committed.state.projectEnabled,
    };
  }

  public async reconcile(input?: unknown): Promise<ReconcileResult> {
    const request = ReconcileRequestSchema.parse(input ?? {});
    const context = await this.#context();
    const random = this.#adapters.random.next();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new Error("random adapter must return a finite value in [0, 1)");
    }
    const nextPollDelayMs = Math.round(
      this.#config.polling.intervalMs * (1 + (random * 2 - 1) * this.#config.polling.jitterRatio),
    );

    if (context.ledger.state.mode === "observation") {
      return {
        reason: request.reason,
        observedAt: context.observedAt,
        applied: false,
        revision: context.ledger.revision,
        startedExecutionIds: [],
        stoppedExecutionIds: [],
        verifiedExecutionIds: [],
        blocks: context.plan.blocks,
        invariantViolations: context.plan.invariantViolations,
        nextPollDelayMs,
      };
    }

    const state = cloneState(context.ledger.state);
    const stoppedExecutionIds: string[] = [];
    const verifiedExecutionIds: string[] = [];
    for (const transition of context.plan.transitions) {
      const index = state.executions.findIndex(
        (execution) => execution.executionId === transition.executionId,
      );
      const execution = state.executions[index];
      if (index < 0 || execution === undefined || execution.status !== "active") {
        continue;
      }
      if (transition.kind === "release") {
        await this.#adapters.processes.stop({
          executionId: transition.executionId,
          reason: transition.reason,
        });
        stoppedExecutionIds.push(transition.executionId);
      } else {
        verifiedExecutionIds.push(transition.executionId);
      }
      state.executions[index] = executionAfterTransition(execution, transition);
    }

    const startedExecutionIds: string[] = [];
    for (const launch of context.plan.launches) {
      const execution = normalizedExecution(await this.#adapters.processes.start(launch), launch);
      if (state.executions.some((existing) => existing.executionId === execution.executionId)) {
        throw new Error(`duplicate execution id '${execution.executionId}'`);
      }
      if (hasActiveIdentityCollision(execution, state.executions)) {
        throw new Error(`launch '${execution.executionId}' violates one-owner execution identity`);
      }
      state.executions.push(execution);
      startedExecutionIds.push(execution.executionId);
    }
    state.rotation = { ...context.plan.rotation };

    let revision = context.ledger.revision;
    const changed =
      context.plan.transitions.length > 0 ||
      startedExecutionIds.length > 0 ||
      state.rotation.implementation !== context.ledger.state.rotation.implementation ||
      state.rotation.feedback !== context.ledger.state.rotation.feedback;
    if (changed) {
      const committed = assertLedgerSnapshot(
        await this.#adapters.ledger.commit(
          context.ledger.revision,
          ControllerLocalStateSchema.parse(state),
        ),
      );
      revision = committed.revision;
    }

    return {
      reason: request.reason,
      observedAt: context.observedAt,
      applied: changed,
      revision,
      startedExecutionIds,
      stoppedExecutionIds,
      verifiedExecutionIds,
      blocks: context.plan.blocks,
      invariantViolations: context.plan.invariantViolations,
      nextPollDelayMs,
    };
  }
}

export function createController(config: unknown, adapters: ControllerAdapters): Controller {
  return new DeterministicController(parseControllerConfig(config), adapters);
}
