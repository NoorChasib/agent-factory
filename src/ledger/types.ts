import { z } from "zod";

import { CircuitStatusSchema, ExecutionRecordSchema, ProviderSchema } from "../controller/model";

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
const timestamp = z.iso.datetime({ offset: true });
const issueNumber = z.number().int().positive();
const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const nonEmptyText = z.string().min(1).max(500);

export const AttemptStatusSchema = z.enum([
  "active",
  "completed",
  "blocked",
  "operator-required",
  "provider-limit",
  "stalled",
  "failed",
  "released",
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

export const MutationStateSchema = z.enum(["pending", "applied", "reconciled", "ambiguous"]);
export type MutationState = z.infer<typeof MutationStateSchema>;

export const MaintenanceKindSchema = z.enum(["pause", "resume", "drain", "shutdown-when-idle"]);
export type MaintenanceKind = z.infer<typeof MaintenanceKindSchema>;

export const MaintenanceStatusSchema = z.enum(["pending", "active", "completed", "cancelled"]);
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>;

export const ReleaseStatusSchema = z.enum([
  "installed",
  "queued",
  "candidate",
  "failed",
  "rolled-back",
]);
export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;

export const ExecutionAttemptSchema = z.strictObject({
  executionId: safeId,
  attemptNumber: z.number().int().positive(),
  status: AttemptStatusSchema,
  startedAt: timestamp,
  finishedAt: timestamp.nullable(),
  checkpoint: safeId.nullable(),
  outcome: safeId.nullable(),
  reasonCode: safeId.nullable(),
});
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;

export const NewExecutionAttemptSchema = ExecutionAttemptSchema.omit({
  attemptNumber: true,
  startedAt: true,
}).extend({
  status: AttemptStatusSchema.default("active"),
});
export type NewExecutionAttempt = z.input<typeof NewExecutionAttemptSchema>;

export const ProviderSessionSchema = z.strictObject({
  sessionKey: safeId,
  executionId: safeId,
  attemptNumber: z.number().int().positive(),
  provider: z.enum(["claude", "codex"]),
  providerSessionId: safeId,
  model: nonEmptyText,
  reasoningEffort: nonEmptyText,
  runtimeMetadata: z.unknown(),
  createdAt: timestamp,
  lastResumedAt: timestamp.nullable(),
});
export type ProviderSession = z.infer<typeof ProviderSessionSchema>;

export const NewProviderSessionSchema = ProviderSessionSchema.omit({
  sessionKey: true,
  createdAt: true,
  lastResumedAt: true,
});
export type NewProviderSession = z.infer<typeof NewProviderSessionSchema>;

export const ProcessMetadataSchema = z.strictObject({
  executionId: safeId,
  attemptNumber: z.number().int().positive().nullable(),
  paneId: safeId.nullable(),
  processId: z.number().int().positive().nullable(),
  processStartedAt: timestamp.nullable(),
  hostIdentity: safeId.nullable(),
  runtimeMetadata: z.unknown(),
  updatedAt: timestamp,
});
export type ProcessMetadata = z.infer<typeof ProcessMetadataSchema>;

export const ProcessMetadataInputSchema = ProcessMetadataSchema.omit({ updatedAt: true });
export type ProcessMetadataInput = z.infer<typeof ProcessMetadataInputSchema>;

export const MutationRecordSchema = z.strictObject({
  mutationId: safeId,
  projectId,
  executionId: safeId.nullable(),
  kind: safeId,
  subjectType: z.enum(["issue", "pull-request", "repository"]),
  subjectNumber: issueNumber.nullable(),
  intendedMutation: z.unknown(),
  idempotencyKey: z.string().min(1).max(500),
  state: MutationStateSchema,
  result: z.unknown().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type MutationRecord = z.infer<typeof MutationRecordSchema>;

export const NewMutationSchema = MutationRecordSchema.omit({
  mutationId: true,
  state: true,
  result: true,
  createdAt: true,
  updatedAt: true,
});
export type NewMutation = z.infer<typeof NewMutationSchema>;

export const ReviewBaselineSchema = z.strictObject({
  projectId,
  pullRequestNumber: issueNumber,
  headSha: gitObjectId,
  reviewObservation: z.unknown(),
  checkObservation: z.unknown(),
  quiescentPollCount: z.number().int().nonnegative(),
  updatedAt: timestamp,
});
export type ReviewBaseline = z.infer<typeof ReviewBaselineSchema>;

export const ReviewBaselineInputSchema = ReviewBaselineSchema.omit({ updatedAt: true });
export type ReviewBaselineInput = z.infer<typeof ReviewBaselineInputSchema>;

export const ProviderCircuitRecordSchema = z.strictObject({
  provider: ProviderSchema,
  status: CircuitStatusSchema,
  reasonCode: safeId.nullable(),
  openedAt: timestamp.nullable(),
  updatedAt: timestamp,
});
export type ProviderCircuitRecord = z.infer<typeof ProviderCircuitRecordSchema>;

export const MaintenanceRequestSchema = z.strictObject({
  requestId: safeId,
  kind: MaintenanceKindSchema,
  status: MaintenanceStatusSchema,
  reasonCode: safeId.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type MaintenanceRequest = z.infer<typeof MaintenanceRequestSchema>;

export const NewMaintenanceRequestSchema = MaintenanceRequestSchema.omit({
  requestId: true,
  createdAt: true,
  updatedAt: true,
});
export type NewMaintenanceRequest = z.infer<typeof NewMaintenanceRequestSchema>;

export const ReleaseRecordSchema = z.strictObject({
  releaseId: safeId,
  commitSha: gitObjectId,
  status: ReleaseStatusSchema,
  artifactPath: z.string().min(1).max(4_096).nullable(),
  requiredSchemaVersion: z.number().int().positive(),
  metadata: z.unknown(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type ReleaseRecord = z.infer<typeof ReleaseRecordSchema>;

export const NewReleaseRecordSchema = ReleaseRecordSchema.omit({
  createdAt: true,
  updatedAt: true,
});
export type NewReleaseRecord = z.infer<typeof NewReleaseRecordSchema>;

export const AuditEventSchema = z.strictObject({
  sequence: z.number().int().positive(),
  timestamp,
  kind: safeId,
  payload: z.unknown(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const ExecutionRecoverySchema = z.strictObject({
  execution: ExecutionRecordSchema,
  attempts: z.array(ExecutionAttemptSchema),
  sessions: z.array(ProviderSessionSchema),
  process: ProcessMetadataSchema.nullable(),
});
export type ExecutionRecovery = z.infer<typeof ExecutionRecoverySchema>;

export interface LedgerIdSource {
  nextId(kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session"): string;
}

export interface LedgerOwner {
  readonly instanceId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface LedgerPragmas {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
}
