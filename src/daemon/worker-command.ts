#!/usr/bin/env bun

import { chmodSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

const specificationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executable: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => !/[\0\r\n]/u.test(value)),
  argv: z
    .array(
      z
        .string()
        .max(16_384)
        .refine((value) => !/[\0\r\n]/u.test(value)),
    )
    .max(1_024),
  cwd: z.string().startsWith("/").max(4_096),
  resultPath: z.string().startsWith("/").max(4_096),
});

async function main(): Promise<number> {
  const encoded = Bun.argv[2];
  if (encoded === undefined) {
    return 64;
  }
  let specification: z.infer<typeof specificationSchema>;
  try {
    specification = specificationSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return 64;
  }
  const stdin = await Bun.stdin.text();
  let result:
    | {
        readonly status: "exited";
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr: string;
        readonly processId: number;
      }
    | {
        readonly status: "failed";
        readonly classification: "spawn" | "transport";
        readonly stdout: string;
        readonly stderr: string;
        readonly processId: number | null;
      };
  let processId: number | null = null;
  let signalChild: ((signal: "SIGINT" | "SIGTERM") => void) | null = null;
  let pendingSignal: "SIGINT" | "SIGTERM" | null = null;
  const forwardInterrupt = (): void => {
    pendingSignal = "SIGINT";
    signalChild?.("SIGINT");
  };
  const forwardTermination = (): void => {
    pendingSignal = "SIGTERM";
    signalChild?.("SIGTERM");
  };
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    const child = Bun.spawn([specification.executable, ...specification.argv], {
      cwd: specification.cwd,
      env: { ...Bun.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    processId = child.pid;
    signalChild = (signal) => {
      child.kill(signal);
    };
    if (pendingSignal !== null) {
      signalChild(pendingSignal);
    }
    child.stdin.write(stdin);
    await child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    result = { status: "exited", exitCode, stdout, stderr, processId };
  } catch {
    result = {
      status: "failed",
      classification: processId === null ? "spawn" : "transport",
      stdout: "",
      stderr: "",
      processId,
    };
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
  }
  const temporaryPath = `${specification.resultPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(result), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, specification.resultPath);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main();
}
