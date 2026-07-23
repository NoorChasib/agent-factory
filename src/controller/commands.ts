import { z } from "zod";

import { CircuitStatusSchema, ControllerModeSchema, ProviderSchema } from "./model";

const projectId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);

export const ControllerCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("set-mode"),
    mode: ControllerModeSchema,
  }),
  z.strictObject({
    type: z.literal("set-project-enabled"),
    projectId,
    enabled: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("set-provider-circuit"),
    provider: ProviderSchema,
    status: CircuitStatusSchema,
    reasonCode: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u)
      .nullable(),
  }),
]);

export const ReconcileRequestSchema = z.strictObject({
  reason: z
    .enum(["startup", "poll", "change", "capacity", "recovery", "operator"])
    .default("operator"),
});

export type ControllerCommand = z.infer<typeof ControllerCommandSchema>;
export type ReconcileRequest = z.infer<typeof ReconcileRequestSchema>;
