import { z } from "zod";

import { ProjectProfilesSchema } from "../contracts/project-profile";

export const V1_MAXIMUM_LIMIT = 3;

const limit = z.number().int().min(0).max(V1_MAXIMUM_LIMIT);

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

export function parseControllerConfig(input: unknown): ControllerConfig {
  return ControllerConfigSchema.parse(input);
}
