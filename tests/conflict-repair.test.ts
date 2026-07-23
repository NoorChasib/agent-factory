import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type ProjectProfile,
	parseProjectProfile,
	parseProjectProfileYaml,
} from "@/contracts/project-profile.ts";
import type { WorkerResult } from "@/contracts/worker-result.ts";
import type { ControllerConfig } from "@/controller/config.ts";
import { createController } from "@/controller/controller.ts";
import {
	type ControllerLocalState,
	ControllerLocalStateSchema,
	type ExecutionRecord,
	type GitHubProjectObservation,
	type GitHubPullRequestObservation,
} from "@/controller/model.ts";
import { assessFeedbackInvocation, ReviewConvergenceEngine } from "@/convergence/index.ts";
import {
	DEFAULT_CONFLICT_REPAIR_INVOCATIONS_PER_HEAD,
	DEFAULT_CONFLICT_REPAIR_INVOCATIONS_PER_PULL_REQUEST,
} from "@/domain/conflict-repair.ts";
import {
	assertAllowedGitHubMutation,
	buildCheckObservationMarker,
	buildReviewObservationMarker,
	FORBIDDEN_GITHUB_MUTATION_KINDS,
	type GitHubProjectSnapshot,
	type GitHubPullRequestSnapshot,
	isConvergedExceptConflict,
	mapGitHubObservation,
} from "@/github/index.ts";
import type { LedgerIdSource, ReviewBaseline, ReviewBaselineInput } from "@/ledger/index.ts";
import { openSqliteLedger } from "@/ledger/index.ts";
import {
	type ProviderRunRequest,
	verifyWorkerResultAgainstObservation,
} from "@/providers/index.ts";
import {
	createInitialControllerState,
	createInMemoryAdapters,
	FixedClockAdapter,
} from "@/testing/index.ts";
import { assertAllowedGitOperation, FORBIDDEN_GIT_OPERATION_KINDS } from "@/worktrees/index.ts";

const oldHead = "1111111111111111111111111111111111111111";
const newHead = "2222222222222222222222222222222222222222";

const repairProfile = parseProjectProfileYaml(
	await Bun.file(new URL("fixtures/profiles/hhc-aep.yaml", import.meta.url)).text(),
);
const disabledProfile = parseProjectProfileYaml(
	await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);
const repairWorkflow = (() => {
	const workflow = repairProfile.workflow.conflictRepair;
	if (workflow === undefined) {
		throw new Error("conflict-repair fixture did not opt in");
	}
	return workflow;
})();
const convergenceSnapshot = mapGitHubObservation(
	disabledProfile,
	await Bun.file(new URL("fixtures/github/lumen-observation.json", import.meta.url)).json(),
);
const convergencePullRequest = (() => {
	const pullRequest = convergenceSnapshot.pullRequests[0];
	if (pullRequest === undefined) {
		throw new Error("conflict-repair fixture has no pull request");
	}
	return pullRequest;
})();

function config(
	profiles: readonly ProjectProfile[],
	limits = { implementation: 3, feedback: 3, readyToMerge: 3 },
): ControllerConfig {
	return {
		profiles: [...profiles],
		limits,
		polling: { intervalMs: 60_000, jitterRatio: 0.1 },
	};
}

function repairObservation(
	profile: ProjectProfile,
	pullRequests: readonly GitHubPullRequestObservation[],
): GitHubProjectObservation {
	return {
		projectId: profile.id,
		issues: [],
		pullRequests: [...pullRequests],
	};
}

function repairPullRequest(
	profile: ProjectProfile,
	number: number,
	headSha = oldHead,
	overrides: Partial<GitHubPullRequestObservation> = {},
): GitHubPullRequestObservation {
	return {
		number,
		state: "open",
		labels: [profile.labels.inProgress],
		linkedIssueNumber: number,
		branch: `factory/issue-${number}`,
		headSha,
		mergeability: "conflicting",
		conflictRepairEligible: true,
		...overrides,
	};
}

function activeState(profiles: readonly ProjectProfile[]): ControllerLocalState {
	const state = createInitialControllerState(profiles);
	state.mode = "active";
	return state;
}

function defaultBudgetProfile(): ProjectProfile {
	const profile = structuredClone(repairProfile);
	delete profile.conflictRepair;
	profile.ceilings = { implementation: 3, feedback: 3, readyToMerge: 3 };
	return profile;
}

function completedRepairExecution(
	profile: ProjectProfile,
	executionId: string,
	pullRequestNumber: number,
	headSha: string,
): ExecutionRecord {
	if (profile.workflow.conflictRepair === undefined) {
		throw new Error("test repair profile has no repair workflow");
	}
	return {
		executionId,
		projectId: profile.id,
		lane: "feedback",
		provider: "codex",
		workflow: profile.workflow.conflictRepair,
		claimState: "verified",
		issueNumber: pullRequestNumber,
		pullRequestNumber,
		branch: `factory/issue-${pullRequestNumber}`,
		worktreeId: `${profile.id}-issue-${pullRequestNumber}`,
		headSha,
		status: "completed",
	};
}

function seedRepairInvocation(
	state: ControllerLocalState,
	profile: ProjectProfile,
	executionId: string,
	pullRequestNumber: number,
	headSha: string,
	status: "completed" | "failed" = "completed",
): void {
	state.executions.push(completedRepairExecution(profile, executionId, pullRequestNumber, headSha));
	state.conflictRepair.invocations.push({
		projectId: profile.id,
		pullRequestNumber,
		headSha,
		executionId,
		status,
	});
}

function convergedBaseline(
	pullRequest: GitHubPullRequestSnapshot,
	quiescentPollCount = disabledProfile.timeouts.quiescencePolls,
): ReviewBaseline {
	return {
		projectId: disabledProfile.id,
		pullRequestNumber: pullRequest.number,
		headSha: pullRequest.headSha,
		reviewObservation: buildReviewObservationMarker(pullRequest),
		checkObservation: buildCheckObservationMarker(pullRequest),
		quiescentPollCount,
		updatedAt: "2026-07-23T00:03:00.000Z",
	};
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
		const record = {
			...structuredClone(input),
			updatedAt: this.#clock.now().toISOString(),
		};
		this.#records.set(`${input.projectId}:${input.pullRequestNumber}`, record);
		return structuredClone(record);
	}
}

describe("conflict-repair profile contract", () => {
	test("is additive, strict, bounded, and disabled when the workflow is absent", () => {
		expect(repairProfile.workflow.conflictRepair).toBe("hhc-aep-agent-repair-conflict");
		expect(repairProfile.conflictRepair).toEqual({
			perHeadInvocations: 1,
			perPullRequestInvocations: 3,
		});
		expect(disabledProfile.workflow.conflictRepair).toBeUndefined();
		expect(disabledProfile.conflictRepair).toBeUndefined();

		expect(() =>
			parseProjectProfile({
				...repairProfile,
				conflictRepair: {
					perHeadInvocations: DEFAULT_CONFLICT_REPAIR_INVOCATIONS_PER_HEAD + 1,
					perPullRequestInvocations: DEFAULT_CONFLICT_REPAIR_INVOCATIONS_PER_PULL_REQUEST,
				},
			}),
		).toThrow();
		expect(() =>
			parseProjectProfile({
				...repairProfile,
				conflictRepair: {
					perHeadInvocations: 1,
					perPullRequestInvocations: 2,
					unknown: true,
				},
			}),
		).toThrow();

		const state = activeState([disabledProfile]);
		const { conflictRepair: _conflictRepair, ...legacyState } = state;
		expect(ControllerLocalStateSchema.parse(legacyState).conflictRepair).toEqual({
			invocations: [],
			handoffs: [],
		});
	});

	test("does not launch for an otherwise eligible target that did not opt in", async () => {
		const adapters = createInMemoryAdapters(
			[disabledProfile],
			[repairObservation(disabledProfile, [repairPullRequest(disabledProfile, 101)])],
			activeState([disabledProfile]),
		);

		await createController(config([disabledProfile]), adapters).reconcile({
			reason: "change",
		});

		expect(adapters.processes.starts).toEqual([]);
	});
});

describe("converged-except-conflict trigger", () => {
	test("covers conflicting convergence, unconverged state, unknown mergeability, and mergeable-behind state", () => {
		const conflicting = {
			...convergencePullRequest,
			labels: [disabledProfile.labels.inProgress],
			mergeability: "conflicting" as const,
		};
		const snapshot: GitHubProjectSnapshot = {
			...convergenceSnapshot,
			pullRequests: [conflicting],
		};
		expect(
			isConvergedExceptConflict(
				disabledProfile,
				snapshot,
				conflicting,
				convergedBaseline(conflicting),
			),
		).toBe(true);

		const unconverged = {
			...conflicting,
			checks: conflicting.checks.filter((check) => check.name !== "verify"),
		};
		expect(
			isConvergedExceptConflict(
				disabledProfile,
				{ ...snapshot, pullRequests: [unconverged] },
				unconverged,
				convergedBaseline(unconverged),
			),
		).toBe(false);

		for (const mergeability of ["unknown", "mergeable"] as const) {
			const pullRequest = { ...conflicting, mergeability };
			expect(
				isConvergedExceptConflict(
					disabledProfile,
					{ ...snapshot, pullRequests: [pullRequest] },
					pullRequest,
					convergedBaseline(pullRequest),
				),
			).toBe(false);
		}
	});

	test("waits for quiescence before returning the repair action", () => {
		const clock = new FixedClockAdapter();
		const baselines = new Baselines(clock);
		const engine = new ReviewConvergenceEngine(clock, baselines);
		const pullRequest = {
			...convergencePullRequest,
			labels: [disabledProfile.labels.inProgress],
			mergeability: "conflicting" as const,
		};
		const snapshot = { ...convergenceSnapshot, pullRequests: [pullRequest] };
		const evaluate = () =>
			engine.evaluate({
				profile: disabledProfile,
				snapshot,
				pullRequestNumber: pullRequest.number,
				headObservedAt: "2026-07-23T00:00:00.000Z",
			});

		expect(evaluate().action).toBe("wait-for-quiescence");
		for (let poll = 1; poll < disabledProfile.timeouts.quiescencePolls; poll += 1) {
			clock.advance(60_000);
			expect(evaluate().action).toBe("wait-for-quiescence");
		}
		clock.advance(60_000);
		expect(evaluate()).toMatchObject({
			action: "repair-conflict",
			reasons: ["mergeability-conflicting"],
			quiescentPollCount: disabledProfile.timeouts.quiescencePolls,
			preservesCodexState: true,
		});
	});

	test("a repaired head must satisfy the unchanged current-head policy before ready emission", () => {
		const clock = new FixedClockAdapter();
		const baselines = new Baselines(clock);
		const engine = new ReviewConvergenceEngine(clock, baselines);
		const staleChecks = {
			...convergencePullRequest,
			labels: [disabledProfile.labels.inProgress],
			headSha: newHead,
			mergeability: "mergeable" as const,
		};
		const evaluate = (pullRequest: GitHubPullRequestSnapshot) =>
			engine.evaluate({
				profile: disabledProfile,
				snapshot: { ...convergenceSnapshot, pullRequests: [pullRequest] },
				pullRequestNumber: pullRequest.number,
				headObservedAt: "2026-07-23T00:00:00.000Z",
			});

		expect(evaluate(staleChecks).action).toBe("wait-for-reviewers");
		const currentHead = {
			...staleChecks,
			checks: staleChecks.checks.map((check) => ({
				...check,
				headSha: newHead,
			})),
		};
		expect(evaluate(currentHead).action).toBe("wait-for-quiescence");
		let postRepair = evaluate(currentHead);
		for (let poll = 0; poll < disabledProfile.timeouts.quiescencePolls; poll += 1) {
			clock.advance(60_000);
			postRepair = evaluate(currentHead);
		}
		expect(postRepair.action).toBe("emit-ready-to-merge");
	});
});

describe("feedback-lane launch and claim gating", () => {
	test("launches one repair through the feedback lane and records the head-bound invocation", async () => {
		const adapters = createInMemoryAdapters(
			[repairProfile],
			[repairObservation(repairProfile, [repairPullRequest(repairProfile, 50)])],
			activeState([repairProfile]),
		);

		const result = await createController(config([repairProfile]), adapters).reconcile({
			reason: "change",
		});

		expect(result.startedExecutionIds).toEqual(["execution-1"]);
		expect(adapters.processes.starts).toEqual([
			{
				projectId: repairProfile.id,
				lane: "feedback",
				provider: "codex",
				workflow: repairWorkflow,
				issueNumber: 50,
				pullRequestNumber: 50,
				branch: "factory/issue-50",
				headSha: oldHead,
				purpose: "conflict-repair",
			},
		]);
		expect((await adapters.ledger.read()).state.conflictRepair.invocations).toEqual([
			{
				projectId: repairProfile.id,
				pullRequestNumber: 50,
				headSha: oldHead,
				executionId: "execution-1",
				status: "active",
			},
		]);
	});

	test("serializes repair claims and verifies in-progress before selecting the next PR", async () => {
		const profile = defaultBudgetProfile();
		const adapters = createInMemoryAdapters(
			[profile],
			[
				repairObservation(profile, [
					repairPullRequest(profile, 50),
					repairPullRequest(profile, 51),
				]),
			],
			activeState([profile]),
		);
		const controller = createController(config([profile]), adapters);

		const first = await controller.reconcile({ reason: "change" });
		const second = await controller.reconcile({ reason: "change" });

		expect(first.startedExecutionIds).toEqual(["execution-1"]);
		expect(second.verifiedExecutionIds).toEqual(["execution-1"]);
		expect(second.startedExecutionIds).toEqual(["execution-2"]);
		expect(adapters.processes.starts.map((launch) => launch.pullRequestNumber)).toEqual([50, 51]);
	});

	test("shares observation, rollout, circuit, ceiling, and one-owner gates with feedback", async () => {
		const observation = repairObservation(repairProfile, [
			repairPullRequest(repairProfile, 49, oldHead, {
				mergeability: "mergeable",
				conflictRepairEligible: false,
			}),
			repairPullRequest(repairProfile, 50),
		]);
		const cases: {
			name: string;
			state: ControllerLocalState;
			limits?: ControllerConfig["limits"];
		}[] = [];

		const observationMode = activeState([repairProfile]);
		observationMode.mode = "observation";
		cases.push({ name: "observation", state: observationMode });

		cases.push({
			name: "rollout",
			state: activeState([repairProfile]),
			limits: { implementation: 3, feedback: 0, readyToMerge: 3 },
		});

		for (const provider of ["codex", "reviewer", "github"] as const) {
			const state = activeState([repairProfile]);
			state.circuits[provider] = {
				status: "open",
				reasonCode: `${provider}-unavailable`,
			};
			cases.push({ name: `${provider}-circuit`, state });
		}

		const ceiling = activeState([repairProfile]);
		ceiling.executions.push({
			...completedRepairExecution(repairProfile, "active-feedback", 49, oldHead),
			workflow: repairProfile.workflow.feedback,
			status: "active",
		});
		cases.push({ name: "feedback-ceiling", state: ceiling });

		for (const entry of cases) {
			const adapters = createInMemoryAdapters([repairProfile], [observation], entry.state);
			await createController(config([repairProfile], entry.limits), adapters).reconcile({
				reason: "capacity",
			});
			expect(adapters.processes.starts, entry.name).toEqual([]);
		}
	});

	test("never launches a second worker for an actively owned repair PR", async () => {
		const state = activeState([repairProfile]);
		const active = completedRepairExecution(repairProfile, "repair-active", 50, oldHead);
		state.executions.push({ ...active, status: "active", claimState: "verified" });
		state.conflictRepair.invocations.push({
			projectId: repairProfile.id,
			pullRequestNumber: 50,
			headSha: oldHead,
			executionId: active.executionId,
			status: "active",
		});
		const adapters = createInMemoryAdapters(
			[repairProfile],
			[repairObservation(repairProfile, [repairPullRequest(repairProfile, 50)])],
			state,
		);

		await createController(config([repairProfile]), adapters).reconcile();

		expect(adapters.processes.starts).toEqual([]);
	});

	test("uses the attended rollout feedback cap without adding a repair-specific limit", async () => {
		const profile = defaultBudgetProfile();
		const state = activeState([profile]);
		state.rolloutStage = "stage1";
		state.executions.push({
			...completedRepairExecution(profile, "feedback-active", 49, oldHead),
			workflow: profile.workflow.feedback,
			status: "active",
		});
		const observation = repairObservation(profile, [
			repairPullRequest(profile, 49, oldHead, {
				mergeability: "mergeable",
				conflictRepairEligible: false,
			}),
			repairPullRequest(profile, 50),
		]);
		const adapters = createInMemoryAdapters([profile], [observation], state);
		const controller = createController(config([profile]), adapters);

		expect((await controller.reconcile()).startedExecutionIds).toEqual([]);
		await controller.command({ type: "set-rollout-stage", stage: "stage2" });
		expect((await controller.reconcile()).startedExecutionIds).toEqual(["execution-1"]);
	});
});

describe("separate persisted repair budgets", () => {
	test("uses defaults, resets the per-head count on a new head, and caps PR lifetime", async () => {
		const profile = defaultBudgetProfile();
		const secondAllowedState = activeState([profile]);
		seedRepairInvocation(secondAllowedState, profile, "repair-1", 50, oldHead);
		const secondAllowedAdapters = createInMemoryAdapters(
			[profile],
			[repairObservation(profile, [repairPullRequest(profile, 50)])],
			secondAllowedState,
		);
		expect(
			(await createController(config([profile]), secondAllowedAdapters).reconcile())
				.startedExecutionIds,
		).toEqual(["execution-1"]);

		const perHead = activeState([profile]);
		seedRepairInvocation(perHead, profile, "repair-1", 50, oldHead);
		seedRepairInvocation(perHead, profile, "repair-2", 50, oldHead);
		const exhaustedAdapters = createInMemoryAdapters(
			[profile],
			[repairObservation(profile, [repairPullRequest(profile, 50)])],
			perHead,
		);
		const exhausted = await createController(config([profile]), exhaustedAdapters).reconcile();

		expect(exhausted.startedExecutionIds).toEqual([]);
		expect(exhausted.conflictRepairHandoffExecutionIds).toEqual(["repair-2"]);
		expect(exhaustedAdapters.processes.conflictRepairHandoffs[0]).toMatchObject({
			reason: "per-head-limit",
			headSha: oldHead,
		});

		const resetState = activeState([profile]);
		seedRepairInvocation(resetState, profile, "repair-1", 50, oldHead);
		seedRepairInvocation(resetState, profile, "repair-2", 50, oldHead);
		const resetAdapters = createInMemoryAdapters(
			[profile],
			[repairObservation(profile, [repairPullRequest(profile, 50, newHead)])],
			resetState,
		);
		expect(
			(await createController(config([profile]), resetAdapters).reconcile()).startedExecutionIds,
		).toEqual(["execution-1"]);

		const lifetimeState = activeState([profile]);
		for (let index = 1; index <= 4; index += 1) {
			seedRepairInvocation(
				lifetimeState,
				profile,
				`lifetime-${index}`,
				50,
				index.toString(16).repeat(40),
			);
		}
		const lifetimeAdapters = createInMemoryAdapters(
			[profile],
			[repairObservation(profile, [repairPullRequest(profile, 50, "5".repeat(40))])],
			lifetimeState,
		);
		await createController(config([profile]), lifetimeAdapters).reconcile();
		expect(lifetimeAdapters.processes.conflictRepairHandoffs[0]).toMatchObject({
			reason: "per-pull-request-limit",
			executionId: "lifetime-4",
		});
	});

	test("honors a lower profile limit and hands off immediately after worker failure", async () => {
		const lowered = activeState([repairProfile]);
		seedRepairInvocation(lowered, repairProfile, "repair-lowered", 50, oldHead);
		const loweredAdapters = createInMemoryAdapters(
			[repairProfile],
			[repairObservation(repairProfile, [repairPullRequest(repairProfile, 50)])],
			lowered,
		);
		await createController(config([repairProfile]), loweredAdapters).reconcile();
		expect(loweredAdapters.processes.conflictRepairHandoffs[0]?.reason).toBe("per-head-limit");

		const failed = activeState([repairProfile]);
		seedRepairInvocation(failed, repairProfile, "repair-failed", 50, oldHead, "failed");
		const failedAdapters = createInMemoryAdapters(
			[repairProfile],
			[repairObservation(repairProfile, [repairPullRequest(repairProfile, 50)])],
			failed,
		);
		await createController(config([repairProfile]), failedAdapters).reconcile();
		expect(failedAdapters.processes.conflictRepairHandoffs[0]?.reason).toBe("worker-failure");
	});

	test("persists counters in the existing ledger state without consuming feedback budgets", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-factory-conflict-repair-"));
		const ids: LedgerIdSource = {
			nextId: (kind) => `${kind}-conflict-repair`,
		};
		try {
			const ledger = openSqliteLedger({
				stateDirectory: directory,
				instanceId: "conflict-repair-controller",
				clock: new FixedClockAdapter(),
				ids,
				initialState: activeState([repairProfile]),
			});
			try {
				const snapshot = await ledger.read();
				const state = structuredClone(snapshot.state);
				seedRepairInvocation(state, repairProfile, "persisted-repair", 50, oldHead);
				await ledger.commit(snapshot.revision, state);

				expect((await ledger.read()).state.conflictRepair.invocations).toMatchObject([
					{
						executionId: "persisted-repair",
						headSha: oldHead,
						status: "completed",
					},
				]);
				expect(ledger.schemaVersion).toBe(4);
				expect(
					assessFeedbackInvocation({ codeChangingRounds: 0, totalInvocations: 0 }, true),
				).toMatchObject({
					allowed: true,
					progress: { codeChangingRounds: 1, totalInvocations: 1 },
				});
			} finally {
				ledger.close();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("repair outcome and mutation safety", () => {
	const repairRequest: ProviderRunRequest = {
		executionId: "repair-execution",
		checkout: {
			path: "/factory/worktrees/pr-101",
			projectId: disabledProfile.id,
			repository: disabledProfile.repository,
			defaultBranch: disabledProfile.defaultBranch,
			workflow: "notes/repair-conflict",
		},
		issueNumber: 11,
		pullRequestNumber: 101,
		purpose: "conflict-repair",
		branch: "factory/issue-11",
		initialHeadSha: oldHead,
	};
	const result: WorkerResult = {
		schemaVersion: 1,
		executionId: repairRequest.executionId,
		target: {
			projectId: disabledProfile.id,
			repository: disabledProfile.repository,
		},
		issue: { number: 11 },
		pullRequest: { number: 101 },
		branch: {
			name: "factory/issue-11",
			base: disabledProfile.defaultBranch,
			headSha: newHead,
			pushed: true,
		},
		providerSession: { provider: "codex", id: "repair-thread" },
		checkpoint: {
			phase: "verification",
			sequence: 1,
			code: "repair-observed",
		},
		terminalStatus: "completed",
	};

	function outcomeObservation(
		headSha: string,
		mergeability: "mergeable" | "conflicting" | "unknown",
	): GitHubProjectObservation {
		return {
			projectId: disabledProfile.id,
			issues: [
				{
					number: 11,
					state: "open",
					labels: [],
					branch: "factory/issue-11",
					worktreeId: "lumen-notes-issue-11",
					pullRequestNumber: 101,
				},
			],
			pullRequests: [
				{
					number: 101,
					state: "open",
					labels: [disabledProfile.labels.inProgress],
					linkedIssueNumber: 11,
					branch: "factory/issue-11",
					headSha,
					mergeability,
				},
			],
		};
	}

	test("requires a newly observed head that no longer reports conflicting", () => {
		expect(
			verifyWorkerResultAgainstObservation({
				request: repairRequest,
				provider: "codex",
				providerSessionId: "repair-thread",
				result,
				observation: outcomeObservation(newHead, "mergeable"),
			}),
		).toEqual({ accepted: true, reasons: [] });
		expect(
			verifyWorkerResultAgainstObservation({
				request: repairRequest,
				provider: "codex",
				providerSessionId: "repair-thread",
				result,
				observation: outcomeObservation(newHead, "unknown"),
			}),
		).toEqual({ accepted: true, reasons: [] });

		expect(
			verifyWorkerResultAgainstObservation({
				request: repairRequest,
				provider: "codex",
				providerSessionId: "repair-thread",
				result: {
					...result,
					branch: { ...result.branch, headSha: oldHead },
				},
				observation: outcomeObservation(oldHead, "mergeable"),
			}),
		).toEqual({
			accepted: false,
			reasons: ["repair-head-unchanged"],
		});
		expect(
			verifyWorkerResultAgainstObservation({
				request: repairRequest,
				provider: "codex",
				providerSessionId: "repair-thread",
				result,
				observation: outcomeObservation(newHead, "conflicting"),
			}),
		).toEqual({
			accepted: false,
			reasons: ["repair-still-conflicting"],
		});
	});

	test("does not add a controller path for any forbidden Git or GitHub mutation", () => {
		for (const kind of FORBIDDEN_GIT_OPERATION_KINDS) {
			expect(() => assertAllowedGitOperation({ kind })).toThrow();
		}
		for (const kind of FORBIDDEN_GITHUB_MUTATION_KINDS) {
			expect(() => assertAllowedGitHubMutation({ kind })).toThrow();
		}
		expect(FORBIDDEN_GIT_OPERATION_KINDS).toEqual(
			expect.arrayContaining(["rebase", "force-push", "amend", "merge", "push"]),
		);
		expect(FORBIDDEN_GITHUB_MUTATION_KINDS).toEqual(
			expect.arrayContaining(["rebase", "force-push", "amend", "merge", "push"]),
		);
	});
});

describe("multi-project repair isolation", () => {
	test("uses only the opted-in fixture workflow and keeps the other target inert", async () => {
		const adapters = createInMemoryAdapters(
			[repairProfile, disabledProfile],
			[
				repairObservation(repairProfile, [repairPullRequest(repairProfile, 50)]),
				repairObservation(disabledProfile, [repairPullRequest(disabledProfile, 50)]),
			],
			activeState([repairProfile, disabledProfile]),
		);

		await createController(config([repairProfile, disabledProfile]), adapters).reconcile({
			reason: "change",
		});

		expect(adapters.processes.starts).toHaveLength(1);
		expect(adapters.processes.starts[0]).toMatchObject({
			projectId: repairProfile.id,
			workflow: repairProfile.workflow.conflictRepair,
			purpose: "conflict-repair",
		});
		expect(
			(await adapters.ledger.read()).state.conflictRepair.invocations.map(
				(invocation) => invocation.projectId,
			),
		).toEqual([repairProfile.id]);
	});
});
