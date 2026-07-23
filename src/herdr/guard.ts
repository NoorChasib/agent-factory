import { z } from "zod";

import type {
  CommandAdapter,
  CommandExecutionResult,
  CommandRequest,
} from "../adapters/interfaces";
import {
  type HerdrPane,
  type HerdrPaneReference,
  parseHerdrPaneListOutput,
  parseHerdrPaneOutput,
  parseHerdrPaneProcessOutput,
} from "../contracts/herdr-output";

export const FACTORY_HERDR_SESSION = "agent-factory" as const;

const safeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u);
const commandText = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => !/[\0\r\n]/u.test(value));
const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .startsWith("/")
  .refine((value) => !/[\0\r\n]/u.test(value));
const commandRequest = z.strictObject({
  executable: z.literal("bun"),
  argv: z.tuple([absolutePath, absolutePath]),
  cwd: absolutePath,
  env: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
      z.string().refine((value) => !value.includes("\0")),
    )
    .refine((value) => Object.keys(value).length === 0),
  stdin: z.literal(""),
  stdout: z.literal("capture-json-lines"),
  stderr: z.literal("capture"),
});

export const HerdrOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ensure-session"),
    sessionName: z.literal(FACTORY_HERDR_SESSION),
  }),
  z.strictObject({
    kind: z.literal("list-panes"),
    sessionName: z.literal(FACTORY_HERDR_SESSION),
  }),
  z.strictObject({
    kind: z.literal("create-pane"),
    sessionName: z.literal(FACTORY_HERDR_SESSION),
    paneName: safeId,
    command: commandRequest,
  }),
  z.strictObject({
    kind: z.literal("kill-pane"),
    sessionName: z.literal(FACTORY_HERDR_SESSION),
    paneId: safeId,
  }),
  z.strictObject({
    kind: z.literal("attach-pane"),
    sessionName: z.literal(FACTORY_HERDR_SESSION),
    paneId: safeId,
  }),
  z.strictObject({
    kind: z.literal("takeover-pane"),
    sessionName: z.literal(FACTORY_HERDR_SESSION),
    paneId: safeId,
  }),
]);

export type HerdrOperation = z.infer<typeof HerdrOperationSchema>;

export class HerdrScopeError extends Error {
  public constructor() {
    super("Herdr operation is not scoped to the dedicated agent-factory session");
    this.name = "HerdrScopeError";
  }
}

export class HerdrCommandError extends Error {
  public constructor(operation: HerdrOperation["kind"]) {
    super(`Herdr ${operation} command failed`);
    this.name = "HerdrCommandError";
  }
}

export function assertFactoryHerdrOperation(input: unknown): HerdrOperation {
  const parsed = HerdrOperationSchema.safeParse(input);
  if (!parsed.success) {
    throw new HerdrScopeError();
  }
  return parsed.data;
}

function commandSucceeded(result: CommandExecutionResult, operation: HerdrOperation["kind"]): void {
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new HerdrCommandError(operation);
  }
}

export type HerdrOperationResult =
  | { readonly kind: "acknowledged" }
  | { readonly kind: "pane"; readonly pane: HerdrPane }
  | { readonly kind: "panes"; readonly panes: readonly HerdrPane[] };

export interface GuardedHerdrCommandAdapterOptions {
  readonly commands: CommandAdapter;
  readonly workingDirectory: string;
  readonly executable?: string;
}

export class GuardedHerdrCommandAdapter {
  readonly #commands: CommandAdapter;
  readonly #workingDirectory: string;
  readonly #executable: string;

  public constructor(options: GuardedHerdrCommandAdapterOptions) {
    this.#commands = options.commands;
    this.#workingDirectory = z.string().startsWith("/").parse(options.workingDirectory);
    this.#executable = commandText.parse(options.executable ?? "herdr");
  }

  public async execute(input: unknown): Promise<HerdrOperationResult> {
    const operation = assertFactoryHerdrOperation(input);
    switch (operation.kind) {
      case "attach-pane":
        await this.#run(
          ["agent", "attach", operation.paneId],
          operation.kind,
          this.#workingDirectory,
        );
        return { kind: "acknowledged" };
      case "create-pane":
        return this.#createPane(operation);
      case "ensure-session":
        await this.#run(["api", "snapshot"], operation.kind, this.#workingDirectory);
        return { kind: "acknowledged" };
      case "kill-pane":
        await this.#run(
          ["pane", "close", operation.paneId],
          operation.kind,
          this.#workingDirectory,
        );
        return { kind: "acknowledged" };
      case "list-panes":
        return { kind: "panes", panes: await this.#listPanes(operation.kind) };
      case "takeover-pane":
        await this.#run(
          ["agent", "attach", operation.paneId, "--takeover"],
          operation.kind,
          this.#workingDirectory,
        );
        return { kind: "acknowledged" };
    }
  }

  async #createPane(
    operation: Extract<HerdrOperation, { readonly kind: "create-pane" }>,
  ): Promise<HerdrOperationResult> {
    const split = await this.#run(
      [
        "pane",
        "split",
        "--current",
        "--direction",
        "right",
        "--cwd",
        operation.command.cwd,
        "--no-focus",
      ],
      operation.kind,
      operation.command.cwd,
    );
    let reference: HerdrPaneReference;
    try {
      reference = parseHerdrPaneOutput(split.stdout);
    } catch {
      throw new HerdrCommandError(operation.kind);
    }
    await this.#run(
      ["pane", "rename", reference.paneId, operation.paneName],
      operation.kind,
      operation.command.cwd,
    );
    await this.#run(
      [
        "pane",
        "run",
        reference.paneId,
        "--",
        operation.command.executable,
        ...operation.command.argv,
      ],
      operation.kind,
      operation.command.cwd,
    );
    const process = await this.#processInfo(reference, operation.kind);
    if (process.processId === null) {
      throw new HerdrCommandError(operation.kind);
    }
    return {
      kind: "pane",
      pane: {
        paneId: reference.paneId,
        name: operation.paneName,
        processId: process.processId,
      },
    };
  }

  async #listPanes(
    operation: Extract<HerdrOperation["kind"], "list-panes">,
  ): Promise<readonly HerdrPane[]> {
    const result = await this.#run(["pane", "list"], operation, this.#workingDirectory);
    let references: readonly HerdrPaneReference[];
    try {
      references = parseHerdrPaneListOutput(result.stdout);
    } catch {
      throw new HerdrCommandError(operation);
    }
    const panes: HerdrPane[] = [];
    for (const reference of references) {
      const process = await this.#processInfo(reference, operation);
      panes.push({
        paneId: reference.paneId,
        name: reference.name,
        processId: process.processId,
      });
    }
    return panes;
  }

  async #processInfo(
    reference: HerdrPaneReference,
    operation: HerdrOperation["kind"],
  ): Promise<{ readonly processId: number | null }> {
    const result = await this.#run(
      ["pane", "process-info", "--pane", reference.paneId],
      operation,
      this.#workingDirectory,
    );
    try {
      const parsed = parseHerdrPaneProcessOutput(result.stdout);
      if (parsed.paneId !== reference.paneId) {
        throw new Error("Herdr process response referred to another pane");
      }
      return { processId: parsed.processId };
    } catch {
      throw new HerdrCommandError(operation);
    }
  }

  async #run(
    argv: readonly string[],
    operation: HerdrOperation["kind"],
    cwd: string,
  ): Promise<CommandExecutionResult> {
    const result = await this.#commands.execute(this.#request(argv, cwd));
    commandSucceeded(result, operation);
    return result;
  }

  #request(argv: readonly string[], cwd: string): CommandRequest {
    return {
      executable: this.#executable,
      argv: ["--session", FACTORY_HERDR_SESSION, ...argv],
      cwd,
      env: {},
      stdin: "",
      stdout: "capture-json-lines",
      stderr: "capture",
    };
  }
}
