import { z } from "zod";

const opaqueId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u);

const projectId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);

const repository = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

function hasForbiddenGitCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      "~^:?*[\\\\".includes(character)
    );
  });
}

const gitBranch = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value.trim() === value &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !hasForbiddenGitCharacter(value),
    "invalid Git branch name",
  );

const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

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
    executionId: opaqueId,
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
      id: opaqueId,
    }),
    checkpoint: z.strictObject({
      phase: opaqueId,
      sequence: z.number().int().nonnegative(),
      code: opaqueId,
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
