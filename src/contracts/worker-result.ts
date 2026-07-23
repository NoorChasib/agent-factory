import { z } from "zod";

import { gitBranch, gitObjectId, projectId, repository, safeId } from "@/contracts/primitives.ts";

export const WorkerTerminalStatusSchema = z.enum([
	"completed",
	"blocked",
	"operator_required",
	"provider_limit",
	"stalled",
	"failed",
]);

export const WorkerResultSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		executionId: safeId,
		target: z.strictObject({
			projectId,
			repository,
		}),
		issue: z.strictObject({
			number: z.number().int().positive(),
		}),
		pullRequest: z
			.strictObject({
				number: z.number().int().positive(),
			})
			.nullable(),
		branch: z.strictObject({
			name: gitBranch,
			base: gitBranch,
			headSha: gitObjectId.nullable(),
			pushed: z.boolean(),
		}),
		providerSession: z.strictObject({
			provider: z.enum(["claude", "codex"]),
			id: safeId,
		}),
		checkpoint: z.strictObject({
			phase: safeId,
			sequence: z.number().int().nonnegative(),
			code: safeId,
		}),
		terminalStatus: WorkerTerminalStatusSchema,
	})
	.superRefine((result, context) => {
		if (result.branch.pushed && result.branch.headSha === null) {
			context.addIssue({
				code: "custom",
				path: ["branch", "headSha"],
				message: "a pushed branch must identify its head commit",
			});
		}
		if (result.pullRequest !== null && (!result.branch.pushed || result.branch.headSha === null)) {
			context.addIssue({
				code: "custom",
				path: ["pullRequest"],
				message: "a pull request requires a pushed branch and head commit",
			});
		}
	});

export type WorkerTerminalStatus = z.infer<typeof WorkerTerminalStatusSchema>;
export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export function parseWorkerResult(input: unknown): WorkerResult {
	return WorkerResultSchema.parse(input);
}
