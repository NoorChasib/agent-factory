import { z } from "zod";

import type { CommandExecutionResult } from "../adapters/interfaces";

const commandOutput = {
  stdout: z.string().max(10 * 1024 * 1024),
  stderr: z.string().max(10 * 1024 * 1024),
  processId: z.number().int().positive().nullable(),
} as const;

export const CommandExecutionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("exited"),
    exitCode: z.number().int().min(0).max(255),
    ...commandOutput,
  }),
  z.strictObject({
    status: z.literal("failed"),
    classification: z.enum(["cancelled", "spawn", "timeout", "transport"]),
    ...commandOutput,
  }),
]) satisfies z.ZodType<CommandExecutionResult>;

export function parseCommandExecutionResult(input: unknown): CommandExecutionResult {
  return CommandExecutionResultSchema.parse(input);
}
