import { z } from "zod";

import { absolutePath } from "./primitives";

const commandText = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\0\r\n]/u.test(value));
const argument = z
  .string()
  .max(16_384)
  .refine((value) => !/[\0\r\n]/u.test(value));
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const environmentValue = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes("\0"));

export const WorkerCommandSpecificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executable: commandText,
  argv: z.array(argument).max(1_024),
  cwd: absolutePath,
  env: z
    .record(environmentName, environmentValue)
    .refine((value) => Object.keys(value).length <= 64),
  stdin: z.string().max(16 * 1_024 * 1_024),
  resultPath: absolutePath,
});

export type WorkerCommandSpecification = z.infer<typeof WorkerCommandSpecificationSchema>;

export function parseWorkerCommandSpecification(input: unknown): WorkerCommandSpecification {
  return WorkerCommandSpecificationSchema.parse(input);
}
