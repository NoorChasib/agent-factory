import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { parseCommandExecutionResult } from "../contracts/command-result";
import type { HerdrSessionManager } from "../herdr";
import type { SqliteLedger } from "../ledger";
import type {
  CommandAdapter,
  CommandExecutionResult,
  CommandRequest,
  DelayAdapter,
} from "./interfaces";

const executionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u);

interface ExecutionContext {
  readonly executionId: string;
}

export class HerdrCommandExecutionAdapter implements CommandAdapter {
  readonly #herdr: HerdrSessionManager;
  readonly #ledger: SqliteLedger;
  readonly #delay: DelayAdapter;
  readonly #resultDirectory: string;
  readonly #workerExecutable: string;
  readonly #context = new AsyncLocalStorage<ExecutionContext>();

  public constructor(input: {
    readonly herdr: HerdrSessionManager;
    readonly ledger: SqliteLedger;
    readonly delay: DelayAdapter;
    readonly stateDirectory: string;
    readonly workerExecutable: string;
  }) {
    this.#herdr = input.herdr;
    this.#ledger = input.ledger;
    this.#delay = input.delay;
    this.#resultDirectory = join(input.stateDirectory, "execution-details");
    this.#workerExecutable = input.workerExecutable;
    mkdirSync(this.#resultDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.#resultDirectory, 0o700);
  }

  public runForExecution<T>(executionId: string, run: () => Promise<T>): Promise<T> {
    return this.#context.run({ executionId: executionIdSchema.parse(executionId) }, run);
  }

  public async execute(request: CommandRequest): Promise<CommandExecutionResult> {
    const context = this.#context.getStore();
    if (context === undefined) {
      throw new Error("Herdr command execution requires an execution context");
    }
    const recovery = this.#ledger.readExecutionRecovery(context.executionId);
    const attempt = recovery.attempts.at(-1);
    if (attempt === undefined || attempt.status !== "active") {
      throw new Error("Herdr command execution requires one active ledger attempt");
    }
    const resultPath = join(
      this.#resultDirectory,
      `${context.executionId}-${attempt.attemptNumber}.json`,
    );
    if (existsSync(resultPath)) {
      return parseCommandExecutionResult(JSON.parse(readFileSync(resultPath, "utf8")));
    }
    const specification = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executable: request.executable,
        argv: request.argv,
        cwd: request.cwd,
        resultPath,
      }),
    ).toString("base64url");
    await this.#herdr.createPane({
      executionId: context.executionId,
      attemptNumber: attempt.attemptNumber,
      providerSessionId: this.#providerSessionId(request),
      command: {
        executable: "bun",
        argv: [this.#workerExecutable, specification],
        cwd: request.cwd,
        env: request.env,
        stdin: request.stdin,
        stdout: "capture-json-lines",
        stderr: "capture",
      },
    });
    while (!existsSync(resultPath)) {
      await this.#delay.wait(1_000);
    }
    return parseCommandExecutionResult(JSON.parse(readFileSync(resultPath, "utf8")));
  }

  #providerSessionId(request: CommandRequest): string | null {
    const sessionIndex = request.argv.indexOf("--session-id");
    if (sessionIndex >= 0) {
      return request.argv[sessionIndex + 1] ?? null;
    }
    const resumeIndex = request.argv.indexOf("resume");
    if (resumeIndex >= 0 && request.argv[0] === "exec") {
      return request.argv[resumeIndex + 1] ?? null;
    }
    return null;
  }
}
