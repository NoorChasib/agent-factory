import type { AgentFactoryOperation } from "../contracts/daemon-protocol";
import type { ProjectProfile } from "../contracts/project-profile";
import type { Controller } from "../controller/controller";
import type { ProviderCircuitRecord, ReleaseRecord } from "../ledger";
import type { Doctor } from "../operations/doctor";
import type {
  MaintenanceCoordinator,
  OperationsLedger,
  RolloutCoordinator,
  ShutdownCoordinator,
} from "../operations/lifecycle";
import type { FactoryNotifications, StructuredLogger } from "../operations/observability";
import type { RetentionCoordinator } from "../operations/retention";
import type { LoadedFactoryConfiguration } from "../operations/runtime";

export interface OperationalRegistry extends OperationsLedger {
  listProviderCircuits(): readonly ProviderCircuitRecord[];
  listReleases(): readonly ReleaseRecord[];
  saveRelease(input: {
    readonly releaseId: string;
    readonly commitSha: string;
    readonly status: ReleaseRecord["status"];
    readonly artifactPath: string | null;
    readonly requiredSchemaVersion: number;
    readonly metadata: unknown;
  }): ReleaseRecord;
}

export interface WorkerOperator {
  attach(executionId: string): Promise<unknown>;
  takeover(executionId: string): Promise<unknown>;
  resume(executionId: string): Promise<unknown>;
  stop(executionId: string): Promise<unknown>;
  kill(executionId: string): Promise<unknown>;
}

export interface LabelOperator {
  plan(projectId: string): Promise<unknown>;
  preview(projectId: string): Promise<unknown>;
  apply(projectId: string, hash: string): Promise<unknown>;
}

export interface DaemonCommandRouter {
  dispatch(request: AgentFactoryOperation): Promise<unknown>;
}

export interface AgentFactoryRouterOptions {
  readonly controller: Controller;
  readonly ledger: OperationalRegistry;
  readonly configuration: LoadedFactoryConfiguration;
  readonly loadConfiguration: () => Promise<LoadedFactoryConfiguration>;
  readonly maintenance: MaintenanceCoordinator;
  readonly rollout: RolloutCoordinator;
  readonly retention: RetentionCoordinator;
  readonly notifications: FactoryNotifications;
  readonly logger: StructuredLogger;
  readonly doctor: Doctor;
  readonly workers: WorkerOperator;
  readonly labels: LabelOperator;
  readonly shutdown: ShutdownCoordinator;
  readonly stopDaemon: () => void;
}

function projectView(profile: ProjectProfile): {
  readonly id: string;
  readonly repository: string;
  readonly configuredEnabled: boolean;
} {
  return {
    id: profile.id,
    repository: profile.repository,
    configuredEnabled: profile.enabled,
  };
}

export class AgentFactoryRouter implements DaemonCommandRouter {
  readonly #options: AgentFactoryRouterOptions;

  public constructor(options: AgentFactoryRouterOptions) {
    this.#options = options;
  }

  public async dispatch(request: AgentFactoryOperation): Promise<unknown> {
    switch (request.operation) {
      case "status": {
        const status = await this.#options.controller.status();
        const maintenance = this.#options.ledger.listMaintenanceRequests();
        return {
          ...status,
          maintenance,
          operationalBlocks: maintenance
            .filter((request) => request.status === "pending" || request.status === "active")
            .map((request) => ({
              kind: request.kind,
              reasonCode: request.reasonCode,
            })),
          releases: this.#options.ledger.listReleases(),
        };
      }
      case "workers":
        return (await this.#options.controller.status()).executions;
      case "show":
        return this.#options.ledger.readExecutionRecovery(request.executionId);
      case "logs":
        return this.#options.logger.recent(request.lines);
      case "pause":
        return this.#options.maintenance.pause();
      case "resume":
        return this.#options.maintenance.resume();
      case "drain":
        return this.#options.maintenance.drain();
      case "worker":
        return this.#worker(request.action, request.executionId);
      case "circuits":
        return this.#options.ledger.listProviderCircuits();
      case "project":
        if (request.action === "list") {
          return this.#options.configuration.profiles.map(projectView);
        }
        if (request.action === "validate") {
          const configuration = await this.#options.loadConfiguration();
          const profiles =
            request.projectId === undefined
              ? configuration.profiles
              : configuration.profiles.filter((profile) => profile.id === request.projectId);
          if (profiles.length === 0) {
            throw new Error(`unknown project '${request.projectId}'`);
          }
          return profiles.map((profile) => ({ id: profile.id, valid: true }));
        }
        return this.#options.controller.command({
          type: "set-project-enabled",
          projectId: request.projectId,
          enabled: request.action === "enable",
        });
      case "config": {
        if (request.action === "list") {
          return {
            configFile: "config.yaml",
            profiles: this.#options.configuration.profiles.map((profile) => profile.id),
          };
        }
        const configuration = await this.#options.loadConfiguration();
        return {
          valid: true,
          profileCount: configuration.profiles.length,
        };
      }
      case "rollout":
        return request.action === "status"
          ? this.#options.rollout.status()
          : this.#options.rollout.transition(request.action);
      case "labels":
        if (request.action === "plan") {
          return this.#options.labels.plan(request.projectId);
        }
        if (request.action === "preview") {
          return this.#options.labels.preview(request.projectId);
        }
        if ("hash" in request) {
          return this.#options.labels.apply(request.projectId, request.hash);
        }
        throw new Error("invalid labels operation");
      case "update":
        if (request.action === "status") {
          return this.#options.ledger.listReleases();
        }
        return this.#queueRelease(request.releaseId);
      case "doctor-live":
        return this.#options.doctor.run({ live: true });
      case "reconcile":
        return this.#options.controller.reconcile({ reason: "operator" });
      case "notifications":
        if (request.action === "test") {
          return this.#options.notifications.test();
        }
        return this.#options.notifications.digest({
          status: await this.#options.controller.status(),
          maintenance: this.#options.ledger.listMaintenanceRequests(),
          circuits: this.#options.ledger.listProviderCircuits(),
          releases: this.#options.ledger.listReleases(),
        });
      case "shutdown": {
        const result = await this.#options.shutdown.whenIdle();
        this.#options.stopDaemon();
        return result;
      }
    }
  }

  async #worker(
    action: Extract<AgentFactoryOperation, { operation: "worker" }>["action"],
    executionId: string,
  ): Promise<unknown> {
    switch (action) {
      case "attach":
        return this.#options.workers.attach(executionId);
      case "takeover":
        return this.#options.workers.takeover(executionId);
      case "resume":
        return this.#options.workers.resume(executionId);
      case "release":
        await this.#options.retention.release(executionId);
        return { executionId, released: true };
      case "stop":
        return this.#options.workers.stop(executionId);
      case "kill":
        return this.#options.workers.kill(executionId);
    }
  }

  #queueRelease(releaseId: string): ReleaseRecord {
    const release = this.#options.ledger
      .listReleases()
      .find((candidate) => candidate.releaseId === releaseId);
    if (release === undefined) {
      throw new Error(
        `unknown release '${releaseId}'; Phase 7 installs candidates before they can be queued`,
      );
    }
    if (release.status !== "candidate") {
      throw new Error(`release '${releaseId}' is not a queueable candidate`);
    }
    return this.#options.ledger.saveRelease({
      releaseId: release.releaseId,
      commitSha: release.commitSha,
      status: "queued",
      artifactPath: release.artifactPath,
      requiredSchemaVersion: release.requiredSchemaVersion,
      metadata: release.metadata,
    });
  }
}
