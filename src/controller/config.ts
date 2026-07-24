import { z } from "zod";

import { ProjectProfilesSchema } from "@/contracts/project-profile.ts";

const limit = z.number().int().min(0);
const providerModel = z
	.string()
	.min(1)
	.max(200)
	.regex(
		/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u,
		"provider model must be one safe command-argument value",
	);

export const ClaudeRuntimeConfigSchema = z.strictObject({
	model: providerModel,
	effort: z.enum(["low", "medium", "high", "max"]),
});
export type ClaudeRuntimeConfig = z.infer<typeof ClaudeRuntimeConfigSchema>;

export const GlobalLimitsSchema = z.strictObject({
	implementation: limit,
	feedback: limit,
	readyToMerge: limit,
});

export const ControllerConfigSchema = z.strictObject({
	profiles: ProjectProfilesSchema,
	limits: GlobalLimitsSchema,
	polling: z.strictObject({
		intervalMs: z.number().int().positive().default(60_000),
		jitterRatio: z.number().min(0).max(1).default(0.1),
	}),
});

export type GlobalLimits = z.infer<typeof GlobalLimitsSchema>;
export type ControllerConfig = z.infer<typeof ControllerConfigSchema>;

export function parseControllerConfig(input: unknown): ControllerConfig {
	return ControllerConfigSchema.parse(input);
}
