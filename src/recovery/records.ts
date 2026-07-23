import { z } from "zod";

import { gitObjectId, projectId, recoveryGitBranch, safeId } from "../contracts/primitives";
import type { AuditEvent } from "../ledger";
import { DEFAULT_REDACTION_BOUNDARY, type RedactionBoundary } from "../redaction";
import { RecoveryReasonCodeSchema } from "./reason-codes";

const recoverableText = z.string().max(16_384).nullable();

export const RecoveryRecordSchema = z.strictObject({
  projectAlias: projectId,
  executionId: safeId,
  subject: z.strictObject({
    kind: z.enum(["issue", "pull-request"]),
    number: z.number().int().positive(),
  }),
  branch: recoverableText,
  commit: recoverableText,
  pane: recoverableText,
  providerSessionId: recoverableText,
  checkpoint: recoverableText,
  reasonCode: RecoveryReasonCodeSchema,
});

export type RecoveryRecord = z.infer<typeof RecoveryRecordSchema>;

function inlineValue(
  value: string | null,
  redaction: RedactionBoundary,
  schema: z.ZodType<string>,
): string {
  if (value === null) {
    return "none";
  }
  const sanitized = [...redaction.sanitizeText(value)]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
    })
    .join("")
    .replaceAll("`", "'")
    .trim();
  if (sanitized.length === 0) {
    return "none";
  }
  const markers = sanitized.match(/\[REDACTED(?:_[A-Z_]+)?\]/gu);
  if (markers !== null) {
    return [...new Set(markers)].join(" ");
  }
  return schema.parse(sanitized);
}

function recoveryCommands(executionId: string): readonly string[] {
  return [
    `agent-factory worker show ${executionId}`,
    `agent-factory worker attach ${executionId}`,
    `agent-factory worker takeover ${executionId}`,
    `agent-factory worker resume ${executionId}`,
    `agent-factory worker release ${executionId}`,
  ];
}

function assertSentinelFree(body: string, redaction: RedactionBoundary): void {
  const sentinels = redaction.scan(body);
  if (sentinels.length > 0) {
    throw new Error(`recovery renderer emitted sensitive sentinels: ${sentinels.join(", ")}`);
  }
}

function renderRecord(
  heading: string,
  input: unknown,
  redaction: RedactionBoundary,
  includeMarker: boolean,
): string {
  const record = RecoveryRecordSchema.parse(input);
  const subject = `${record.subject.kind} #${record.subject.number}`;
  const fields = [
    ["Project", record.projectAlias],
    ["Execution", record.executionId],
    ["Subject", subject],
    ["Branch", inlineValue(record.branch, redaction, recoveryGitBranch)],
    ["Commit", inlineValue(record.commit, redaction, gitObjectId)],
    ["Pane", inlineValue(record.pane, redaction, safeId)],
    ["Provider session", inlineValue(record.providerSessionId, redaction, safeId)],
    ["Checkpoint", inlineValue(record.checkpoint, redaction, safeId)],
    ["Reason", record.reasonCode],
  ] as const;
  const lines = [
    ...(includeMarker ? [`<!-- agent-factory:recovery:${record.executionId} -->`] : []),
    `## ${heading}`,
    "",
    ...fields.map(([label, value]) => `- ${label}: \`${value}\``),
    "",
    "### Recovery commands",
    "",
    "```sh",
    ...recoveryCommands(record.executionId),
    "```",
  ];
  const body = lines.join("\n");
  assertSentinelFree(body, redaction);
  return body;
}

export function renderRecoveryComment(
  input: unknown,
  redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
): string {
  return renderRecord("Agent Factory recovery", input, redaction, true);
}

export function renderStallIncident(
  input: unknown,
  redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
): string {
  return renderRecord("Agent Factory stall incident", input, redaction, false);
}

export interface RecoveryIncidentRepository {
  appendAudit(kind: string, payload: unknown): AuditEvent;
}

export interface StallIncident {
  readonly body: string;
  readonly auditEvent: AuditEvent;
}

export class StallIncidentRecorder {
  readonly #repository: RecoveryIncidentRepository;
  readonly #redaction: RedactionBoundary;

  public constructor(
    repository: RecoveryIncidentRepository,
    redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
  ) {
    this.#repository = repository;
    this.#redaction = redaction;
  }

  public append(input: unknown): StallIncident {
    const body = renderStallIncident(input, this.#redaction);
    return {
      body,
      auditEvent: this.#repository.appendAudit("stall-incident", { body }),
    };
  }
}
