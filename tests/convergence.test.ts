import { describe, expect, test } from "bun:test";
import type { ProjectProfile } from "@/contracts/project-profile.ts";
import { parseProjectProfileYaml } from "@/contracts/project-profile.ts";
import {
	assessFeedbackInvocation,
	type ConvergenceDecision,
	isSafeCheckRerunClassification,
	ReadyToMergeEmitter,
	ReviewConvergenceCoordinator,
	ReviewConvergenceEngine,
} from "@/convergence/index.ts";
import {
	assertAllowedGitHubMutation,
	CanonicalStageManager,
	type GitHubAllowedMutation,
	type GitHubCheckSnapshot,
	type GitHubLabelGateway,
	GitHubMutationExecutor,
	type GitHubProjectSnapshot,
	type GitHubPullRequestSnapshot,
	mapGitHubObservation,
	type RepositoryLabel,
} from "@/github/index.ts";
import type { ReviewBaseline, ReviewBaselineInput } from "@/ledger/index.ts";
import { FixedClockAdapter, InMemoryGitHubMutationLedger } from "@/testing/index.ts";

const profileFixture = parseProjectProfileYaml(
	await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);
const baseSnapshot = mapGitHubObservation(
	profileFixture,
	await Bun.file(new URL("fixtures/github/lumen-observation.json", import.meta.url)).json(),
);
const basePullRequest = (() => {
	const first = baseSnapshot.pullRequests[0];
	if (first === undefined) {
		throw new Error("convergence fixture has no pull request");
	}
	return first;
})();

function profile(values: Partial<ProjectProfile["timeouts"]> = {}): ProjectProfile {
	return {
		...profileFixture,
		timeouts: {
			reviewerMinutes: 45,
			requiredCheckMinutes: 90,
			quiescencePolls: 2,
			...values,
		},
	};
}

function pullRequest(values: Partial<GitHubPullRequestSnapshot> = {}): GitHubPullRequestSnapshot {
	return {
		...basePullRequest,
		labels: [profileFixture.labels.feedbackReady],
		...values,
	};
}

function snapshot(pullRequestValue: GitHubPullRequestSnapshot): GitHubProjectSnapshot {
	return { ...baseSnapshot, pullRequests: [pullRequestValue] };
}

class Baselines {
	readonly #clock: FixedClockAdapter;
	readonly #records = new Map<string, ReviewBaseline>();

	public constructor(clock: FixedClockAdapter) {
		this.#clock = clock;
	}

	public getReviewBaseline(projectId: string, pullRequestNumber: number): ReviewBaseline | null {
		return structuredClone(this.#records.get(`${projectId}:${pullRequestNumber}`) ?? null);
	}

	public saveReviewBaseline(input: ReviewBaselineInput): ReviewBaseline {
		const record: ReviewBaseline = {
			...structuredClone(input),
			updatedAt: this.#clock.now().toISOString(),
		};
		this.#records.set(`${input.projectId}:${input.pullRequestNumber}`, record);
		return structuredClone(record);
	}
}

function engine(clock = new FixedClockAdapter()): {
	readonly clock: FixedClockAdapter;
	readonly baselines: Baselines;
	readonly convergence: ReviewConvergenceEngine;
} {
	const baselines = new Baselines(clock);
	return {
		clock,
		baselines,
		convergence: new ReviewConvergenceEngine(clock, baselines),
	};
}

function evaluate(
	convergence: ReviewConvergenceEngine,
	projectProfile: ProjectProfile,
	pullRequestValue: GitHubPullRequestSnapshot,
	values: Partial<{
		headObservedAt: string;
		reviewerFailure: {
			classification: "provider-unavailable";
			reasonCode: string;
		};
		checkClassifications: Readonly<Record<string, "genuine-failure">>;
	}> = {},
): ConvergenceDecision {
	return convergence.evaluate({
		profile: projectProfile,
		snapshot: snapshot(pullRequestValue),
		pullRequestNumber: pullRequestValue.number,
		headObservedAt: values.headObservedAt ?? "2026-07-23T00:00:00.000Z",
		...(values.reviewerFailure === undefined ? {} : { reviewerFailure: values.reviewerFailure }),
		...(values.checkClassifications === undefined
			? {}
			: { checkClassifications: values.checkClassifications }),
	});
}

describe("current-head review and check timeouts", () => {
	test("rejects stale-head review completion and becomes review-stalled at the configured timeout", () => {
		const state = engine();
		const reviewProfile: ProjectProfile = {
			...profile(),
			reviewers: {
				sentinel: {
					identity: { kind: "github-user", login: "example-reviewer" },
					completionSignal: { kind: "pull-request-review" },
				},
			},
		};
		const staleReview = pullRequest({
			reviews: [
				{
					login: "example-reviewer",
					state: "APPROVED",
					submittedAt: "2026-07-23T00:01:00.000Z",
					headSha: "2222222222222222222222222222222222222222",
				},
			],
		});

		expect(evaluate(state.convergence, reviewProfile, staleReview).action).toBe(
			"wait-for-reviewers",
		);
		state.clock.advance(45 * 60_000);
		const stalled = evaluate(state.convergence, reviewProfile, staleReview);

		expect(stalled).toMatchObject({
			action: "review-stalled",
			reasons: ["sentinel"],
			preservesCodexState: true,
		});
	});

	test("accepts only a current-head review and never converts absence into approval", () => {
		const state = engine();
		const reviewProfile: ProjectProfile = {
			...profile(),
			reviewers: {
				sentinel: {
					identity: { kind: "github-user", login: "example-reviewer" },
					completionSignal: { kind: "pull-request-review" },
				},
			},
		};
		const currentReview = pullRequest({
			reviews: [
				{
					login: "example-reviewer",
					state: "APPROVED",
					submittedAt: "2026-07-23T00:01:00.000Z",
					headSha: basePullRequest.headSha,
				},
			],
		});

		expect(evaluate(state.convergence, reviewProfile, currentReview).action).toBe(
			"wait-for-quiescence",
		);
	});

	test("distinguishes required-check timeout from reviewer timeout", () => {
		const state = engine();
		const missingCheck = pullRequest({
			checks: basePullRequest.checks.filter((check) => check.name !== "verify"),
		});
		state.clock.advance(90 * 60_000);

		expect(evaluate(state.convergence, profile(), missingCheck)).toMatchObject({
			action: "check-stalled",
			reasons: ["verify"],
			preservesCodexState: true,
		});
	});

	test("opens only the reviewer circuit for a classified reviewer-provider failure", () => {
		const state = engine();
		const decision = evaluate(state.convergence, profile(), pullRequest(), {
			reviewerFailure: {
				classification: "provider-unavailable",
				reasonCode: "review-provider-unavailable",
			},
		});

		expect(decision).toMatchObject({
			action: "review-provider-unavailable",
			circuitSignal: {
				provider: "reviewer",
				classification: "provider-unavailable",
				preserveExecution: true,
			},
			preservesCodexState: true,
		});
	});
});

describe("quiescence and ready-to-merge integration", () => {
	test("requires two unchanged polls separated by 60 seconds", () => {
		const state = engine();
		const current = pullRequest();

		const initial = evaluate(state.convergence, profile(), current);
		state.clock.advance(30_000);
		const early = evaluate(state.convergence, profile(), current);
		state.clock.advance(30_000);
		const first = evaluate(state.convergence, profile(), current);
		state.clock.advance(60_000);
		const second = evaluate(state.convergence, profile(), current);

		expect(initial.quiescentPollCount).toBe(0);
		expect(early.quiescentPollCount).toBe(0);
		expect(first).toMatchObject({
			action: "wait-for-quiescence",
			quiescentPollCount: 1,
		});
		expect(second).toMatchObject({
			action: "emit-ready-to-merge",
			quiescentPollCount: 2,
		});
	});

	test("resets the unchanged-poll count when review or check observations change", () => {
		const state = engine();
		const current = pullRequest();
		evaluate(state.convergence, profile(), current);
		state.clock.advance(60_000);
		expect(evaluate(state.convergence, profile(), current).quiescentPollCount).toBe(1);

		const changed = pullRequest({
			commentCount: current.commentCount + 1,
			latestCommentAt: "2026-07-23T00:01:00.000Z",
		});
		const reset = evaluate(state.convergence, profile(), changed);

		expect(reset).toMatchObject({
			action: "wait-for-quiescence",
			reasons: ["observation-changed"],
			quiescentPollCount: 0,
		});
	});

	test("emits through the guarded stage manager and detects later head revocation", async () => {
		const state = engine();
		const current = pullRequest();
		evaluate(state.convergence, profile(), current);
		state.clock.advance(60_000);
		evaluate(state.convergence, profile(), current);
		state.clock.advance(60_000);
		const ready = evaluate(state.convergence, profile(), current);
		const gateway = new LabelGateway(current.labels);
		const executor = new GitHubMutationExecutor(
			new InMemoryGitHubMutationLedger(new FixedClockAdapter(), new MutationIds()),
			gateway,
		);
		const emitter = new ReadyToMergeEmitter(new CanonicalStageManager(profile(), executor));

		const emitted = await emitter.apply(profile(), current, ready);

		expect(emitted.transition).toMatchObject({ verified: true });
		expect(gateway.labels()).toEqual([profileFixture.labels.readyToMerge]);

		const changedHead = pullRequest({
			labels: [profileFixture.labels.readyToMerge],
			headSha: "3333333333333333333333333333333333333333",
			checks: current.checks.map((check) => ({
				...check,
				headSha: "3333333333333333333333333333333333333333",
			})),
		});
		const revoked = evaluate(state.convergence, profile(), changedHead);
		expect(revoked.action).toBe("revoke-ready-to-merge");
		expect(revoked.reasons).toContain("head");
	});

	test("production coordinator advances unchanged active-stage observations", async () => {
		const state = engine();
		const current = pullRequest({ labels: [profileFixture.labels.inProgress] });
		const gateway = new LabelGateway(current.labels);
		const executor = new GitHubMutationExecutor(
			new InMemoryGitHubMutationLedger(state.clock, new MutationIds()),
			gateway,
		);
		const coordinator = new ReviewConvergenceCoordinator({
			profiles: [profile()],
			engine: state.convergence,
			emitters: new Map([
				[
					profileFixture.id,
					new ReadyToMergeEmitter(new CanonicalStageManager(profile(), executor)),
				],
			]),
			clock: state.clock,
		});

		expect((await coordinator.reconcileProject(snapshot(current))).mutated).toBe(false);
		state.clock.advance(60_000);
		expect((await coordinator.reconcileProject(snapshot(current))).mutated).toBe(false);
		state.clock.advance(60_000);
		const ready = await coordinator.reconcileProject(snapshot(current));

		expect(ready.mutated).toBe(true);
		expect(ready.evaluations[0]?.emission.decision.action).toBe("emit-ready-to-merge");
		expect(gateway.labels()).toEqual([profileFixture.labels.readyToMerge]);
	});
});

describe("feedback bounds and safe reruns", () => {
	test("allows at most three code-changing rounds and six total invocations", () => {
		expect(
			assessFeedbackInvocation({ codeChangingRounds: 2, totalInvocations: 2 }, true),
		).toMatchObject({
			allowed: true,
			progress: { codeChangingRounds: 3, totalInvocations: 3 },
		});
		expect(
			assessFeedbackInvocation({ codeChangingRounds: 3, totalInvocations: 3 }, true),
		).toMatchObject({
			allowed: false,
			operatorHandoff: true,
			preservesCodexState: true,
			reason: "code-changing-round-limit",
		});
		expect(
			assessFeedbackInvocation({ codeChangingRounds: 3, totalInvocations: 5 }, false),
		).toMatchObject({
			allowed: true,
			progress: { codeChangingRounds: 3, totalInvocations: 6 },
		});
		expect(
			assessFeedbackInvocation({ codeChangingRounds: 3, totalInvocations: 6 }, false),
		).toMatchObject({
			allowed: false,
			operatorHandoff: true,
			preservesCodexState: true,
			reason: "total-invocation-limit",
		});
	});

	test("accepts only infrastructure, cancel, and timeout rerun classifications", () => {
		expect(
			["infrastructure", "cancel", "timeout"].map((classification) =>
				isSafeCheckRerunClassification(classification as "infrastructure" | "cancel" | "timeout"),
			),
		).toEqual([true, true, true]);
		expect(isSafeCheckRerunClassification("genuine-failure")).toBe(false);
		expect(isSafeCheckRerunClassification("unknown")).toBe(false);
	});

	test("reruns a GitHub-cancelled check but never reruns a genuinely failing check", () => {
		const cancelled: GitHubCheckSnapshot = {
			...requiredCheck(),
			conclusion: "CANCELLED",
		};
		const genuine: GitHubCheckSnapshot = {
			...requiredCheck(),
			conclusion: "FAILURE",
		};
		const cancelledState = engine();
		const genuineState = engine();

		expect(
			evaluate(
				cancelledState.convergence,
				profile(),
				pullRequest({
					checks: replaceRequiredCheck(cancelled),
				}),
			),
		).toMatchObject({
			action: "rerun-check",
			checkToRerun: "example-ci/verify",
			reasons: ["cancel"],
		});
		expect(
			evaluate(
				genuineState.convergence,
				profile(),
				pullRequest({
					checks: replaceRequiredCheck(genuine),
				}),
				{ checkClassifications: { "example-ci/verify": "genuine-failure" } },
			),
		).toMatchObject({
			action: "feedback-required",
			reasons: ["check-genuine-failure"],
			checkToRerun: null,
		});
	});
});

function requiredCheck(): GitHubCheckSnapshot {
	const check = basePullRequest.checks.find((candidate) => candidate.name === "verify");
	if (check === undefined) {
		throw new Error("fixture has no required check");
	}
	return check;
}

function replaceRequiredCheck(check: GitHubCheckSnapshot): readonly GitHubCheckSnapshot[] {
	return basePullRequest.checks.map((candidate) =>
		candidate.name === "verify" ? check : candidate,
	);
}

class MutationIds {
	#next = 0;

	public nextMutationId(): string {
		this.#next += 1;
		return `convergence-mutation-${this.#next}`;
	}
}

class LabelGateway implements GitHubLabelGateway {
	#labels: string[];

	public constructor(labels: readonly string[]) {
		this.#labels = [...labels];
	}

	public async apply(input: unknown): Promise<void> {
		const mutation = assertAllowedGitHubMutation(input);
		if (mutation.kind === "add-label") {
			this.#labels = [...new Set([...this.#labels, mutation.label])];
		} else if (mutation.kind === "remove-label") {
			this.#labels = this.#labels.filter((label) => label !== mutation.label);
		}
	}

	public async verify(input: GitHubAllowedMutation): Promise<boolean> {
		if (input.kind === "add-label") {
			return this.#labels.includes(input.label);
		}
		if (input.kind === "remove-label") {
			return !this.#labels.includes(input.label);
		}
		return false;
	}

	public async readSubjectLabels(): Promise<readonly string[]> {
		return [...this.#labels];
	}

	public async listRepositoryLabels(): Promise<readonly RepositoryLabel[]> {
		return [];
	}

	public labels(): readonly string[] {
		return [...this.#labels];
	}
}
