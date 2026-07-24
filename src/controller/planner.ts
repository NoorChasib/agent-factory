import type { ProjectProfile } from "@/contracts/project-profile.ts";
import type { ControllerConfig } from "@/controller/config.ts";
import type {
	ConflictRepairHandoffRequest,
	ControllerLocalState,
	ExecutionRecord,
	GitHubProjectObservation,
	Lane,
	LaunchRequest,
	PlannedTransition,
	PlannerBlock,
	PlannerPlan,
} from "@/controller/model.ts";
import { assessConflictRepairInvocation, conflictRepairBudget } from "@/domain/conflict-repair.ts";
import { clampLimitsToRollout } from "@/domain/rollout.ts";
import { resolveCanonicalLabels } from "@/domain/stages.ts";

interface PlannerInput {
	readonly config: ControllerConfig;
	readonly state: ControllerLocalState;
	readonly observations: readonly GitHubProjectObservation[];
}

interface FeedbackLaunchCandidate {
	readonly pullRequest: GitHubProjectObservation["pullRequests"][number];
	readonly workflow: string;
	readonly purpose?: "conflict-repair";
}

function enabled(profile: ProjectProfile, state: ControllerLocalState): boolean {
	return state.projectEnabled[profile.id] ?? profile.enabled;
}

function effectiveLimit(
	profile: ProjectProfile,
	lane: "implementation" | "feedback" | "readyToMerge",
	limits: ControllerConfig["limits"],
): number {
	return Math.min(limits[lane], profile.ceilings?.[lane] ?? limits[lane]);
}

function valuesAfter<T>(values: readonly T[], last: T | null): readonly T[] {
	if (values.length === 0 || last === null) {
		return values;
	}
	const index = values.indexOf(last);
	if (index < 0) {
		return values;
	}
	return [...values.slice(index + 1), ...values.slice(0, index + 1)];
}

function countActive(
	executions: readonly ExecutionRecord[],
	lane: Lane,
	projectId?: string,
): number {
	return executions.filter(
		(execution) =>
			execution.status === "active" &&
			execution.lane === lane &&
			(projectId === undefined || execution.projectId === projectId),
	).length;
}

function findDuplicate(values: readonly (readonly [string, string])[]): readonly string[] {
	const owners = new Map<string, string>();
	const duplicates = new Set<string>();
	for (const [value, owner] of values) {
		const existing = owners.get(value);
		if (existing !== undefined && existing !== owner) {
			duplicates.add(`${value} (${existing}, ${owner})`);
		} else {
			owners.set(value, owner);
		}
	}
	return [...duplicates].sort();
}

function collectInvariantViolations(
	profiles: readonly ProjectProfile[],
	observations: ReadonlyMap<string, GitHubProjectObservation>,
	executions: readonly ExecutionRecord[],
): readonly string[] {
	const violations: string[] = [];

	for (const profile of profiles) {
		const observation = observations.get(profile.id);
		if (observation === undefined) {
			violations.push(`${profile.id}: missing GitHub observation`);
			continue;
		}

		const issueNumbers = findDuplicate(
			observation.issues.map((issue, index) => [String(issue.number), `observation-${index + 1}`]),
		);
		const pullRequestNumbers = findDuplicate(
			observation.pullRequests.map((pullRequest, index) => [
				String(pullRequest.number),
				`observation-${index + 1}`,
			]),
		);
		if (issueNumbers.length > 0) {
			violations.push(`${profile.id}: duplicate issue observations ${issueNumbers.join(", ")}`);
		}
		if (pullRequestNumbers.length > 0) {
			violations.push(
				`${profile.id}: duplicate pull-request observations ${pullRequestNumbers.join(", ")}`,
			);
		}

		for (const [field, associations] of [
			[
				"branch",
				observation.issues.flatMap((issue) =>
					issue.branch === null ? [] : ([[issue.branch, `issue-${issue.number}`]] as const),
				),
			],
			[
				"worktree",
				observation.issues.flatMap((issue) =>
					issue.worktreeId === null ? [] : ([[issue.worktreeId, `issue-${issue.number}`]] as const),
				),
			],
			[
				"pull request",
				observation.issues.flatMap((issue) =>
					issue.pullRequestNumber === null
						? []
						: ([[String(issue.pullRequestNumber), `issue-${issue.number}`]] as const),
				),
			],
		] as const) {
			const duplicates = findDuplicate(associations);
			if (duplicates.length > 0) {
				violations.push(
					`${profile.id}: ${field} ownership is not one-to-one: ${duplicates.join(", ")}`,
				);
			}
		}

		for (const issue of observation.issues) {
			const resolved = resolveCanonicalLabels(profile.labels, issue.labels);
			if (resolved.conflictingStages.length > 0) {
				violations.push(
					`${profile.id}: issue ${issue.number} has conflicting stages ${resolved.conflictingStages.join(", ")}`,
				);
			}
		}
		for (const pullRequest of observation.pullRequests) {
			const resolved = resolveCanonicalLabels(profile.labels, pullRequest.labels);
			if (resolved.conflictingStages.length > 0) {
				violations.push(
					`${profile.id}: pull request ${pullRequest.number} has conflicting stages ${resolved.conflictingStages.join(", ")}`,
				);
			}
			if (resolved.stage === "ready-for-feedback-agent" && pullRequest.linkedIssueNumber === null) {
				violations.push(
					`${profile.id}: feedback-ready pull request ${pullRequest.number} has no linked issue`,
				);
			}
			if (pullRequest.conflictRepairEligible === true && pullRequest.linkedIssueNumber === null) {
				violations.push(
					`${profile.id}: conflict-repair pull request ${pullRequest.number} has no linked issue`,
				);
			}
		}
	}

	const active = executions.filter((execution) => execution.status === "active");
	for (const [field, identities] of [
		[
			"issue",
			active.flatMap((execution) =>
				execution.issueNumber === null
					? []
					: ([[`${execution.projectId}:${execution.issueNumber}`, execution.executionId]] as const),
			),
		],
		[
			"pull request",
			active.flatMap((execution) =>
				execution.pullRequestNumber === null
					? []
					: ([
							[`${execution.projectId}:${execution.pullRequestNumber}`, execution.executionId],
						] as const),
			),
		],
		[
			"branch",
			active.flatMap((execution) =>
				execution.branch === null
					? []
					: ([[`${execution.projectId}:${execution.branch}`, execution.executionId]] as const),
			),
		],
		[
			"worktree",
			active.flatMap((execution) =>
				execution.worktreeId === null
					? []
					: ([[`${execution.projectId}:${execution.worktreeId}`, execution.executionId]] as const),
			),
		],
	] as const) {
		const duplicates = findDuplicate(identities);
		if (duplicates.length > 0) {
			violations.push(`active ${field} ownership is not one-to-one: ${duplicates.join(", ")}`);
		}
	}

	return violations.sort();
}

function transitionForExecution(
	execution: ExecutionRecord,
	profile: ProjectProfile,
	observation: GitHubProjectObservation,
): PlannedTransition | null {
	if (execution.issueNumber === null) {
		return null;
	}

	if (execution.lane === "implementation") {
		const issue = observation.issues.find(
			(candidate) => candidate.number === execution.issueNumber,
		);
		if (issue === undefined) {
			return {
				executionId: execution.executionId,
				kind: "release",
				reason: "external-subject-missing",
			};
		}
		if (issue.state === "closed") {
			return {
				executionId: execution.executionId,
				kind: "release",
				reason: "external-subject-closed",
			};
		}

		return transitionForObservedClaim(
			execution,
			profile,
			issue.labels,
			"ready-for-implementation-agent",
		);
	}

	if (execution.pullRequestNumber === null) {
		return {
			executionId: execution.executionId,
			kind: "release",
			reason: "external-subject-missing",
		};
	}
	const pullRequest = observation.pullRequests.find(
		(candidate) => candidate.number === execution.pullRequestNumber,
	);
	if (pullRequest === undefined) {
		return {
			executionId: execution.executionId,
			kind: "release",
			reason: "external-subject-missing",
		};
	}
	if (pullRequest.state !== "open") {
		return {
			executionId: execution.executionId,
			kind: "release",
			reason: "external-subject-closed",
		};
	}

	return transitionForObservedClaim(
		execution,
		profile,
		pullRequest.labels,
		"ready-for-feedback-agent",
	);
}

function transitionForObservedClaim(
	execution: ExecutionRecord,
	profile: ProjectProfile,
	observedLabels: readonly string[],
	awaitingVerificationStage: "ready-for-implementation-agent" | "ready-for-feedback-agent",
): PlannedTransition | null {
	const resolved = resolveCanonicalLabels(profile.labels, observedLabels);
	if (resolved.conflictingStages.length > 0) {
		return {
			executionId: execution.executionId,
			kind: "release",
			reason: "external-stage-conflict",
		};
	}
	if (resolved.stage === "in-progress" && execution.claimState !== "verified") {
		return {
			executionId: execution.executionId,
			kind: "verify-claim",
			reason: "external-claim-verified",
		};
	}
	if (
		resolved.stage !== "in-progress" &&
		(execution.claimState === "verified" ||
			(execution.claimState === "awaiting-verification" &&
				resolved.stage !== awaitingVerificationStage &&
				!(execution.purpose === "conflict-repair" && resolved.stage === null)))
	) {
		return {
			executionId: execution.executionId,
			kind: "release",
			reason: "external-stage-changed",
		};
	}
	return null;
}

function applyTransitions(
	executions: readonly ExecutionRecord[],
	transitions: readonly PlannedTransition[],
): readonly ExecutionRecord[] {
	const byExecution = new Map(
		transitions.map((transition) => [transition.executionId, transition]),
	);
	return executions.map((execution) => {
		const transition = byExecution.get(execution.executionId);
		if (transition?.kind === "release") {
			return { ...execution, status: "released" as const };
		}
		if (transition?.kind === "verify-claim") {
			return { ...execution, claimState: "verified" as const };
		}
		return execution;
	});
}

function projectHasViolation(projectId: string, violations: readonly string[]): boolean {
	return violations.some(
		(violation) => violation.startsWith(`${projectId}:`) || violation.startsWith("active "),
	);
}

function readyToMergeCount(profile: ProjectProfile, observation: GitHubProjectObservation): number {
	return observation.pullRequests.filter(
		(pullRequest) =>
			pullRequest.state === "open" &&
			resolveCanonicalLabels(profile.labels, pullRequest.labels).stage === "ready-to-merge",
	).length;
}

function eligibleImplementation(
	profile: ProjectProfile,
	observation: GitHubProjectObservation,
): boolean {
	return observation.issues.some(
		(issue) =>
			issue.state === "open" &&
			resolveCanonicalLabels(profile.labels, issue.labels).stage ===
				"ready-for-implementation-agent",
	);
}

export function buildPlannerPlan(input: PlannerInput): PlannerPlan {
	const rolloutLimits = clampLimitsToRollout(input.config.limits, input.state.rolloutStage);
	const profiles = [...input.config.profiles].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
	const observations = new Map(
		input.observations.map((observation) => [observation.projectId, observation]),
	);
	const invariantViolations = collectInvariantViolations(
		profiles,
		observations,
		input.state.executions,
	);
	const transitions = input.state.executions.flatMap((execution) => {
		if (execution.status !== "active") {
			return [];
		}
		const profile = profiles.find((candidate) => candidate.id === execution.projectId);
		const observation = observations.get(execution.projectId);
		if (profile === undefined || observation === undefined) {
			return [];
		}
		const transition = transitionForExecution(execution, profile, observation);
		return transition === null ? [] : [transition];
	});
	const executions = applyTransitions(input.state.executions, transitions);
	const launches: LaunchRequest[] = [];
	const conflictRepairHandoffs: ConflictRepairHandoffRequest[] = [];
	const blocks: PlannerBlock[] = [];
	const rotation = { ...input.state.rotation };
	const enabledProfiles = profiles.filter((profile) => enabled(profile, input.state));

	const addBlock = (block: PlannerBlock): void => {
		if (
			!blocks.some(
				(existing) =>
					existing.projectId === block.projectId &&
					existing.lane === block.lane &&
					existing.reason === block.reason,
			)
		) {
			blocks.push(block);
		}
	};

	const observationMode = input.state.mode === "observation";
	if (observationMode) {
		addBlock({ projectId: null, lane: "implementation", reason: "observation-mode" });
		addBlock({ projectId: null, lane: "feedback", reason: "observation-mode" });
	}

	const githubCircuitOpen = input.state.circuits.github.status === "open";
	if (githubCircuitOpen) {
		addBlock({ projectId: null, lane: "implementation", reason: "github-circuit-open" });
		addBlock({ projectId: null, lane: "feedback", reason: "github-circuit-open" });
	}

	const globalReadyToMerge = enabledProfiles.reduce((count, profile) => {
		const observation = observations.get(profile.id);
		return count + (observation === undefined ? 0 : readyToMergeCount(profile, observation));
	}, 0);
	const activeImplementation = countActive(executions, "implementation");
	const unverifiedClaim = executions.some(
		(execution) =>
			execution.status === "active" &&
			execution.lane === "implementation" &&
			execution.claimState !== "verified",
	);

	let implementationGloballyBlocked = observationMode || githubCircuitOpen;
	if (input.state.circuits.claude.status === "open") {
		addBlock({ projectId: null, lane: "implementation", reason: "provider-circuit-open" });
		implementationGloballyBlocked = true;
	}
	if (activeImplementation >= rolloutLimits.implementation) {
		addBlock({ projectId: null, lane: "implementation", reason: "global-limit" });
		implementationGloballyBlocked = true;
	}
	if (globalReadyToMerge >= rolloutLimits.readyToMerge) {
		addBlock({ projectId: null, lane: "implementation", reason: "global-backlog-limit" });
		implementationGloballyBlocked = true;
	}
	if (unverifiedClaim) {
		addBlock({ projectId: null, lane: "implementation", reason: "claim-in-flight" });
		implementationGloballyBlocked = true;
	}

	const implementationCandidates = enabledProfiles.filter((profile) => {
		const observation = observations.get(profile.id);
		if (observation === undefined || !eligibleImplementation(profile, observation)) {
			return false;
		}
		if (projectHasViolation(profile.id, invariantViolations)) {
			addBlock({ projectId: profile.id, lane: "implementation", reason: "invariant-violation" });
			return false;
		}
		if (
			countActive(executions, "implementation", profile.id) >=
			effectiveLimit(profile, "implementation", rolloutLimits)
		) {
			addBlock({ projectId: profile.id, lane: "implementation", reason: "project-limit" });
			return false;
		}
		if (
			readyToMergeCount(profile, observation) >=
			effectiveLimit(profile, "readyToMerge", rolloutLimits)
		) {
			addBlock({
				projectId: profile.id,
				lane: "implementation",
				reason: "project-backlog-limit",
			});
			return false;
		}
		return true;
	});

	if (!implementationGloballyBlocked && implementationCandidates.length > 0) {
		const candidateIds = new Set(implementationCandidates.map((profile) => profile.id));
		const enabledIds = enabledProfiles.map((profile) => profile.id);
		const selectedId = valuesAfter(enabledIds, input.state.rotation.implementation).find((id) =>
			candidateIds.has(id),
		);
		const selected = implementationCandidates.find((profile) => profile.id === selectedId);
		if (selected !== undefined) {
			launches.push({
				projectId: selected.id,
				lane: "implementation",
				provider: "claude",
				workflow: selected.workflow.implement,
				issueNumber: null,
				pullRequestNumber: null,
				branch: null,
				headSha: null,
			});
			rotation.implementation = selected.id;
		}
	}

	const activeFeedback = countActive(executions, "feedback");
	let feedbackCapacity = Math.max(0, rolloutLimits.feedback - activeFeedback);
	let feedbackGloballyBlocked = observationMode || githubCircuitOpen;
	if (input.state.circuits.codex.status === "open") {
		addBlock({ projectId: null, lane: "feedback", reason: "provider-circuit-open" });
		feedbackGloballyBlocked = true;
	}
	if (input.state.circuits.reviewer.status === "open") {
		addBlock({ projectId: null, lane: "feedback", reason: "provider-circuit-open" });
		feedbackGloballyBlocked = true;
	}
	if (feedbackCapacity === 0) {
		addBlock({ projectId: null, lane: "feedback", reason: "global-limit" });
		feedbackGloballyBlocked = true;
	}

	const activePullRequests = new Set(
		executions.flatMap((execution) =>
			execution.status === "active" && execution.pullRequestNumber !== null
				? [`${execution.projectId}:${execution.pullRequestNumber}`]
				: [],
		),
	);
	const unverifiedConflictRepairClaim = executions.some(
		(execution) =>
			execution.status === "active" &&
			execution.lane === "feedback" &&
			execution.claimState !== "verified" &&
			input.state.conflictRepair.invocations.some(
				(invocation) =>
					invocation.executionId === execution.executionId && invocation.status === "active",
			),
	);
	if (unverifiedConflictRepairClaim) {
		addBlock({ projectId: null, lane: "feedback", reason: "claim-in-flight" });
		feedbackGloballyBlocked = true;
	}
	const feedbackByProject = new Map<
		string,
		{
			profile: ProjectProfile;
			pullRequests: FeedbackLaunchCandidate[];
			active: number;
		}
	>();

	for (const profile of enabledProfiles) {
		const observation = observations.get(profile.id);
		if (observation === undefined) {
			continue;
		}
		if (projectHasViolation(profile.id, invariantViolations)) {
			addBlock({ projectId: profile.id, lane: "feedback", reason: "invariant-violation" });
			continue;
		}
		const active = countActive(executions, "feedback", profile.id);
		if (active >= effectiveLimit(profile, "feedback", rolloutLimits)) {
			addBlock({ projectId: profile.id, lane: "feedback", reason: "project-limit" });
			continue;
		}
		const regularPullRequests: FeedbackLaunchCandidate[] = observation.pullRequests
			.filter(
				(pullRequest) =>
					pullRequest.state === "open" &&
					pullRequest.linkedIssueNumber !== null &&
					resolveCanonicalLabels(profile.labels, pullRequest.labels).stage ===
						"ready-for-feedback-agent" &&
					!(
						profile.workflow.conflictRepair !== undefined &&
						pullRequest.mergeability === "conflicting" &&
						pullRequest.conflictRepairEligible === true
					) &&
					!activePullRequests.has(`${profile.id}:${pullRequest.number}`),
			)
			.map((pullRequest) => ({
				pullRequest,
				workflow: profile.workflow.feedback,
			}));
		const repairPullRequests: FeedbackLaunchCandidate[] = [];
		if (profile.workflow.conflictRepair !== undefined) {
			for (const pullRequest of observation.pullRequests) {
				if (
					pullRequest.state !== "open" ||
					pullRequest.linkedIssueNumber === null ||
					pullRequest.mergeability !== "conflicting" ||
					pullRequest.conflictRepairEligible !== true ||
					activePullRequests.has(`${profile.id}:${pullRequest.number}`)
				) {
					continue;
				}
				if (unverifiedConflictRepairClaim) {
					addBlock({
						projectId: profile.id,
						lane: "feedback",
						reason: "claim-in-flight",
					});
					continue;
				}
				const budgetDecision = assessConflictRepairInvocation({
					state: input.state.conflictRepair,
					projectId: profile.id,
					pullRequestNumber: pullRequest.number,
					headSha: pullRequest.headSha,
					budget: conflictRepairBudget(profile),
				});
				if (!budgetDecision.allowed) {
					addBlock({
						projectId: profile.id,
						lane: "feedback",
						reason: "conflict-repair-budget-exhausted",
					});
					const alreadyHandedOff = input.state.conflictRepair.handoffs.some(
						(handoff) =>
							handoff.projectId === profile.id &&
							handoff.pullRequestNumber === pullRequest.number &&
							handoff.headSha === pullRequest.headSha,
					);
					if (!alreadyHandedOff && !observationMode && !githubCircuitOpen) {
						conflictRepairHandoffs.push({
							projectId: profile.id,
							pullRequestNumber: pullRequest.number,
							branch: pullRequest.branch,
							headSha: pullRequest.headSha,
							executionId: budgetDecision.priorExecutionId,
							reason: budgetDecision.reason,
						});
					}
					continue;
				}
				repairPullRequests.push({
					pullRequest,
					workflow: profile.workflow.conflictRepair,
					purpose: "conflict-repair",
				});
			}
		}
		const pullRequests = [...repairPullRequests, ...regularPullRequests].sort(
			(left, right) =>
				Number(right.purpose === "conflict-repair") - Number(left.purpose === "conflict-repair") ||
				left.pullRequest.number - right.pullRequest.number,
		);
		if (pullRequests.length > 0) {
			feedbackByProject.set(profile.id, { profile, pullRequests, active });
		}
	}

	let feedbackCursor = input.state.rotation.feedback;
	while (!feedbackGloballyBlocked && feedbackCapacity > 0 && feedbackByProject.size > 0) {
		const enabledIds = enabledProfiles.map((profile) => profile.id);
		const selectedId = valuesAfter(enabledIds, feedbackCursor).find((id) =>
			feedbackByProject.has(id),
		);
		if (selectedId === undefined) {
			break;
		}
		const candidate = feedbackByProject.get(selectedId);
		if (candidate === undefined) {
			break;
		}
		if (candidate.active >= effectiveLimit(candidate.profile, "feedback", rolloutLimits)) {
			feedbackByProject.delete(selectedId);
			addBlock({ projectId: selectedId, lane: "feedback", reason: "project-limit" });
			continue;
		}
		const selected = candidate.pullRequests.shift();
		const pullRequest = selected?.pullRequest;
		if (
			selected === undefined ||
			pullRequest === undefined ||
			pullRequest.linkedIssueNumber === null
		) {
			feedbackByProject.delete(selectedId);
			continue;
		}

		launches.push({
			projectId: selectedId,
			lane: "feedback",
			provider: "codex",
			workflow: selected.workflow,
			issueNumber: pullRequest.linkedIssueNumber,
			pullRequestNumber: pullRequest.number,
			branch: pullRequest.branch,
			headSha: pullRequest.headSha,
			...(selected.purpose === undefined ? {} : { purpose: selected.purpose }),
		});
		activePullRequests.add(`${selectedId}:${pullRequest.number}`);
		candidate.active += 1;
		feedbackCapacity -= 1;
		feedbackCursor = selectedId;
		rotation.feedback = selectedId;
		if (selected.purpose === "conflict-repair") {
			feedbackCapacity = 0;
		}
		if (
			candidate.pullRequests.length === 0 ||
			candidate.active >= effectiveLimit(candidate.profile, "feedback", rolloutLimits)
		) {
			feedbackByProject.delete(selectedId);
		}
	}

	return {
		transitions,
		launches,
		conflictRepairHandoffs,
		rotation,
		blocks,
		invariantViolations,
	};
}
