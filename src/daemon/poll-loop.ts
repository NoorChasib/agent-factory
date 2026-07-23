import type { DelayAdapter } from "../adapters/interfaces";
import type { ReleaseUpdateOperator } from "../adapters/release-interfaces";
import type { Controller, ReconcileResult } from "../controller/controller";
import type { DiskGuard, MaintenanceCoordinator } from "../operations/lifecycle";
import type { FactoryNotifications, StructuredLogger } from "../operations/observability";
import type { RetentionCoordinator } from "../operations/retention";
import type { ReleaseUpdateResult } from "../releases";

export interface PollTickResult {
  readonly reconcile: ReconcileResult | null;
  readonly diskAction: "none" | "pause" | "drain";
  readonly worktreesRemoved: readonly string[];
  readonly logsRemoved: readonly string[];
  readonly drainsCompleted: number;
  readonly update: ReleaseUpdateResult;
}

export class DaemonPollLoop {
  readonly #controller: Controller;
  readonly #disk: DiskGuard;
  readonly #retention: RetentionCoordinator;
  readonly #maintenance: MaintenanceCoordinator;
  readonly #notifications: FactoryNotifications;
  readonly #logger: StructuredLogger;
  readonly #delay: DelayAdapter;
  readonly #updates: ReleaseUpdateOperator;
  readonly #diskPaths: readonly string[];
  readonly #alertedCircuits = new Set<string>();
  #stopped = false;

  public constructor(input: {
    readonly controller: Controller;
    readonly disk: DiskGuard;
    readonly retention: RetentionCoordinator;
    readonly maintenance: MaintenanceCoordinator;
    readonly notifications: FactoryNotifications;
    readonly logger: StructuredLogger;
    readonly delay: DelayAdapter;
    readonly updates: ReleaseUpdateOperator;
    readonly diskPaths: readonly string[];
  }) {
    this.#controller = input.controller;
    this.#disk = input.disk;
    this.#retention = input.retention;
    this.#maintenance = input.maintenance;
    this.#notifications = input.notifications;
    this.#logger = input.logger;
    this.#delay = input.delay;
    this.#updates = input.updates;
    this.#diskPaths = [...input.diskPaths];
  }

  public stop(): void {
    this.#stopped = true;
  }

  public async tick(reason: "poll" | "startup" = "poll"): Promise<PollTickResult> {
    const disk = await this.#disk.check(this.#diskPaths);
    const update = await this.#updates.applyWhenIdle();
    if (update.state === "restart-requested" || update.state === "rolled-back") {
      const result = {
        reconcile: null,
        diskAction: disk.action,
        worktreesRemoved: [],
        logsRemoved: [],
        drainsCompleted: 0,
        update,
      };
      await this.#logger.write("info", "daemon.poll", result);
      return result;
    }
    const reconcile = await this.#controller.reconcile({ reason });
    const status = await this.#controller.status();
    for (const [provider, circuit] of Object.entries(status.circuits)) {
      if (circuit.status === "open" && !this.#alertedCircuits.has(provider)) {
        await this.#notifications.alert("circuit-open", {
          provider,
          reasonCode: circuit.reasonCode,
        });
        this.#alertedCircuits.add(provider);
      } else if (circuit.status === "closed") {
        this.#alertedCircuits.delete(provider);
      }
    }
    const retention = await this.#retention.run();
    const completed = this.#maintenance.completeDrainsWhenIdle();
    for (const request of completed) {
      await this.#notifications.alert("drained", { requestId: request.requestId });
    }
    const result = {
      reconcile,
      diskAction: disk.action,
      worktreesRemoved: retention.worktreesRemoved,
      logsRemoved: retention.logsRemoved,
      drainsCompleted: completed.length,
      update,
    };
    await this.#logger.write("info", "daemon.poll", result);
    return result;
  }

  public async run(): Promise<void> {
    let reason: "poll" | "startup" = "startup";
    while (!this.#stopped) {
      const result = await this.tick(reason);
      reason = "poll";
      if (!this.#stopped) {
        await this.#delay.wait(result.reconcile?.nextPollDelayMs ?? 1_000);
      }
    }
  }
}
