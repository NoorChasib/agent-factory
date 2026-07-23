import { z } from "zod";

import type {
  ClockAdapter,
  CommandRequest,
  ProcessIdentity,
  ProcessTreeAdapter,
} from "../adapters/interfaces";
import type { HerdrPane } from "../contracts/herdr-output";
import { safeId } from "../contracts/primitives";
import type { ExecutionRecord } from "../controller/model";
import type { ExecutionRecovery, ProcessMetadata, ProcessMetadataInput } from "../ledger";
import { FACTORY_HERDR_SESSION, type GuardedHerdrCommandAdapter } from "./guard";

const processIdentity = z.strictObject({
  processId: z.number().int().positive(),
  parentProcessId: z.number().int().positive().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
});

const runtimeMetadata = z.strictObject({
  sessionName: z.literal(FACTORY_HERDR_SESSION),
  custody: z.enum(["factory", "operator"]),
  providerSessionId: z.string().min(1).max(200).nullable(),
  processTree: z.array(processIdentity),
  lastAttachedAt: z.iso.datetime({ offset: true }).nullable(),
  takenOverAt: z.iso.datetime({ offset: true }).nullable(),
  killedAt: z.iso.datetime({ offset: true }).nullable(),
  providerRun: z.unknown().optional(),
});

type HerdrRuntimeMetadata = z.infer<typeof runtimeMetadata>;

export type RecoveredExecutionClassification = "exited-with-result" | "orphaned" | "still-running";

export interface RecoveredExecution {
  readonly executionId: string;
  readonly classification: RecoveredExecutionClassification;
  readonly paneId: string | null;
  readonly processId: number | null;
}

export interface HerdrProcessRepository {
  listExecutions(): readonly ExecutionRecord[];
  readExecutionRecovery(executionId: string): ExecutionRecovery;
  saveProcessMetadata(input: ProcessMetadataInput): ProcessMetadata;
}

export interface HerdrSessionManagerOptions {
  readonly herdr: GuardedHerdrCommandAdapter;
  readonly processes: ProcessTreeAdapter;
  readonly repository: HerdrProcessRepository;
  readonly clock: ClockAdapter;
  readonly hostIdentity: string;
}

function timestamp(clock: ClockAdapter): string {
  const now = clock.now();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Herdr manager clock returned an invalid date");
  }
  return now.toISOString();
}

function sortedTree(tree: readonly ProcessIdentity[]): readonly ProcessIdentity[] {
  return processIdentity
    .array()
    .parse(tree)
    .sort((left, right) => left.processId - right.processId);
}

function rootIdentity(tree: readonly ProcessIdentity[], processId: number): ProcessIdentity | null {
  return tree.find((process) => process.processId === processId) ?? null;
}

function priorRuntime(process: ProcessMetadata): HerdrRuntimeMetadata {
  const parsed = runtimeMetadata.safeParse(process.runtimeMetadata);
  if (parsed.success) {
    return parsed.data;
  }
  return {
    sessionName: FACTORY_HERDR_SESSION,
    custody: "factory",
    providerSessionId: null,
    processTree: [],
    lastAttachedAt: null,
    takenOverAt: null,
    killedAt: null,
  };
}

export class HerdrSessionManager {
  readonly #herdr: GuardedHerdrCommandAdapter;
  readonly #processes: ProcessTreeAdapter;
  readonly #repository: HerdrProcessRepository;
  readonly #clock: ClockAdapter;
  readonly #hostIdentity: string;

  public constructor(options: HerdrSessionManagerOptions) {
    this.#herdr = options.herdr;
    this.#processes = options.processes;
    this.#repository = options.repository;
    this.#clock = options.clock;
    this.#hostIdentity = safeId.parse(options.hostIdentity);
  }

  public async ensureSession(): Promise<void> {
    await this.#herdr.execute({
      kind: "ensure-session",
      sessionName: FACTORY_HERDR_SESSION,
    });
  }

  public async createPane(input: {
    readonly executionId: string;
    readonly attemptNumber: number;
    readonly providerSessionId: string | null;
    readonly command: CommandRequest;
  }): Promise<ProcessMetadata> {
    await this.ensureSession();
    const result = await this.#herdr.execute({
      kind: "create-pane",
      sessionName: FACTORY_HERDR_SESSION,
      paneName: input.executionId,
      command: input.command,
    });
    if (result.kind !== "pane") {
      throw new Error("Herdr create-pane returned no pane");
    }
    if (result.pane.processId === null) {
      throw new Error("Herdr create-pane returned no pane process");
    }
    const tree = sortedTree(await this.#processes.inspectTree(result.pane.processId));
    const root = rootIdentity(tree, result.pane.processId);
    if (root === null) {
      throw new Error("Herdr pane process was absent from the inspected process tree");
    }
    return this.#repository.saveProcessMetadata({
      executionId: input.executionId,
      attemptNumber: input.attemptNumber,
      paneId: result.pane.paneId,
      processId: result.pane.processId,
      processStartedAt: root.startedAt,
      hostIdentity: this.#hostIdentity,
      runtimeMetadata: {
        sessionName: FACTORY_HERDR_SESSION,
        custody: "factory",
        providerSessionId: input.providerSessionId,
        processTree: [...tree],
        lastAttachedAt: null,
        takenOverAt: null,
        killedAt: null,
      } satisfies HerdrRuntimeMetadata,
    });
  }

  public async listPanes(): Promise<readonly HerdrPane[]> {
    const result = await this.#herdr.execute({
      kind: "list-panes",
      sessionName: FACTORY_HERDR_SESSION,
    });
    if (result.kind !== "panes") {
      throw new Error("Herdr list-panes returned no pane list");
    }
    return result.panes;
  }

  public async isExecutionAlive(executionId: string): Promise<boolean> {
    const recovery = this.#repository.readExecutionRecovery(executionId);
    const process = recovery.process;
    if (
      process === null ||
      process.paneId === null ||
      process.processId === null ||
      process.processStartedAt === null
    ) {
      return false;
    }
    const panes = await this.listPanes();
    const pane = panes.find(
      (candidate) =>
        candidate.paneId === process.paneId &&
        candidate.name === recovery.execution.executionId &&
        candidate.processId === process.processId,
    );
    const tree = sortedTree(await this.#processes.inspectTree(process.processId));
    const root = rootIdentity(tree, process.processId);
    const recordedWorkers = priorRuntime(process).processTree.filter(
      (candidate) => candidate.parentProcessId === process.processId,
    );
    const workerMatches =
      recordedWorkers.length === 0
        ? tree.some((candidate) => candidate.parentProcessId === process.processId)
        : recordedWorkers.some((recorded) =>
            tree.some(
              (candidate) =>
                candidate.processId === recorded.processId &&
                candidate.parentProcessId === recorded.parentProcessId &&
                candidate.startedAt === recorded.startedAt,
            ),
          );
    return (
      pane !== undefined &&
      root !== null &&
      root.startedAt === process.processStartedAt &&
      workerMatches
    );
  }

  public async attach(executionId: string): Promise<ProcessMetadata> {
    return this.#operatorFlow(executionId, "attach-pane");
  }

  public async takeover(executionId: string): Promise<ProcessMetadata> {
    return this.#operatorFlow(executionId, "takeover-pane");
  }

  public async kill(executionId: string): Promise<ProcessMetadata> {
    const recovery = this.#repository.readExecutionRecovery(executionId);
    const process = this.#requireProcess(recovery);
    const pane = await this.#requireLivePane(recovery, process);
    await this.#herdr.execute({
      kind: "kill-pane",
      sessionName: FACTORY_HERDR_SESSION,
      paneId: pane.paneId,
    });
    return this.#saveRuntime(process, {
      ...priorRuntime(process),
      killedAt: timestamp(this.#clock),
    });
  }

  public async recover(): Promise<readonly RecoveredExecution[]> {
    await this.ensureSession();
    const panes = await this.listPanes();
    const paneById = new Map(panes.map((pane) => [pane.paneId, pane]));
    const recovered: RecoveredExecution[] = [];
    for (const execution of this.#repository.listExecutions()) {
      const recovery = this.#repository.readExecutionRecovery(execution.executionId);
      const process = recovery.process;
      if (
        process === null ||
        process.paneId === null ||
        process.processId === null ||
        process.processStartedAt === null
      ) {
        recovered.push(this.#classifyExited(recovery, process));
        continue;
      }
      const pane = paneById.get(process.paneId);
      const paneMatches =
        pane !== undefined &&
        pane.name === execution.executionId &&
        pane.processId === process.processId;
      const tree = sortedTree(await this.#processes.inspectTree(process.processId));
      const root = rootIdentity(tree, process.processId);
      const processMatches = root !== null && root.startedAt === process.processStartedAt;
      if (paneMatches && processMatches) {
        this.#saveRuntime(process, {
          ...priorRuntime(process),
          processTree: [...tree],
        });
        recovered.push({
          executionId: execution.executionId,
          classification: "still-running",
          paneId: process.paneId,
          processId: process.processId,
        });
        continue;
      }
      recovered.push(this.#classifyExited(recovery, process));
    }
    return recovered;
  }

  async #operatorFlow(
    executionId: string,
    kind: "attach-pane" | "takeover-pane",
  ): Promise<ProcessMetadata> {
    const recovery = this.#repository.readExecutionRecovery(executionId);
    const process = this.#requireProcess(recovery);
    const pane = await this.#requireLivePane(recovery, process);
    await this.#herdr.execute({
      kind,
      sessionName: FACTORY_HERDR_SESSION,
      paneId: pane.paneId,
    });
    const at = timestamp(this.#clock);
    const previous = priorRuntime(process);
    return this.#saveRuntime(process, {
      ...previous,
      custody: kind === "takeover-pane" ? "operator" : previous.custody,
      lastAttachedAt: at,
      takenOverAt: kind === "takeover-pane" ? at : previous.takenOverAt,
    });
  }

  #classifyExited(
    recovery: ExecutionRecovery,
    process: ProcessMetadata | null,
  ): RecoveredExecution {
    const latest = recovery.attempts.at(-1);
    return {
      executionId: recovery.execution.executionId,
      classification:
        latest !== undefined && latest.status !== "active" ? "exited-with-result" : "orphaned",
      paneId: process?.paneId ?? null,
      processId: process?.processId ?? null,
    };
  }

  #requireProcess(recovery: ExecutionRecovery): ProcessMetadata {
    if (recovery.process === null) {
      throw new Error(`execution '${recovery.execution.executionId}' has no process metadata`);
    }
    return recovery.process;
  }

  async #requireLivePane(
    recovery: ExecutionRecovery,
    process: ProcessMetadata,
  ): Promise<HerdrPane> {
    if (
      process.paneId === null ||
      process.processId === null ||
      process.processStartedAt === null
    ) {
      throw new Error(
        `execution '${recovery.execution.executionId}' has incomplete Herdr process identity`,
      );
    }
    const panes = await this.listPanes();
    const pane = panes.find(
      (candidate) =>
        candidate.paneId === process.paneId &&
        candidate.name === recovery.execution.executionId &&
        candidate.processId === process.processId,
    );
    const tree = sortedTree(await this.#processes.inspectTree(process.processId));
    const root = rootIdentity(tree, process.processId);
    if (pane === undefined || root === null || root.startedAt !== process.processStartedAt) {
      throw new Error(
        `execution '${recovery.execution.executionId}' no longer has its recorded live Herdr pane`,
      );
    }
    return pane;
  }

  #saveRuntime(process: ProcessMetadata, metadata: HerdrRuntimeMetadata): ProcessMetadata {
    return this.#repository.saveProcessMetadata({
      executionId: process.executionId,
      attemptNumber: process.attemptNumber,
      paneId: process.paneId,
      processId: process.processId,
      processStartedAt: process.processStartedAt,
      hostIdentity: process.hostIdentity,
      runtimeMetadata: runtimeMetadata.parse(metadata),
    });
  }
}
