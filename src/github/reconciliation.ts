import { z } from "zod";

import type { GitHubObserveOptions } from "../adapters/interfaces";
import type { ProjectProfile } from "../contracts/project-profile";
import { resolveCanonicalLabels } from "../domain/stages";
import type { ReviewBaseline, ReviewBaselineInput } from "../ledger";
import type {
  GitHubCheckSnapshot,
  GitHubProjectSnapshot,
  GitHubPullRequestSnapshot,
  GitHubReviewSnapshot,
} from "./observation";
import type { CanonicalStageManager, StageTransitionResult } from "./stages";

const reviewMarkerSchema = z.strictObject({
  commentCount: z.number().int().nonnegative(),
  latestCommentAt: z.iso.datetime({ offset: true }).nullable(),
  unresolvedThreads: z.number().int().nonnegative(),
  reviews: z.array(
    z.strictObject({
      login: z.string().min(1).max(100),
      state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
      submittedAt: z.iso.datetime({ offset: true }).nullable(),
      headSha: z.string().nullable(),
    }),
  ),
});

const checkMarkerSchema = z.strictObject({
  checks: z.array(
    z.strictObject({
      name: z.string().min(1).max(255),
      appSlug: z.string().nullable(),
      status: z.enum(["queued", "in-progress", "completed"]),
      conclusion: z.string().nullable(),
      headSha: z.string(),
    }),
  ),
});

type ReviewMarker = z.infer<typeof reviewMarkerSchema>;
type CheckMarker = z.infer<typeof checkMarkerSchema>;

export type LateFeedbackReason =
  | "comments-changed"
  | "head-changed"
  | "repairable-check"
  | "reviews-changed";

export type ReadyToMergeRevocationReason =
  | "checks"
  | "draft"
  | "feedback"
  | "head"
  | "mergeability"
  | "required-review";

export interface ConvergenceAssessment {
  readonly ready: boolean;
  readonly reasons: readonly ReadyToMergeRevocationReason[];
}

export interface GitHubReviewBaselineRepository {
  getReviewBaseline(projectId: string, pullRequestNumber: number): ReviewBaseline | null;
  saveReviewBaseline(input: ReviewBaselineInput): ReviewBaseline;
}

export interface LifecycleReconcileResult {
  readonly projectId: string;
  readonly transitions: readonly {
    readonly pullRequestNumber: number;
    readonly action: "requeue-feedback" | "revoke-ready-to-merge";
    readonly reasons: readonly string[];
    readonly result: StageTransitionResult;
  }[];
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function reviewMarker(pullRequest: GitHubPullRequestSnapshot): ReviewMarker {
  return {
    commentCount: pullRequest.commentCount,
    latestCommentAt: pullRequest.latestCommentAt,
    unresolvedThreads: pullRequest.unresolvedThreads,
    reviews: pullRequest.reviews.map((review) => ({
      login: review.login,
      state: review.state,
      submittedAt: review.submittedAt,
      headSha: review.headSha,
    })),
  };
}

function checkMarker(pullRequest: GitHubPullRequestSnapshot): CheckMarker {
  return {
    checks: pullRequest.checks.map((check) => ({
      name: check.name,
      appSlug: check.appSlug,
      status: check.status,
      conclusion: check.conclusion,
      headSha: check.headSha,
    })),
  };
}

function baselineMarkers(
  baseline: ReviewBaseline | null,
): { readonly reviews: ReviewMarker; readonly checks: CheckMarker } | null {
  if (baseline === null) {
    return null;
  }
  const reviews = reviewMarkerSchema.safeParse(baseline.reviewObservation);
  const checks = checkMarkerSchema.safeParse(baseline.checkObservation);
  return reviews.success && checks.success ? { reviews: reviews.data, checks: checks.data } : null;
}

function checkSucceeded(check: GitHubCheckSnapshot): boolean {
  return (
    check.status === "completed" &&
    (check.conclusion === "SUCCESS" ||
      check.conclusion === "NEUTRAL" ||
      check.conclusion === "SKIPPED")
  );
}

function repairableCheck(check: GitHubCheckSnapshot): boolean {
  return (
    check.status === "completed" &&
    (check.conclusion === "ACTION_REQUIRED" ||
      check.conclusion === "CANCELLED" ||
      check.conclusion === "FAILURE" ||
      check.conclusion === "STARTUP_FAILURE" ||
      check.conclusion === "TIMED_OUT" ||
      check.conclusion === "ERROR")
  );
}

function matchingReview(
  pullRequest: GitHubPullRequestSnapshot,
  login: string,
): GitHubReviewSnapshot | undefined {
  return [...pullRequest.reviews]
    .reverse()
    .find(
      (review) =>
        review.login.toLowerCase() === login.toLowerCase() &&
        review.headSha === pullRequest.headSha,
    );
}

function reviewCompleted(review: GitHubReviewSnapshot | undefined): boolean {
  return review?.state === "APPROVED" || review?.state === "COMMENTED";
}

function requiredReviewComplete(
  profile: ProjectProfile,
  pullRequest: GitHubPullRequestSnapshot,
): boolean {
  for (const reviewerId of profile.reviewPolicy.required) {
    const reviewer = profile.reviewers[reviewerId];
    if (reviewer === undefined) {
      return false;
    }
    if (reviewer.completionSignal.kind === "pull-request-review") {
      if (!reviewCompleted(matchingReview(pullRequest, reviewer.identity.login))) {
        return false;
      }
      continue;
    }
    const completionName = reviewer.completionSignal.name;
    const completion = pullRequest.checks.find(
      (check) => check.name === completionName && check.headSha === pullRequest.headSha,
    );
    if (completion === undefined || !checkSucceeded(completion)) {
      return false;
    }
  }

  const optionalLabel = profile.reviewPolicy.optionalOwnerLabel;
  if (optionalLabel !== undefined && pullRequest.labels.includes(optionalLabel)) {
    const requiredLogins = new Set(
      profile.reviewPolicy.required.flatMap((reviewerId) => {
        const reviewer = profile.reviewers[reviewerId];
        return reviewer === undefined ? [] : [reviewer.identity.login.toLowerCase()];
      }),
    );
    const optionalReview = pullRequest.reviews.find(
      (review) =>
        review.headSha === pullRequest.headSha &&
        !requiredLogins.has(review.login.toLowerCase()) &&
        reviewCompleted(review),
    );
    if (optionalReview === undefined) {
      return false;
    }
  }
  return true;
}

function requiredChecksComplete(
  profile: ProjectProfile,
  snapshot: GitHubProjectSnapshot,
  pullRequest: GitHubPullRequestSnapshot,
): boolean {
  const required =
    profile.requiredChecks.source === "profile"
      ? profile.requiredChecks.checks
      : snapshot.requiredCheckNames.map((name) => ({ name }));
  return required.every((requirement) => {
    const check = pullRequest.checks.find(
      (candidate) =>
        candidate.name === requirement.name &&
        ("appSlug" in requirement && requirement.appSlug !== undefined
          ? candidate.appSlug === requirement.appSlug
          : true),
    );
    return check !== undefined && check.headSha === pullRequest.headSha && checkSucceeded(check);
  });
}

export function captureFeedbackBaseline(
  repository: GitHubReviewBaselineRepository,
  projectId: string,
  pullRequest: GitHubPullRequestSnapshot,
): ReviewBaseline {
  return repository.saveReviewBaseline({
    projectId,
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    reviewObservation: reviewMarker(pullRequest),
    checkObservation: checkMarker(pullRequest),
    quiescentPollCount: 0,
  });
}

export function detectLateFeedback(
  pullRequest: GitHubPullRequestSnapshot,
  baseline: ReviewBaseline | null,
): readonly LateFeedbackReason[] {
  const markers = baselineMarkers(baseline);
  if (baseline === null || markers === null) {
    return [];
  }
  const reasons: LateFeedbackReason[] = [];
  if (baseline.headSha !== pullRequest.headSha) {
    reasons.push("head-changed");
  }
  const currentReviews = reviewMarker(pullRequest);
  if (
    currentReviews.commentCount !== markers.reviews.commentCount ||
    currentReviews.latestCommentAt !== markers.reviews.latestCommentAt
  ) {
    reasons.push("comments-changed");
  }
  if (
    currentReviews.unresolvedThreads !== markers.reviews.unresolvedThreads ||
    stableJson(currentReviews.reviews) !== stableJson(markers.reviews.reviews)
  ) {
    reasons.push("reviews-changed");
  }
  const currentChecks = checkMarker(pullRequest);
  if (
    stableJson(currentChecks) !== stableJson(markers.checks) &&
    pullRequest.checks.some(repairableCheck)
  ) {
    reasons.push("repairable-check");
  }
  return reasons;
}

export function assessReadyToMerge(
  profile: ProjectProfile,
  snapshot: GitHubProjectSnapshot,
  pullRequest: GitHubPullRequestSnapshot,
  baseline: ReviewBaseline | null,
): ConvergenceAssessment {
  const reasons = new Set<ReadyToMergeRevocationReason>();
  if (pullRequest.draft) {
    reasons.add("draft");
  }
  if (pullRequest.mergeability !== "mergeable") {
    reasons.add("mergeability");
  }
  if (pullRequest.unresolvedThreads > 0 || pullRequest.reviewDecision === "changes-requested") {
    reasons.add("feedback");
  }
  if (!requiredReviewComplete(profile, pullRequest)) {
    reasons.add("required-review");
  }
  if (
    !requiredChecksComplete(profile, snapshot, pullRequest) ||
    pullRequest.checks.some(repairableCheck)
  ) {
    reasons.add("checks");
  }
  const markers = baselineMarkers(baseline);
  if (baseline === null || markers === null || baseline.headSha !== pullRequest.headSha) {
    reasons.add("head");
  } else {
    if (stableJson(reviewMarker(pullRequest)) !== stableJson(markers.reviews)) {
      reasons.add("feedback");
    }
    if (stableJson(checkMarker(pullRequest)) !== stableJson(markers.checks)) {
      reasons.add("checks");
    }
  }
  return { ready: reasons.size === 0, reasons: [...reasons].sort() };
}

export function shouldFullyReconcile(
  reason: GitHubObserveOptions["reason"],
  observationChanged: boolean,
): boolean {
  return (
    observationChanged ||
    reason === "startup" ||
    reason === "change" ||
    reason === "capacity" ||
    reason === "recovery" ||
    reason === "operator"
  );
}

export class GitHubLifecycleReconciler {
  readonly #profiles: ReadonlyMap<string, ProjectProfile>;
  readonly #stages: ReadonlyMap<string, CanonicalStageManager>;
  readonly #baselines: GitHubReviewBaselineRepository;

  public constructor(
    profiles: readonly ProjectProfile[],
    stages: ReadonlyMap<string, CanonicalStageManager>,
    baselines: GitHubReviewBaselineRepository,
  ) {
    this.#profiles = new Map(profiles.map((profile) => [profile.id, profile]));
    this.#stages = stages;
    this.#baselines = baselines;
  }

  public async reconcileProject(
    snapshot: GitHubProjectSnapshot,
    activeFeedbackPullRequests: ReadonlySet<number>,
  ): Promise<LifecycleReconcileResult> {
    const profile = this.#profiles.get(snapshot.projectId);
    const stages = this.#stages.get(snapshot.projectId);
    if (profile === undefined || stages === undefined) {
      throw new Error(`lifecycle reconciliation targeted unknown project '${snapshot.projectId}'`);
    }
    const transitions: LifecycleReconcileResult["transitions"][number][] = [];
    for (const pullRequest of snapshot.pullRequests) {
      if (pullRequest.state !== "open") {
        continue;
      }
      const resolved = resolveCanonicalLabels(profile.labels, pullRequest.labels);
      if (resolved.conflictingStages.length > 0) {
        continue;
      }
      const baseline = this.#baselines.getReviewBaseline(profile.id, pullRequest.number);
      const lateFeedback = detectLateFeedback(pullRequest, baseline);
      const assessment = assessReadyToMerge(profile, snapshot, pullRequest, baseline);
      const active = activeFeedbackPullRequests.has(pullRequest.number);

      if (resolved.stage === "ready-to-merge" && !assessment.ready) {
        const requeue =
          !active &&
          (lateFeedback.length > 0 ||
            assessment.reasons.includes("feedback") ||
            pullRequest.checks.some(repairableCheck));
        const result = requeue
          ? await stages.transition({
              subjectType: "pull-request",
              subjectNumber: pullRequest.number,
              expectedStage: "ready-to-merge",
              desiredStage: "ready-for-feedback-agent",
              executionId: null,
              operationKey: `${profile.id}:pr:${pullRequest.number}:revoke-ready:${pullRequest.headSha}`,
            })
          : await stages.revokeReadyToMerge({
              pullRequestNumber: pullRequest.number,
              operationKey: `${profile.id}:pr:${pullRequest.number}:revoke-ready:${pullRequest.headSha}`,
            });
        transitions.push({
          pullRequestNumber: pullRequest.number,
          action: requeue ? "requeue-feedback" : "revoke-ready-to-merge",
          reasons: assessment.reasons,
          result,
        });
        if (!result.verified) {
          break;
        }
        continue;
      }

      if (
        !active &&
        lateFeedback.length > 0 &&
        resolved.stage !== "ready-for-feedback-agent" &&
        resolved.stage !== "in-progress"
      ) {
        const result = await stages.transition({
          subjectType: "pull-request",
          subjectNumber: pullRequest.number,
          expectedStage: resolved.stage,
          desiredStage: "ready-for-feedback-agent",
          executionId: null,
          operationKey: `${profile.id}:pr:${pullRequest.number}:late-feedback:${pullRequest.headSha}`,
        });
        transitions.push({
          pullRequestNumber: pullRequest.number,
          action: "requeue-feedback",
          reasons: lateFeedback,
          result,
        });
        if (!result.verified) {
          break;
        }
      }
    }
    return { projectId: profile.id, transitions };
  }
}
