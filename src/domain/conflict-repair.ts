import { z } from "zod";
import { gitObjectId, projectId, safeId } from "@/contracts/primitives.ts";
import type { ProjectProfile } from "@/contracts/project-profile.ts";

export const DEFAULT_CONFLICT_REPAIR_INVOCATIONS_PER_HEAD = 2;
export const DEFAULT_CONFLICT_REPAIR_INVOCATIONS_PER_PULL_REQUEST = 4;

export const ConflictRepairInvocationSchema = z.strictObject({
	projectId,
	pullRequestNumber: z.number().int().positive(),
	headSha: gitObjectId,
	executionId: safeId,
	status: z.enum(["active", "completed", "failed"]),
});

export type ConflictRepairInvocation = z.infer<typeof ConflictRepairInvocationSchema>;

export const ConflictRepairHandoffSchema = z.strictObject({
	projectId,
	pullRequestNumber: z.number().int().positive(),
	headSha: gitObjectId,
	executionId: safeId,
	reason: z.enum(["per-head-limit", "per-pull-request-limit", "worker-failure"]),
});

export type ConflictRepairHandoff = z.infer<typeof ConflictRepairHandoffSchema>;

export const ConflictRepairStateSchema = z
	.strictObject({
		invocations: z.array(ConflictRepairInvocationSchema),
		handoffs: z.array(ConflictRepairHandoffSchema),
	})
	.superRefine((state, context) => {
		const executionIds = state.invocations.map((invocation) => invocation.executionId);
		if (new Set(executionIds).size !== executionIds.length) {
			context.addIssue({
				code: "custom",
				path: ["invocations"],
				message: "conflict-repair invocation execution ids must be unique",
			});
		}
		const handoffHeads = state.handoffs.map(
			(handoff) => `${handoff.projectId}\u0000${handoff.pullRequestNumber}\u0000${handoff.headSha}`,
		);
		if (new Set(handoffHeads).size !== handoffHeads.length) {
			context.addIssue({
				code: "custom",
				path: ["handoffs"],
				message: "conflict-repair handoffs must be unique per pull-request head",
			});
		}
		for (const handoff of state.handoffs) {
			if (
				!state.invocations.some(
					(invocation) =>
						invocation.executionId === handoff.executionId &&
						invocation.projectId === handoff.projectId &&
						invocation.pullRequestNumber === handoff.pullRequestNumber,
				)
			) {
				context.addIssue({
					code: "custom",
					path: ["handoffs"],
					message: "conflict-repair handoff must reference a repair invocation",
				});
			}
		}
	})
	.default(() => ({ invocations: [], handoffs: [] }));

export type ConflictRepairState = z.infer<typeof ConflictRepairStateSchema>;

export interface ConflictRepairBudget {
	readonly perHeadInvocations: number;
	readonly perPullRequestInvocations: number;
}

export type ConflictRepairBudgetDecision =
	| {
			readonly allowed: true;
			readonly perHeadInvocations: number;
			readonly perPullRequestInvocations: number;
	  }
	| {
			readonly allowed: false;
			readonly perHeadInvocations: number;
			readonly perPullRequestInvocations: number;
			readonly reason: "per-head-limit" | "per-pull-request-limit" | "worker-failure";
			readonly priorExecutionId: string;
	  };

export function conflictRepairBudget(profile: ProjectProfile): ConflictRepairBudget {
	return {
		perHeadInvocations:
			profile.conflictRepair?.perHeadInvocations ?? DEFAULT_CONFLICT_REPAIR_INVOCATIONS_PER_HEAD,
		perPullRequestInvocations:
			profile.conflictRepair?.perPullRequestInvocations ??
			DEFAULT_CONFLICT_REPAIR_INVOCATIONS_PER_PULL_REQUEST,
	};
}

export function assessConflictRepairInvocation(input: {
	readonly state: ConflictRepairState;
	readonly projectId: string;
	readonly pullRequestNumber: number;
	readonly headSha: string;
	readonly budget: ConflictRepairBudget;
}): ConflictRepairBudgetDecision {
	const invocations = input.state.invocations.filter(
		(invocation) =>
			invocation.projectId === input.projectId &&
			invocation.pullRequestNumber === input.pullRequestNumber,
	);
	const headInvocations = invocations.filter((invocation) => invocation.headSha === input.headSha);
	const failed = [...headInvocations]
		.reverse()
		.find((invocation) => invocation.status === "failed");
	if (failed !== undefined) {
		return {
			allowed: false,
			perHeadInvocations: headInvocations.length,
			perPullRequestInvocations: invocations.length,
			reason: "worker-failure",
			priorExecutionId: failed.executionId,
		};
	}
	const latest = invocations.at(-1);
	if (invocations.length >= input.budget.perPullRequestInvocations && latest !== undefined) {
		return {
			allowed: false,
			perHeadInvocations: headInvocations.length,
			perPullRequestInvocations: invocations.length,
			reason: "per-pull-request-limit",
			priorExecutionId: latest.executionId,
		};
	}
	const latestHead = headInvocations.at(-1);
	if (headInvocations.length >= input.budget.perHeadInvocations && latestHead !== undefined) {
		return {
			allowed: false,
			perHeadInvocations: headInvocations.length,
			perPullRequestInvocations: invocations.length,
			reason: "per-head-limit",
			priorExecutionId: latestHead.executionId,
		};
	}
	return {
		allowed: true,
		perHeadInvocations: headInvocations.length,
		perPullRequestInvocations: invocations.length,
	};
}
