import { z } from "zod";

import {
	gitObjectId,
	looseBranch,
	looseLabelName,
	projectId,
	safeId,
	workflowEntryPoint,
} from "@/contracts/primitives.ts";
import { ConflictRepairStateSchema } from "@/domain/conflict-repair.ts";

const issueNumber = z.number().int().positive();

export const LaneSchema = z.enum(["implementation", "feedback"]);
export const ProviderSchema = z.enum(["claude", "codex", "github", "reviewer"]);
export const ControllerModeSchema = z.enum(["observation", "active"]);
export const RolloutStageSchema = z.enum(["observation", "stage1", "stage2", "stage3"]);
export const CircuitStatusSchema = z.enum(["closed", "open"]);
export const ClaimStateSchema = z.enum(["selecting", "awaiting-verification", "verified"]);
export const ExecutionStatusSchema = z.enum(["active", "completed", "released"]);

export type Lane = z.infer<typeof LaneSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type ControllerMode = z.infer<typeof ControllerModeSchema>;
export type RolloutStage = z.infer<typeof RolloutStageSchema>;
export type CircuitStatus = z.infer<typeof CircuitStatusSchema>;
export type ClaimState = z.infer<typeof ClaimStateSchema>;

export const ExecutionRecordSchema = z
	.strictObject({
		executionId: safeId,
		projectId,
		lane: LaneSchema,
		provider: z.enum(["claude", "codex"]),
		workflow: workflowEntryPoint,
		purpose: z.literal("conflict-repair").optional(),
		claimState: ClaimStateSchema,
		issueNumber: issueNumber.nullable(),
		pullRequestNumber: issueNumber.nullable(),
		branch: looseBranch.nullable(),
		worktreeId: safeId.nullable(),
		headSha: gitObjectId.nullable(),
		status: ExecutionStatusSchema,
	})
	.superRefine((execution, context) => {
		const expectedProvider = execution.lane === "implementation" ? "claude" : "codex";
		if (execution.provider !== expectedProvider) {
			context.addIssue({
				code: "custom",
				path: ["provider"],
				message: `${execution.lane} executions must use provider ${expectedProvider}`,
			});
		}
		if (execution.claimState === "selecting" && execution.issueNumber !== null) {
			context.addIssue({
				code: "custom",
				path: ["claimState"],
				message: "a selecting execution must not have a claimed issue",
			});
		}
		if (execution.claimState !== "selecting" && execution.issueNumber === null) {
			context.addIssue({
				code: "custom",
				path: ["issueNumber"],
				message: "a claimed execution must identify its issue",
			});
		}
		if (
			execution.lane === "feedback" &&
			(execution.issueNumber === null || execution.pullRequestNumber === null)
		) {
			context.addIssue({
				code: "custom",
				path: ["pullRequestNumber"],
				message: "a feedback execution must identify one issue and pull request",
			});
		}
		if (execution.pullRequestNumber !== null && execution.issueNumber === null) {
			context.addIssue({
				code: "custom",
				path: ["issueNumber"],
				message: "a pull-request execution must identify its linked issue",
			});
		}
	});

export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

export const GitHubIssueObservationSchema = z.strictObject({
	number: issueNumber,
	state: z.enum(["open", "closed"]),
	labels: z.array(looseLabelName),
	branch: looseBranch.nullable(),
	worktreeId: safeId.nullable(),
	pullRequestNumber: issueNumber.nullable(),
});

export const GitHubPullRequestObservationSchema = z.strictObject({
	number: issueNumber,
	state: z.enum(["open", "closed", "merged"]),
	labels: z.array(looseLabelName),
	linkedIssueNumber: issueNumber.nullable(),
	branch: looseBranch,
	headSha: gitObjectId,
	mergedAt: z.iso.datetime({ offset: true }).nullable().optional(),
	mergeability: z.enum(["mergeable", "conflicting", "unknown"]).optional(),
	conflictRepairEligible: z.boolean().optional(),
});

export const GitHubProjectObservationSchema = z.strictObject({
	projectId,
	issues: z.array(GitHubIssueObservationSchema),
	pullRequests: z.array(GitHubPullRequestObservationSchema),
});

export type GitHubIssueObservation = z.infer<typeof GitHubIssueObservationSchema>;
export type GitHubPullRequestObservation = z.infer<typeof GitHubPullRequestObservationSchema>;
export type GitHubProjectObservation = z.infer<typeof GitHubProjectObservationSchema>;

const circuit = z.strictObject({
	status: CircuitStatusSchema,
	reasonCode: safeId.nullable(),
});

export const ControllerLocalStateSchema = z.strictObject({
	mode: ControllerModeSchema,
	rolloutStage: RolloutStageSchema.default("observation"),
	projectEnabled: z.record(projectId, z.boolean()),
	rotation: z.strictObject({
		implementation: projectId.nullable(),
		feedback: projectId.nullable(),
	}),
	circuits: z.strictObject({
		claude: circuit,
		codex: circuit,
		github: circuit,
		reviewer: circuit,
	}),
	executions: z.array(ExecutionRecordSchema),
	conflictRepair: ConflictRepairStateSchema,
});

export type ControllerLocalState = z.infer<typeof ControllerLocalStateSchema>;

export interface LedgerSnapshot {
	readonly revision: number;
	readonly state: ControllerLocalState;
}

export interface LaunchRequest {
	readonly projectId: string;
	readonly lane: Lane;
	readonly provider: "claude" | "codex";
	readonly workflow: string;
	readonly issueNumber: number | null;
	readonly pullRequestNumber: number | null;
	readonly branch: string | null;
	readonly headSha: string | null;
	readonly purpose?: "conflict-repair";
}

export interface ConflictRepairHandoffRequest {
	readonly projectId: string;
	readonly pullRequestNumber: number;
	readonly branch: string;
	readonly headSha: string;
	readonly executionId: string;
	readonly reason: "per-head-limit" | "per-pull-request-limit" | "worker-failure";
}

export interface StopRequest {
	readonly executionId: string;
	readonly reason:
		| "external-subject-closed"
		| "external-stage-changed"
		| "external-subject-missing"
		| "external-stage-conflict";
}

export type PlannedTransition =
	| {
			readonly executionId: string;
			readonly kind: "verify-claim";
			readonly reason: "external-claim-verified";
	  }
	| {
			readonly executionId: string;
			readonly kind: "release";
			readonly reason:
				| "external-subject-closed"
				| "external-stage-changed"
				| "external-subject-missing"
				| "external-stage-conflict";
	  };

export interface PlannerBlock {
	readonly projectId: string | null;
	readonly lane: Lane;
	readonly reason:
		| "observation-mode"
		| "global-limit"
		| "project-limit"
		| "global-backlog-limit"
		| "project-backlog-limit"
		| "claim-in-flight"
		| "provider-circuit-open"
		| "github-circuit-open"
		| "invariant-violation"
		| "conflict-repair-budget-exhausted";
}

export interface PlannerPlan {
	readonly transitions: readonly PlannedTransition[];
	readonly launches: readonly LaunchRequest[];
	readonly conflictRepairHandoffs: readonly ConflictRepairHandoffRequest[];
	readonly rotation: Readonly<ControllerLocalState["rotation"]>;
	readonly blocks: readonly PlannerBlock[];
	readonly invariantViolations: readonly string[];
}
