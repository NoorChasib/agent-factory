import { z } from "zod";

import type { GitHubObserveOptions } from "../adapters/interfaces";
import { githubCheckName, looseGithubLogin } from "../contracts/primitives";
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
      login: looseGithubLogin,
      state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
      submittedAt: z.iso.datetime({ offset: true }).nullable(),
      headSha: z.string().nullable(),
    }),
  ),
});

const checkMarkerSchema = z.strictObject({
  checks: z.array(
    z.strictObject({
      name: githubCheckName,
      appSlug: z.string().nullable(),
      status: z.enum(["queued", "in-progress", "completed"]),
      conclusion: z.string().nullable(),
      headSha: z.string(),
    }),
  ),
});

export type ReviewObservationMarker = z.infer<typeof reviewMarkerSchema>;
export type CheckObservationMarker = z.infer<typeof checkMarkerSchema>;

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

export interface CurrentHeadRequirementAssessment {
  readonly missingReviewerIds: readonly string[];
  readonly optionalReviewMissing: boolean;
  readonly missingCheckNames: readonly string[];
  readonly failingChecks: readonly GitHubCheckSnapshot[];
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

export function buildReviewObservationMarker(
  pullRequest: GitHubPullRequestSnapshot,
): ReviewObservationMarker {
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

export function buildCheckObservationMarker(
  pullRequest: GitHubPullRequestSnapshot,
): CheckObservationMarker {
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

function baselineMarkers(baseline: ReviewBaseline | null): {
  readonly reviews: ReviewObservationMarker;
  readonly checks: CheckObservationMarker;
} | null {
  if (baseline === null) {
    return null;
  }
  const reviews = reviewMarkerSchema.safeParse(baseline.reviewObservation);
  const checks = checkMarkerSchema.safeParse(baseline.checkObservation);
  return reviews.success && checks.success ? { reviews: reviews.data, checks: checks.data } : null;
}

export function checkSucceeded(check: GitHubCheckSnapshot): boolean {
  return (
    check.status === "completed" &&
    (check.conclusion === "SUCCESS" ||
      check.conclusion === "NEUTRAL" ||
      check.conclusion === "SKIPPED")
  );
}

export function repairableCheck(check: GitHubCheckSnapshot): boolean {
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

function requiredReviewState(
  profile: ProjectProfile,
  pullRequest: GitHubPullRequestSnapshot,
): {
  readonly missingReviewerIds: readonly string[];
  readonly optionalReviewMissing: boolean;
} {
  const missingReviewerIds: string[] = [];
  for (const reviewerId of profile.reviewPolicy.required) {
    const reviewer = profile.reviewers[reviewerId];
    if (reviewer === undefined) {
      missingReviewerIds.push(reviewerId);
      continue;
    }
    if (reviewer.completionSignal.kind === "pull-request-review") {
      if (!reviewCompleted(matchingReview(pullRequest, reviewer.identity.login))) {
        missingReviewerIds.push(reviewerId);
      }
      continue;
    }
    const completionName = reviewer.completionSignal.name;
    const completion = pullRequest.checks.find(
      (check) =>
        check.name === completionName &&
        check.headSha === pullRequest.headSha &&
        checkSucceeded(check),
    );
    if (completion === undefined) {
      missingReviewerIds.push(reviewerId);
    }
  }

  const optionalLabel = profile.reviewPolicy.optionalOwnerLabel;
  let optionalReviewMissing = false;
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
      optionalReviewMissing = true;
    }
  }
  return { missingReviewerIds, optionalReviewMissing };
}

function requiredCheckState(
  profile: ProjectProfile,
  snapshot: GitHubProjectSnapshot,
  pullRequest: GitHubPullRequestSnapshot,
): {
  readonly missingCheckNames: readonly string[];
  readonly failingChecks: readonly GitHubCheckSnapshot[];
} {
  const required =
    profile.requiredChecks.source === "profile"
      ? profile.requiredChecks.checks
      : snapshot.requiredCheckNames.map((name) => ({ name }));
  const missingCheckNames: string[] = [];
  const failingChecks: GitHubCheckSnapshot[] = [];
  for (const requirement of required) {
    const check = pullRequest.checks.find(
      (candidate) =>
        candidate.name === requirement.name &&
        candidate.headSha === pullRequest.headSha &&
        ("appSlug" in requirement && requirement.appSlug !== undefined
          ? candidate.appSlug === requirement.appSlug
          : true),
    );
    if (check === undefined || !checkSucceeded(check)) {
      missingCheckNames.push(requirement.name);
    }
    if (check !== undefined && repairableCheck(check)) {
      failingChecks.push(check);
    }
  }
  for (const check of pullRequest.checks) {
    if (
      check.headSha === pullRequest.headSha &&
      repairableCheck(check) &&
      !failingChecks.includes(check)
    ) {
      failingChecks.push(check);
    }
  }
  return { missingCheckNames, failingChecks };
}

export function inspectCurrentHeadRequirements(
  profile: ProjectProfile,
  snapshot: GitHubProjectSnapshot,
  pullRequest: GitHubPullRequestSnapshot,
): CurrentHeadRequirementAssessment {
  const reviews = requiredReviewState(profile, pullRequest);
  const checks = requiredCheckState(profile, snapshot, pullRequest);
  return {
    missingReviewerIds: [...reviews.missingReviewerIds].sort(),
    optionalReviewMissing: reviews.optionalReviewMissing,
    missingCheckNames: [...checks.missingCheckNames].sort(),
    failingChecks: [...checks.failingChecks].sort((left, right) =>
      `${left.appSlug ?? ""}\u0000${left.name}`.localeCompare(
        `${right.appSlug ?? ""}\u0000${right.name}`,
      ),
    ),
  };
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
    reviewObservation: buildReviewObservationMarker(pullRequest),
    checkObservation: buildCheckObservationMarker(pullRequest),
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
  const currentReviews = buildReviewObservationMarker(pullRequest);
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
  const currentChecks = buildCheckObservationMarker(pullRequest);
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
  const requirements = inspectCurrentHeadRequirements(profile, snapshot, pullRequest);
  if (pullRequest.draft) {
    reasons.add("draft");
  }
  if (pullRequest.mergeability !== "mergeable") {
    reasons.add("mergeability");
  }
  if (pullRequest.unresolvedThreads > 0 || pullRequest.reviewDecision === "changes-requested") {
    reasons.add("feedback");
  }
  if (requirements.missingReviewerIds.length > 0 || requirements.optionalReviewMissing) {
    reasons.add("required-review");
  }
  if (requirements.missingCheckNames.length > 0 || requirements.failingChecks.length > 0) {
    reasons.add("checks");
  }
  const markers = baselineMarkers(baseline);
  if (baseline === null || markers === null || baseline.headSha !== pullRequest.headSha) {
    reasons.add("head");
  } else {
    if (stableJson(buildReviewObservationMarker(pullRequest)) !== stableJson(markers.reviews)) {
      reasons.add("feedback");
    }
    if (stableJson(buildCheckObservationMarker(pullRequest)) !== stableJson(markers.checks)) {
      reasons.add("checks");
    }
  }
  return { ready: reasons.size === 0, reasons: [...reasons].sort() };
}

export function detectReadyToMergeRevocation(
  profile: ProjectProfile,
  snapshot: GitHubProjectSnapshot,
  pullRequest: GitHubPullRequestSnapshot,
  baseline: ReviewBaseline | null,
): readonly ReadyToMergeRevocationReason[] {
  return assessReadyToMerge(profile, snapshot, pullRequest, baseline).reasons;
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
