import { z } from "zod";
import { safeId } from "./primitives";
import { WorkerResultSchema } from "./worker-result";

export const ProviderFailureClassificationSchema = z.enum([
  "account-limit",
  "authentication",
  "authorization",
  "invalid-response",
  "not-found",
  "provider-unavailable",
  "rate-limit",
  "server",
  "timeout",
  "transport",
  "usage-limit",
  "validation",
]);
export type ProviderFailureClassification = z.infer<typeof ProviderFailureClassificationSchema>;

export const ClaudeInitializationEventSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.uuid(),
  model: safeId,
  effort: z.enum(["low", "medium", "high", "max"]),
});
export type ClaudeInitializationEvent = z.infer<typeof ClaudeInitializationEventSchema>;

export const CodexThreadStartedEventSchema = z.object({
  type: z.literal("thread.started"),
  thread_id: safeId,
});
export type CodexThreadStartedEvent = z.infer<typeof CodexThreadStartedEventSchema>;

export const WorkerResultEventSchema = z.strictObject({
  type: z.literal("agent_factory.worker_result"),
  result: WorkerResultSchema,
});
export type WorkerResultEvent = z.infer<typeof WorkerResultEventSchema>;

export const ProviderFailureEventSchema = z.strictObject({
  type: z.literal("agent_factory.provider_failure"),
  classification: ProviderFailureClassificationSchema,
  reasonCode: safeId,
});
export type ProviderFailureEvent = z.infer<typeof ProviderFailureEventSchema>;

export type ProviderStructuredEvent =
  | ClaudeInitializationEvent
  | CodexThreadStartedEvent
  | ProviderFailureEvent
  | WorkerResultEvent;

export interface ProviderStructuredOutput {
  readonly events: readonly ProviderStructuredEvent[];
  readonly ignoredEventCount: number;
}

export class ProviderOutputError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderOutputError";
  }
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_LINES = 100_000;

function recordType(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const type = Reflect.get(input, "type");
  return typeof type === "string" ? type : null;
}

function isClaudeInitialization(input: unknown): boolean {
  return (
    recordType(input) === "system" &&
    typeof input === "object" &&
    input !== null &&
    Reflect.get(input, "subtype") === "init"
  );
}

function parseKnownEvent(input: unknown): ProviderStructuredEvent | null {
  const type = recordType(input);
  try {
    if (isClaudeInitialization(input)) {
      return ClaudeInitializationEventSchema.parse(input);
    }
    if (type === "thread.started") {
      return CodexThreadStartedEventSchema.parse(input);
    }
    if (type === "agent_factory.worker_result") {
      return WorkerResultEventSchema.parse(input);
    }
    if (type === "agent_factory.provider_failure") {
      return ProviderFailureEventSchema.parse(input);
    }
    return null;
  } catch (error) {
    throw new ProviderOutputError(`structured provider event '${type ?? "unknown"}' is invalid`, {
      cause: error,
    });
  }
}

export function parseProviderStructuredOutput(source: string): ProviderStructuredOutput {
  if (new TextEncoder().encode(source).byteLength > MAX_OUTPUT_BYTES) {
    throw new ProviderOutputError("structured provider output exceeds 10 MiB");
  }
  const lines = source.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length > MAX_OUTPUT_LINES) {
    throw new ProviderOutputError("structured provider output has too many records");
  }

  const events: ProviderStructuredEvent[] = [];
  let ignoredEventCount = 0;
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new ProviderOutputError(
        `structured provider output line ${index + 1} is not valid JSON`,
        { cause: error },
      );
    }
    const event = parseKnownEvent(parsed);
    if (event === null) {
      ignoredEventCount += 1;
    } else {
      events.push(event);
    }
  }
  return { events, ignoredEventCount };
}
