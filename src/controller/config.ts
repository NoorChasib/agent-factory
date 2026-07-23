import { z } from "zod";

import { ProjectProfilesSchema } from "../contracts/project-profile";

export const V1_MAXIMUM_LIMIT = 3;
export const CLAUDE_MODEL_ENVIRONMENT = "AGENT_FACTORY_CLAUDE_MODEL";
export const CLAUDE_EFFORT_ENVIRONMENT = "AGENT_FACTORY_CLAUDE_EFFORT";
export const DEFAULT_CLAUDE_MODEL = "claude-fable-5";
export const DEFAULT_CLAUDE_EFFORT = "high";

const limit = z.number().int().min(0).max(V1_MAXIMUM_LIMIT);
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

const ENVIRONMENT_LIMITS = {
  implementation: "AGENT_FACTORY_IMPLEMENTATION_LIMIT",
  feedback: "AGENT_FACTORY_FEEDBACK_LIMIT",
  readyToMerge: "AGENT_FACTORY_READY_TO_MERGE_LIMIT",
} as const;

export function parseGlobalLimitsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): GlobalLimits {
  const values = Object.fromEntries(
    Object.entries(ENVIRONMENT_LIMITS).map(([lane, name]) => {
      const raw = environment[name];
      if (raw === undefined) {
        return [lane, 1];
      }
      if (!/^[0-3]$/u.test(raw)) {
        throw new Error(`${name} must be an integer from 0 through 3`);
      }
      return [lane, Number(raw)];
    }),
  );

  return GlobalLimitsSchema.parse(values);
}

export function parseClaudeRuntimeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ClaudeRuntimeConfig {
  const model = environment[CLAUDE_MODEL_ENVIRONMENT] ?? DEFAULT_CLAUDE_MODEL;
  const effort = environment[CLAUDE_EFFORT_ENVIRONMENT] ?? DEFAULT_CLAUDE_EFFORT;
  const parsed = ClaudeRuntimeConfigSchema.safeParse({ model, effort });
  if (!parsed.success) {
    throw new Error(
      `${CLAUDE_MODEL_ENVIRONMENT} and ${CLAUDE_EFFORT_ENVIRONMENT} must select a safe model and effort (low, medium, high, or max)`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function parseControllerConfig(input: unknown): ControllerConfig {
  return ControllerConfigSchema.parse(input);
}
