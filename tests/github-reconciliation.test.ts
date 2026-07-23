import { describe, expect, test } from "bun:test";
import type { ProjectProfile } from "../src/contracts/project-profile";
import { parseProjectProfileYaml } from "../src/contracts/project-profile";
import {
	assertAllowedGitHubMutation,
	assessReadyToMerge,
	CanonicalStageManager,
	captureFeedbackBaseline,
	detectLateFeedback,
	type GitHubAllowedMutation,
	type GitHubLabelGateway,
	GitHubLifecycleReconciler,
	GitHubMutationExecutor,
	type GitHubProjectSnapshot,
	type GitHubPullRequestSnapshot,
	mapGitHubObservation,
	type ReadyToMergeRevocationReason,
	type RepositoryLabel,
	shouldFullyReconcile,
} from "../src/github";
import type { ReviewBaseline, ReviewBaselineInput } from "../src/ledger";
import { FixedClockAdapter, InMemoryGitHubMutationLedger } from "../src/testing";

const profile = parseProjectProfileYaml(
	await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);
const observationFixture = await Bun.file(
	new URL("fixtures/github/lumen-observation.json", import.meta.url),
).json();
const baseSnapshot = mapGitHubObservation(profile, observationFixture);
const basePullRequest = (() => {
	const pullRequest = baseSnapshot.pullRequests[0];
	if (pullRequest === undefined) {
		throw new Error("lumen observation fixture has no pull request");
	}
	return pullRequest;
})();

class Baselines {
	readonly #records = new Map<string, ReviewBaseline>();

	public getReviewBaseline(projectId: string, pullRequestNumber: number): ReviewBaseline | null {
		return structuredClone(this.#records.get(`${projectId}:${pullRequestNumber}`) ?? null);
	}

	public saveReviewBaseline(input: ReviewBaselineInput): ReviewBaseline {
		const record: ReviewBaseline = {
			...structuredClone(input),
			updatedAt: "2026-07-23T00:06:00.000Z",
		};
		this.#records.set(`${input.projectId}:${input.pullRequestNumber}`, record);
		return structuredClone(record);
	}
}

class Ids {
	#next = 1;

	public nextMutationId(): string {
		const id = `lifecycle-${this.#next}`;
		this.#next += 1;
		return id;
	}
}

class LifecycleGateway implements GitHubLabelGateway {
	#labels: string[];
	public readonly mutations: GitHubAllowedMutation[] = [];

	public constructor(labels: readonly string[]) {
		this.#labels = [...labels];
	}

	public async apply(input: unknown): Promise<void> {
		const mutation = assertAllowedGitHubMutation(input);
		this.mutations.push(mutation);
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

function withPullRequest(pullRequest: GitHubPullRequestSnapshot): GitHubProjectSnapshot {
	return {
		...baseSnapshot,
		pullRequests: [pullRequest],
	};
}

function lifecycle(
	projectProfile: ProjectProfile,
	baselines: Baselines,
	labels: readonly string[],
) {
	const gateway = new LifecycleGateway(labels);
	const executor = new GitHubMutationExecutor(
		new InMemoryGitHubMutationLedger(new FixedClockAdapter(), new Ids()),
		gateway,
	);
	const stages = new CanonicalStageManager(projectProfile, executor);
	return {
		gateway,
		reconciler: new GitHubLifecycleReconciler(
			[projectProfile],
			new Map([[projectProfile.id, stages]]),
			baselines,
		),
	};
}

describe("late feedback and revocable ready-to-merge", () => {
	test("detects later comments and re-adds feedback-ready after the worker exits", async () => {
		const baselines = new Baselines();
		const baseline = captureFeedbackBaseline(baselines, profile.id, basePullRequest);
		const changedPullRequest: GitHubPullRequestSnapshot = {
			...basePullRequest,
			commentCount: 2,
			latestCommentAt: "2026-07-23T00:07:00Z",
		};
		expect(detectLateFeedback(changedPullRequest, baseline)).toEqual(["comments-changed"]);
		const state = lifecycle(profile, baselines, [profile.labels.readyToMerge]);

		const result = await state.reconciler.reconcileProject(
			withPullRequest(changedPullRequest),
			new Set(),
		);

		expect(result.transitions).toHaveLength(1);
		expect(result.transitions[0]).toMatchObject({
			pullRequestNumber: 101,
			action: "requeue-feedback",
		});
		expect(state.gateway.labels()).toEqual([profile.labels.feedbackReady]);
		expect(state.gateway.mutations.map((mutation) => mutation.kind)).toEqual([
			"add-label",
			"remove-label",
		]);
	});

	test("recognizes every immediate ready-to-merge revocation trigger", () => {
		const baselines = new Baselines();
		const baseline = captureFeedbackBaseline(baselines, profile.id, basePullRequest);
		expect(assessReadyToMerge(profile, baseSnapshot, basePullRequest, baseline)).toEqual({
			ready: true,
			reasons: [],
		});

		const cases: readonly {
			readonly reason: ReadyToMergeRevocationReason;
			readonly pullRequest: GitHubPullRequestSnapshot;
		}[] = [
			{
				reason: "head",
				pullRequest: {
					...basePullRequest,
					headSha: "3333333333333333333333333333333333333333",
				},
			},
			{
				reason: "feedback",
				pullRequest: {
					...basePullRequest,
					unresolvedThreads: 1,
				},
			},
			{
				reason: "checks",
				pullRequest: {
					...basePullRequest,
					checks: basePullRequest.checks.map((check) =>
						check.name === "verify" ? { ...check, conclusion: "FAILURE" as const } : check,
					),
				},
			},
			{
				reason: "mergeability",
				pullRequest: {
					...basePullRequest,
					mergeability: "conflicting",
				},
			},
			{
				reason: "required-review",
				pullRequest: {
					...basePullRequest,
					checks: basePullRequest.checks.filter((check) => check.name !== "automated-review"),
				},
			},
		];

		for (const fixture of cases) {
			const assessment = assessReadyToMerge(
				profile,
				withPullRequest(fixture.pullRequest),
				fixture.pullRequest,
				baseline,
			);
			expect(assessment.ready).toBe(false);
			expect(assessment.reasons).toContain(fixture.reason);
		}
	});

	test("revokes ready-to-merge without inventing feedback when mergeability alone changes", async () => {
		const baselines = new Baselines();
		captureFeedbackBaseline(baselines, profile.id, basePullRequest);
		const conflicting: GitHubPullRequestSnapshot = {
			...basePullRequest,
			mergeability: "conflicting",
		};
		const state = lifecycle(profile, baselines, [profile.labels.readyToMerge]);

		const result = await state.reconciler.reconcileProject(withPullRequest(conflicting), new Set());

		expect(result.transitions[0]).toMatchObject({
			action: "revoke-ready-to-merge",
			reasons: ["mergeability"],
		});
		expect(state.gateway.labels()).toEqual([]);
		expect(state.gateway.mutations).toMatchObject([
			{
				kind: "remove-label",
				projectId: profile.id,
				label: profile.labels.readyToMerge,
			},
		]);
	});

	test("uses conditional polls but forces full reconciliation for all required triggers", () => {
		expect(shouldFullyReconcile("poll", false)).toBe(false);
		expect(shouldFullyReconcile("poll", true)).toBe(true);
		for (const reason of ["startup", "change", "capacity", "recovery", "operator"] as const) {
			expect(shouldFullyReconcile(reason, false)).toBe(true);
		}
		expect(shouldFullyReconcile("status", false)).toBe(false);
	});
});
