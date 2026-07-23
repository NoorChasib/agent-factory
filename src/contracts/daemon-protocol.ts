import { z } from "zod";

const safeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u);
const projectId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);

export const AgentFactoryOperationSchema = z.union([
  z.strictObject({ operation: z.literal("status") }),
  z.strictObject({ operation: z.literal("workers") }),
  z.strictObject({ operation: z.literal("show"), executionId: safeId }),
  z.strictObject({
    operation: z.literal("logs"),
    lines: z.number().int().min(1).max(10_000).default(200),
  }),
  z.strictObject({ operation: z.literal("pause") }),
  z.strictObject({ operation: z.literal("resume") }),
  z.strictObject({ operation: z.literal("drain") }),
  z.strictObject({
    operation: z.literal("worker"),
    action: z.enum(["attach", "takeover", "resume", "release", "stop", "kill"]),
    executionId: safeId,
  }),
  z.strictObject({ operation: z.literal("circuits") }),
  z.strictObject({
    operation: z.literal("project"),
    action: z.enum(["list", "validate"]),
    projectId: projectId.optional(),
  }),
  z.strictObject({
    operation: z.literal("project"),
    action: z.enum(["enable", "disable"]),
    projectId,
  }),
  z.strictObject({
    operation: z.literal("config"),
    action: z.enum(["list", "validate"]),
  }),
  z.strictObject({
    operation: z.literal("rollout"),
    action: z.enum(["status", "promote", "demote"]),
  }),
  z.strictObject({
    operation: z.literal("labels"),
    action: z.enum(["plan", "preview"]),
    projectId,
  }),
  z.strictObject({
    operation: z.literal("labels"),
    action: z.literal("apply"),
    projectId,
    hash,
  }),
  z.strictObject({
    operation: z.literal("update"),
    action: z.literal("status"),
  }),
  z.strictObject({
    operation: z.literal("update"),
    action: z.literal("queue"),
    releaseId: safeId,
  }),
  z.strictObject({ operation: z.literal("doctor-live") }),
  z.strictObject({ operation: z.literal("reconcile") }),
  z.strictObject({
    operation: z.literal("notifications"),
    action: z.enum(["test", "digest"]),
  }),
  z.strictObject({
    operation: z.literal("shutdown"),
    whenIdle: z.literal(true),
  }),
]);

export type AgentFactoryOperation = z.infer<typeof AgentFactoryOperationSchema>;

export const DAEMON_PROTOCOL_VERSION = 1 as const;

export const DaemonRequestSchema = z.strictObject({
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  requestId: safeId,
  request: AgentFactoryOperationSchema,
});
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;

const responseBase = z.strictObject({
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  requestId: safeId,
});

export const DaemonResponseSchema = z.discriminatedUnion("ok", [
  responseBase.extend({
    ok: z.literal(true),
    result: z.json(),
  }),
  responseBase.extend({
    ok: z.literal(false),
    error: z.strictObject({
      code: safeId,
      message: z.string().min(1).max(2_000),
    }),
  }),
]);
export type DaemonResponse = z.infer<typeof DaemonResponseSchema>;

export function parseDaemonRequest(input: unknown): DaemonRequest {
  return DaemonRequestSchema.parse(input);
}

export function parseDaemonResponse(input: unknown): DaemonResponse {
  return DaemonResponseSchema.parse(input);
}
