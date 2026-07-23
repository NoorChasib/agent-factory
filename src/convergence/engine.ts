import type { ClockAdapter } from "../adapters/interfaces";
import type { ProjectProfile } from "../contracts/project-profile";
import type { ProviderFailureClassification } from "../contracts/provider-output";
import { resolveCanonicalLabels } from "../domain/stages";
import {
  assessReadyToMerge,
  buildCheckObservationMarker,
  buildReviewObservationMarker,
  type CanonicalStageManager,
  detectReadyToMergeRevocation,
  type GitHubCheckSnapshot,
  type GitHubProjectSnapshot,
  type GitHubPullRequestSnapshot,
  type GitHubReviewBaselineRepository,
  inspectCurrentHeadRequirements,
  repairableCheck,
  type StageTransitionResult,
} from "../github";
import type { ReviewBaseline } from "../ledger";
import { circuitSignalForFailure } from "../providers/circuits";
import type { ProviderCircuitSignal } from "../providers/types";

export const QUIESCENCE_POLL_INTERVAL_MS = 60_000;
export const MAX_CODE_CHANGING_FEEDBACK_ROUNDS = 3;
export const MAX_TOTAL_FEEDBACK_INVOCATIONS = 6;

export type SafeRerunClassification =
  | "cancel"
  | "genuine-failure"
  | "infrastructure"
  | "timeout"
  | "unknown";

export interface FeedbackProgress {
  readonly codeChangingRounds: number;
  readonly totalInvocations: number;
}

export type FeedbackBudgetDecision =
  | {
      readonly allowed: true;
      readonly progress: FeedbackProgress;
      readonly operatorHandoff: false;
      readonly preservesCodexState: true;
    }
  | {
      readonly allowed: false;
      readonly progress: FeedbackProgress;
      readonly operatorHandoff: true;
      readonly preservesCodexState: true;
      readonly reason: "code-changing-round-limit" | "total-invocation-limit";
    };

export interface ReviewerFailure {
  readonly classification: ProviderFailureClassification;
  readonly reasonCode: string;
}

export interface ConvergenceEvaluationInput {
  readonly profile: ProjectProfile;
  readonly snapshot: GitHubProjectSnapshot;
  readonly pullRequestNumber: number;
  readonly headObservedAt: string;
  readonly reviewerFailure?: ReviewerFailure;
  readonly checkClassifications?: Readonly<Record<string, SafeRerunClassification>>;
}

export type ConvergenceAction =
  | "already-ready"
  | "check-stalled"
  | "emit-ready-to-merge"
  | "feedback-required"
  | "operator-handoff"
  | "rerun-check"
  | "review-provider-unavailable"
  | "review-stalled"
  | "revoke-ready-to-merge"
  | "wait-for-checks"
  | "wait-for-mergeability"
  | "wait-for-quiescence"
  | "wait-for-reviewers";

export interface ConvergenceDecision {
  readonly action: ConvergenceAction;
  readonly reasons: readonly string[];
  readonly headSha: string;
  readonly baseline: ReviewBaseline | null;
  readonly quiescentPollCount: number;
  readonly checkToRerun: string | null;
  readonly circuitSignal: ProviderCircuitSignal | null;
  readonly preservesCodexState: boolean;
}

export interface ReadyEmissionResult {
  readonly decision: ConvergenceDecision;
  readonly transition: StageTransitionResult | null;
}

function assertProgress(progress: FeedbackProgress): void {
  if (
    !Number.isInteger(progress.codeChangingRounds) ||
    progress.codeChangingRounds < 0 ||
    !Number.isInteger(progress.totalInvocations) ||
    progress.totalInvocations < 0 ||
    progress.codeChangingRounds > progress.totalInvocations
  ) {
    throw new Error("feedback progress is invalid");
  }
}

export function assessFeedbackInvocation(
  progress: FeedbackProgress,
  codeChanged: boolean,
): FeedbackBudgetDecision {
  assertProgress(progress);
  if (progress.totalInvocations >= MAX_TOTAL_FEEDBACK_INVOCATIONS) {
    return {
      allowed: false,
      progress,
      operatorHandoff: true,
      preservesCodexState: true,
      reason: "total-invocation-limit",
    };
  }
  if (codeChanged && progress.codeChangingRounds >= MAX_CODE_CHANGING_FEEDBACK_ROUNDS) {
    return {
      allowed: false,
      progress,
      operatorHandoff: true,
      preservesCodexState: true,
      reason: "code-changing-round-limit",
    };
  }
  return {
    allowed: true,
    progress: {
      totalInvocations: progress.totalInvocations + 1,
      codeChangingRounds: progress.codeChangingRounds + (codeChanged ? 1 : 0),
    },
    operatorHandoff: false,
    preservesCodexState: true,
  };
}

export function isSafeCheckRerunClassification(classification: SafeRerunClassification): boolean {
  return (
    classification === "infrastructure" ||
    classification === "cancel" ||
    classification === "timeout"
  );
}

export function classifyGitHubCheckForRerun(check: GitHubCheckSnapshot): SafeRerunClassification {
  switch (check.conclusion) {
    case "CANCELLED":
      return "cancel";
    case "STARTUP_FAILURE":
      return "infrastructure";
    case "TIMED_OUT":
      return "timeout";
    case "ACTION_REQUIRED":
    case "ERROR":
    case "FAILURE":
      return "genuine-failure";
    default:
      return "unknown";
  }
}

function timestamp(value: string, description: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${description} is not a valid timestamp`);
  }
  return parsed;
}

function checkIdentity(check: GitHubCheckSnapshot): string {
  return check.appSlug === null ? check.name : `${check.appSlug}/${check.name}`;
}

function markerMatches(baseline: ReviewBaseline, pullRequest: GitHubPullRequestSnapshot): boolean {
  return (
    baseline.headSha === pullRequest.headSha &&
    JSON.stringify(baseline.reviewObservation) ===
      JSON.stringify(buildReviewObservationMarker(pullRequest)) &&
    JSON.stringify(baseline.checkObservation) ===
      JSON.stringify(buildCheckObservationMarker(pullRequest))
  );
}

function decision(input: {
  readonly action: ConvergenceAction;
  readonly pullRequest: GitHubPullRequestSnapshot;
  readonly reasons?: readonly string[];
  readonly baseline: ReviewBaseline | null;
  readonly checkToRerun?: string | null;
  readonly circuitSignal?: ProviderCircuitSignal | null;
  readonly preservesCodexState?: boolean;
}): ConvergenceDecision {
  return {
    action: input.action,
    reasons: input.reasons ?? [],
    headSha: input.pullRequest.headSha,
    baseline: input.baseline,
    quiescentPollCount: input.baseline?.quiescentPollCount ?? 0,
    checkToRerun: input.checkToRerun ?? null,
    circuitSignal: input.circuitSignal ?? null,
    preservesCodexState: input.preservesCodexState ?? false,
  };
}

export class ReviewConvergenceEngine {
  readonly #clock: ClockAdapter;
  readonly #baselines: GitHubReviewBaselineRepository;
  readonly #quiescenceIntervalMs: number;

  public constructor(
    clock: ClockAdapter,
    baselines: GitHubReviewBaselineRepository,
    quiescenceIntervalMs = QUIESCENCE_POLL_INTERVAL_MS,
  ) {
    if (!Number.isInteger(quiescenceIntervalMs) || quiescenceIntervalMs <= 0) {
      throw new Error("quiescence interval must be a positive integer");
    }
    this.#clock = clock;
    this.#baselines = baselines;
    this.#quiescenceIntervalMs = quiescenceIntervalMs;
  }

  public evaluate(input: ConvergenceEvaluationInput): ConvergenceDecision {
    if (input.snapshot.projectId !== input.profile.id) {
      throw new Error("convergence snapshot belongs to a different project");
    }
    const pullRequest = input.snapshot.pullRequests.find(
      (candidate) => candidate.number === input.pullRequestNumber,
    );
    if (pullRequest === undefined) {
      throw new Error(`pull request ${input.pullRequestNumber} is not observed`);
    }
    const now = this.#clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("convergence clock returned an invalid date");
    }
    const headObservedAt = timestamp(input.headObservedAt, "headObservedAt");
    if (headObservedAt > now.getTime()) {
      throw new Error("headObservedAt cannot be in the future");
    }

    const baseline = this.#baselines.getReviewBaseline(input.profile.id, pullRequest.number);
    const resolved = resolveCanonicalLabels(input.profile.labels, pullRequest.labels);
    if (resolved.conflictingStages.length > 0) {
      return decision({
        action: "operator-handoff",
        pullRequest,
        reasons: ["conflicting-lifecycle-stages"],
        baseline,
        preservesCodexState: true,
      });
    }
    if (resolved.stage === "ready-to-merge") {
      const revocation = detectReadyToMergeRevocation(
        input.profile,
        input.snapshot,
        pullRequest,
        baseline,
      );
      if (revocation.length > 0) {
        return decision({
          action: "revoke-ready-to-merge",
          pullRequest,
          reasons: revocation,
          baseline,
        });
      }
      return decision({ action: "already-ready", pullRequest, baseline });
    }

    if (input.reviewerFailure !== undefined) {
      const signal = circuitSignalForFailure(
        "reviewer",
        input.reviewerFailure.classification,
        input.reviewerFailure.reasonCode,
      );
      if (signal !== null) {
        return decision({
          action: "review-provider-unavailable",
          pullRequest,
          reasons: [input.reviewerFailure.reasonCode],
          baseline,
          circuitSignal: signal,
          preservesCodexState: true,
        });
      }
    }

    if (pullRequest.unresolvedThreads > 0 || pullRequest.reviewDecision === "changes-requested") {
      return decision({
        action: "feedback-required",
        pullRequest,
        reasons: ["current-head-feedback"],
        baseline,
        preservesCodexState: true,
      });
    }

    const requirements = inspectCurrentHeadRequirements(input.profile, input.snapshot, pullRequest);
    const failingCheck = requirements.failingChecks.find(repairableCheck);
    if (failingCheck !== undefined) {
      const identity = checkIdentity(failingCheck);
      const classification =
        input.checkClassifications?.[identity] ??
        input.checkClassifications?.[failingCheck.name] ??
        classifyGitHubCheckForRerun(failingCheck);
      if (isSafeCheckRerunClassification(classification)) {
        return decision({
          action: "rerun-check",
          pullRequest,
          reasons: [classification],
          baseline,
          checkToRerun: identity,
          preservesCodexState: true,
        });
      }
      return decision({
        action: "feedback-required",
        pullRequest,
        reasons: [`check-${classification}`],
        baseline,
        preservesCodexState: true,
      });
    }

    const elapsed = now.getTime() - headObservedAt;
    if (requirements.missingReviewerIds.length > 0 || requirements.optionalReviewMissing) {
      const missing = [
        ...requirements.missingReviewerIds,
        ...(requirements.optionalReviewMissing ? ["optional-owner-review"] : []),
      ];
      if (elapsed >= input.profile.timeouts.reviewerMinutes * 60_000) {
        return decision({
          action: "review-stalled",
          pullRequest,
          reasons: missing,
          baseline,
          preservesCodexState: true,
        });
      }
      return decision({
        action: "wait-for-reviewers",
        pullRequest,
        reasons: missing,
        baseline,
        preservesCodexState: true,
      });
    }
    if (requirements.missingCheckNames.length > 0) {
      if (elapsed >= input.profile.timeouts.requiredCheckMinutes * 60_000) {
        return decision({
          action: "check-stalled",
          pullRequest,
          reasons: requirements.missingCheckNames,
          baseline,
          preservesCodexState: true,
        });
      }
      return decision({
        action: "wait-for-checks",
        pullRequest,
        reasons: requirements.missingCheckNames,
        baseline,
        preservesCodexState: true,
      });
    }
    if (pullRequest.draft || pullRequest.mergeability !== "mergeable") {
      return decision({
        action: "wait-for-mergeability",
        pullRequest,
        reasons: [
          ...(pullRequest.draft ? ["draft"] : []),
          ...(pullRequest.mergeability !== "mergeable" ? ["mergeability"] : []),
        ],
        baseline,
        preservesCodexState: true,
      });
    }

    if (baseline === null || !markerMatches(baseline, pullRequest)) {
      const reset = this.#baselines.saveReviewBaseline({
        projectId: input.profile.id,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.headSha,
        reviewObservation: buildReviewObservationMarker(pullRequest),
        checkObservation: buildCheckObservationMarker(pullRequest),
        quiescentPollCount: 0,
      });
      return decision({
        action: "wait-for-quiescence",
        pullRequest,
        reasons: ["observation-changed"],
        baseline: reset,
        preservesCodexState: true,
      });
    }

    let quiescent = baseline;
    if (
      baseline.quiescentPollCount < input.profile.timeouts.quiescencePolls &&
      now.getTime() - timestamp(baseline.updatedAt, "review baseline updatedAt") >=
        this.#quiescenceIntervalMs
    ) {
      quiescent = this.#baselines.saveReviewBaseline({
        projectId: input.profile.id,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.headSha,
        reviewObservation: buildReviewObservationMarker(pullRequest),
        checkObservation: buildCheckObservationMarker(pullRequest),
        quiescentPollCount: baseline.quiescentPollCount + 1,
      });
    }
    if (quiescent.quiescentPollCount < input.profile.timeouts.quiescencePolls) {
      return decision({
        action: "wait-for-quiescence",
        pullRequest,
        reasons: ["unchanged-polls-incomplete"],
        baseline: quiescent,
        preservesCodexState: true,
      });
    }

    const ready = assessReadyToMerge(input.profile, input.snapshot, pullRequest, quiescent);
    return ready.ready
      ? decision({
          action: "emit-ready-to-merge",
          pullRequest,
          baseline: quiescent,
        })
      : decision({
          action: "feedback-required",
          pullRequest,
          reasons: ready.reasons,
          baseline: quiescent,
          preservesCodexState: true,
        });
  }
}

export class ReadyToMergeEmitter {
  readonly #stages: CanonicalStageManager;

  public constructor(stages: CanonicalStageManager) {
    this.#stages = stages;
  }

  public async apply(
    profile: ProjectProfile,
    pullRequest: GitHubPullRequestSnapshot,
    decisionValue: ConvergenceDecision,
  ): Promise<ReadyEmissionResult> {
    if (decisionValue.action !== "emit-ready-to-merge") {
      return { decision: decisionValue, transition: null };
    }
    if (decisionValue.headSha !== pullRequest.headSha) {
      throw new Error("ready-to-merge decision is stale for the current head");
    }
    const resolved = resolveCanonicalLabels(profile.labels, pullRequest.labels);
    if (resolved.conflictingStages.length > 0 || resolved.stage === null) {
      throw new Error("ready-to-merge emission requires one current lifecycle stage");
    }
    const transition = await this.#stages.transition({
      subjectType: "pull-request",
      subjectNumber: pullRequest.number,
      expectedStage: resolved.stage,
      desiredStage: "ready-to-merge",
      executionId: null,
      operationKey: `${profile.id}:pr:${pullRequest.number}:ready:${pullRequest.headSha}`,
    });
    return { decision: decisionValue, transition };
  }
}
