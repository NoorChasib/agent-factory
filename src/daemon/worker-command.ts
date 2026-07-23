#!/usr/bin/env bun

import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { CommandExecutionResult } from "../adapters/interfaces";
import {
  parseWorkerCommandSpecification,
  type WorkerCommandSpecification,
} from "../contracts/worker-command";

export interface WorkerCommandSpawnInput {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface WorkerCommandChild {
  readonly processId: number;
  writeStdin(stdin: string): Promise<void>;
  wait(): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  kill(signal: "SIGINT" | "SIGTERM"): void;
}

export interface WorkerCommandSpawner {
  spawn(input: WorkerCommandSpawnInput): WorkerCommandChild;
}

interface WorkerSignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

class BunWorkerCommandSpawner implements WorkerCommandSpawner {
  public spawn(input: WorkerCommandSpawnInput): WorkerCommandChild {
    const child = Bun.spawn([input.executable, ...input.argv], {
      cwd: input.cwd,
      env: { ...input.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      processId: child.pid,
      async writeStdin(stdin): Promise<void> {
        child.stdin.write(stdin);
        await child.stdin.end();
      },
      async wait() {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      },
      kill(signal): void {
        child.kill(signal);
      },
    };
  }
}

export async function executeWorkerCommandSpecification(
  input: unknown,
  spawner: WorkerCommandSpawner,
  signals?: WorkerSignalSource,
): Promise<CommandExecutionResult> {
  const specification = parseWorkerCommandSpecification(input);
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
  signals?.once("SIGINT", forwardInterrupt);
  signals?.once("SIGTERM", forwardTermination);
  try {
    const child = spawner.spawn({
      executable: specification.executable,
      argv: specification.argv,
      cwd: specification.cwd,
      env: specification.env,
    });
    processId = child.processId;
    signalChild = (signal) => {
      child.kill(signal);
    };
    if (pendingSignal !== null) {
      signalChild(pendingSignal);
    }
    await child.writeStdin(specification.stdin);
    const completed = await child.wait();
    return {
      status: "exited",
      exitCode: completed.exitCode,
      stdout: completed.stdout,
      stderr: completed.stderr,
      processId,
    };
  } catch {
    return {
      status: "failed",
      classification: processId === null ? "spawn" : "transport",
      stdout: "",
      stderr: "",
      processId,
    };
  } finally {
    signals?.off("SIGINT", forwardInterrupt);
    signals?.off("SIGTERM", forwardTermination);
  }
}

function readOwnerOnlySpecification(path: string): WorkerCommandSpecification {
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) {
    throw new Error("worker command specification path is invalid");
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("worker command specification must be an owner-only regular file");
  }
  return parseWorkerCommandSpecification(JSON.parse(readFileSync(path, "utf8")));
}

function deleteSpecification(path: string): void {
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) {
    return;
  }
  try {
    if (lstatSync(path).isFile()) {
      unlinkSync(path);
    }
  } catch {
    // Best-effort custody cleanup tolerates a prior deletion.
  }
}

function writeResult(path: string, result: CommandExecutionResult): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(result), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

export async function workerCommandMain(
  argv: readonly string[] = Bun.argv,
  spawner: WorkerCommandSpawner = new BunWorkerCommandSpawner(),
  signals: WorkerSignalSource = process,
): Promise<number> {
  const specificationPath = argv[2];
  if (specificationPath === undefined) {
    return 64;
  }
  let specification: WorkerCommandSpecification;
  try {
    specification = readOwnerOnlySpecification(specificationPath);
    unlinkSync(specificationPath);
  } catch {
    deleteSpecification(specificationPath);
    return 64;
  }
  const result = await executeWorkerCommandSpecification(specification, spawner, signals);
  writeResult(specification.resultPath, result);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await workerCommandMain();
}
