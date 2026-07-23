import type { Notification, NotificationAdapter } from "../adapters/interfaces";

export type RedactedJson =
  | boolean
  | null
  | number
  | string
  | readonly RedactedJson[]
  | { readonly [key: string]: RedactedJson };

export interface RedactionBoundary {
  sanitize(input: unknown): RedactedJson;
  sanitizeText(input: string): string;
  scan(input: string): readonly RedactionSentinel[];
}

export interface StructuredRedactionOptions {
  readonly environmentValues?: readonly string[];
  readonly maximumStringLength?: number;
}

export type RedactionSentinel =
  | "absolute-path"
  | "bearer-credential"
  | "environment-value"
  | "github-token"
  | "pem-block";

const FORBIDDEN_KEY = /(?:token|secret|password|private.?key|credential|prompt|pem)/iu;
const ABSOLUTE_PATH = /(^|[^A-Za-z0-9/])(\/(?!\/)(?:[^\s)"'`,;\]}]|\\ )*)/gu;
const GITHUB_TOKEN = /\b(?:gh[psuor]_|github_pat_)[A-Za-z0-9_=-]{4,}\b/giu;
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/giu;
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/gu;
const DEFAULT_MAXIMUM_STRING_LENGTH = 4_096;

export type PlainJsonErrorFactory = (message: string) => Error;

export function plainJsonValue(
  input: unknown,
  errorFactory: PlainJsonErrorFactory = (message) => new Error(`redaction input ${message}`),
): RedactedJson {
  const normalize = (candidate: unknown, path: string, seen: Set<object>): RedactedJson => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw errorFactory(`contains a non-finite number at ${path}`);
      }
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw errorFactory(`contains an unsupported value at ${path}`);
    }
    if (seen.has(candidate)) {
      throw errorFactory(`contains a cycle at ${path}`);
    }
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map((value, index) => normalize(value, `${path}[${index}]`, seen));
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw errorFactory(`contains a non-plain object at ${path}`);
      }
      const result: Record<string, RedactedJson> = {};
      for (const key of Object.keys(candidate).sort()) {
        result[key] = normalize(
          (candidate as Record<string, unknown>)[key],
          `${path}.${key}`,
          seen,
        );
      }
      return result;
    } finally {
      seen.delete(candidate);
    }
  };
  return normalize(input, "$", new Set<object>());
}

function replaceAbsolutePaths(input: string): string {
  return input.replace(ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}[REDACTED_PATH]`);
}

function environmentSentinels(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

function redactString(
  input: string,
  environmentValues: readonly string[],
  maximumStringLength: number,
): string {
  let result = input
    .replace(PEM_BLOCK, "[REDACTED_PEM]")
    .replace(BEARER_CREDENTIAL, "Bearer [REDACTED_SECRET]")
    .replace(GITHUB_TOKEN, "[REDACTED_SECRET]");
  for (const value of environmentValues) {
    result = result.split(value).join("[REDACTED_ENV]");
  }
  result = replaceAbsolutePaths(result);
  return result.length > maximumStringLength ? "[REDACTED_LONG_TEXT]" : result;
}

export class StructuredRedactionBoundary implements RedactionBoundary {
  readonly #environmentValues: readonly string[];
  readonly #maximumStringLength: number;

  public constructor(options: StructuredRedactionOptions = {}) {
    this.#environmentValues = environmentSentinels(options.environmentValues ?? []);
    this.#maximumStringLength = options.maximumStringLength ?? DEFAULT_MAXIMUM_STRING_LENGTH;
    if (
      !Number.isSafeInteger(this.#maximumStringLength) ||
      this.#maximumStringLength < 64 ||
      this.#maximumStringLength > 1_000_000
    ) {
      throw new Error("redaction maximum string length must be an integer from 64 through 1000000");
    }
  }

  public sanitize(input: unknown): RedactedJson {
    const sanitize = (candidate: RedactedJson, key?: string): RedactedJson => {
      if (key !== undefined && FORBIDDEN_KEY.test(key)) {
        return "[REDACTED]";
      }
      if (typeof candidate === "string") {
        return redactString(candidate, this.#environmentValues, this.#maximumStringLength);
      }
      if (Array.isArray(candidate)) {
        return candidate.map((value) => sanitize(value));
      }
      if (candidate !== null && typeof candidate === "object") {
        const result: Record<string, RedactedJson> = {};
        for (const [childKey, childValue] of Object.entries(candidate)) {
          result[childKey] = sanitize(childValue, childKey);
        }
        return result;
      }
      return candidate;
    };
    return sanitize(plainJsonValue(input));
  }

  public sanitizeText(input: string): string {
    const sanitized = this.sanitize(input);
    if (typeof sanitized !== "string") {
      throw new Error("redaction text boundary returned a non-string");
    }
    return sanitized;
  }

  public scan(input: string): readonly RedactionSentinel[] {
    const sentinels = new Set<RedactionSentinel>();
    if (ABSOLUTE_PATH.test(input)) {
      sentinels.add("absolute-path");
    }
    ABSOLUTE_PATH.lastIndex = 0;
    if (GITHUB_TOKEN.test(input)) {
      sentinels.add("github-token");
    }
    GITHUB_TOKEN.lastIndex = 0;
    if (BEARER_CREDENTIAL.test(input)) {
      sentinels.add("bearer-credential");
    }
    BEARER_CREDENTIAL.lastIndex = 0;
    if (PEM_BLOCK.test(input)) {
      sentinels.add("pem-block");
    }
    PEM_BLOCK.lastIndex = 0;
    if (this.#environmentValues.some((value) => input.includes(value))) {
      sentinels.add("environment-value");
    }
    return [...sentinels].sort();
  }
}

export const DEFAULT_REDACTION_BOUNDARY: RedactionBoundary = new StructuredRedactionBoundary();

export function sanitizeAuditJson(
  input: unknown,
  redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
): RedactedJson {
  return redaction.sanitize(input);
}

export class RedactingNotificationAdapter implements NotificationAdapter {
  readonly #delegate: NotificationAdapter;
  readonly #redaction: RedactionBoundary;

  public constructor(
    delegate: NotificationAdapter,
    redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
  ) {
    this.#delegate = delegate;
    this.#redaction = redaction;
  }

  public async send(notification: Notification): Promise<void> {
    await this.#delegate.send({
      topic: this.#redaction.sanitizeText(notification.topic),
      title: this.#redaction.sanitizeText(notification.title),
      body: this.#redaction.sanitizeText(notification.body),
    });
  }
}
