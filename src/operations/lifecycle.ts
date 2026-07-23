import { z } from "zod";

import type { DelayAdapter, DiskUsageAdapter, LedgerAdapter } from "../adapters/interfaces";
import type { Controller, ControllerStatus } from "../controller/controller";
import type { ExecutionRecord, RolloutStage } from "../controller/model";
import { nextRolloutStage, ROLLOUT_STAGE_CAPS } from "../domain/rollout";
import type {
	AuditEvent,
	ExecutionRecovery,
	MaintenanceRequest,
	NewMaintenanceRequest,
} from "../ledger";
import type { FactoryNotifications } from "./observability";

export interface OperationsLedger extends LedgerAdapter {
	createMaintenanceRequest(input: NewMaintenanceRequest): MaintenanceRequest;
	updateMaintenanceRequest(
		requestId: string,
		status: MaintenanceRequest["status"],
	): MaintenanceRequest;
	listMaintenanceRequests(): readonly MaintenanceRequest[];
	listExecutions(): readonly ExecutionRecord[];
	readExecutionRecovery(executionId: string): ExecutionRecovery;
	appendAudit(kind: string, payload: unknown): AuditEvent;
	updateAttempt?(input: {
		readonly executionId: string;
		readonly attemptNumber: number;
		readonly status:
			| "active"
			| "completed"
			| "blocked"
			| "operator-required"
			| "provider-limit"
			| "stalled"
			| "failed"
			| "released";
		readonly checkpoint: string | null;
		readonly outcome: string | null;
		readonly reasonCode: string | null;
	}): unknown;
}

function active(request: MaintenanceRequest): boolean {
	return request.status === "pending" || request.status === "active";
}

function latestActive(
	ledger: OperationsLedger,
	kind: MaintenanceRequest["kind"],
	reasonCode?: string,
): MaintenanceRequest | null {
	return (
		[...ledger.listMaintenanceRequests()]
			.reverse()
			.find(
				(request) =>
					request.kind === kind &&
					active(request) &&
					(reasonCode === undefined || request.reasonCode === reasonCode),
			) ?? null
	);
}

export class MaintenanceCoordinator {
	readonly #controller: Controller;
	readonly #ledger: OperationsLedger;

	public constructor(input: {
		readonly controller: Controller;
		readonly ledger: OperationsLedger;
	}) {
		this.#controller = input.controller;
		this.#ledger = input.ledger;
	}

	public list(): readonly MaintenanceRequest[] {
		return this.#ledger.listMaintenanceRequests();
	}

	public async pause(reasonCode = "operator-pause"): Promise<MaintenanceRequest> {
		const existing = latestActive(this.#ledger, "pause", reasonCode);
		if (existing !== null) {
			return existing;
		}
		const request = this.#ledger.createMaintenanceRequest({
			kind: "pause",
			status: "pending",
			reasonCode,
		});
		await this.#controller.command({ type: "set-mode", mode: "observation" });
		return this.#ledger.updateMaintenanceRequest(request.requestId, "active");
	}

	public async drain(reasonCode = "operator-drain"): Promise<MaintenanceRequest> {
		const existing = latestActive(this.#ledger, "drain", reasonCode);
		if (existing !== null) {
			return existing;
		}
		const request = this.#ledger.createMaintenanceRequest({
			kind: "drain",
			status: "pending",
			reasonCode,
		});
		await this.#controller.command({ type: "set-mode", mode: "observation" });
		const activated = this.#ledger.updateMaintenanceRequest(request.requestId, "active");
		const heldUntilExplicitClear = reasonCode === "disk-guard-90";
		return heldUntilExplicitClear ||
			this.#ledger.listExecutions().some((execution) => execution.status === "active")
			? activated
			: this.#ledger.updateMaintenanceRequest(request.requestId, "completed");
	}

	public async resume(): Promise<MaintenanceRequest> {
		const status = await this.#controller.status();
		if (status.rolloutStage === "observation") {
			throw new Error("cannot resume while rollout stage is observation; promote to stage1 first");
		}
		const blocking = this.#ledger
			.listMaintenanceRequests()
			.filter(
				(entry) =>
					active(entry) &&
					entry.kind !== "resume" &&
					(entry.reasonCode === "disk-guard-80" ||
						entry.reasonCode === "disk-guard-90" ||
						entry.kind === "shutdown-when-idle"),
			);
		if (blocking.length > 0) {
			throw new Error(`cannot resume while '${blocking.at(-1)?.reasonCode}' maintenance is active`);
		}
		const request = this.#ledger.createMaintenanceRequest({
			kind: "resume",
			status: "pending",
			reasonCode: "operator-resume",
		});
		for (const prior of this.#ledger.listMaintenanceRequests()) {
			if (active(prior) && (prior.kind === "pause" || prior.kind === "drain")) {
				this.#ledger.updateMaintenanceRequest(prior.requestId, "cancelled");
			}
		}
		await this.#controller.command({ type: "set-mode", mode: "active" });
		return this.#ledger.updateMaintenanceRequest(request.requestId, "completed");
	}

	public completeDrainsWhenIdle(): readonly MaintenanceRequest[] {
		if (this.#ledger.listExecutions().some((execution) => execution.status === "active")) {
			return [];
		}
		return this.#ledger
			.listMaintenanceRequests()
			.filter(
				(request) =>
					request.kind === "drain" &&
					request.status === "active" &&
					request.reasonCode !== "disk-guard-90",
			)
			.map((request) => this.#ledger.updateMaintenanceRequest(request.requestId, "completed"));
	}

	public clearReasons(reasonCodes: readonly string[]): readonly MaintenanceRequest[] {
		const reasons = new Set(reasonCodes);
		return this.#ledger
			.listMaintenanceRequests()
			.filter(
				(request) =>
					active(request) && request.reasonCode !== null && reasons.has(request.reasonCode),
			)
			.map((request) => this.#ledger.updateMaintenanceRequest(request.requestId, "cancelled"));
	}
}

export interface RolloutStatus {
	readonly stage: RolloutStage;
	readonly caps: (typeof ROLLOUT_STAGE_CAPS)[RolloutStage];
	readonly mode: ControllerStatus["mode"];
}

export class RolloutCoordinator {
	readonly #controller: Controller;

	public constructor(controller: Controller) {
		this.#controller = controller;
	}

	public async status(): Promise<RolloutStatus> {
		const status = await this.#controller.status();
		return {
			stage: status.rolloutStage,
			caps: ROLLOUT_STAGE_CAPS[status.rolloutStage],
			mode: status.mode,
		};
	}

	public async transition(direction: "promote" | "demote"): Promise<RolloutStatus> {
		const current = await this.#controller.status();
		const next = nextRolloutStage(current.rolloutStage, direction);
		if (next === null) {
			throw new Error(`cannot ${direction} rollout from ${current.rolloutStage}`);
		}
		await this.#controller.command({ type: "set-rollout-stage", stage: next });
		if (direction === "promote" && current.rolloutStage === "observation") {
			await this.#controller.command({ type: "set-mode", mode: "active" });
		}
		return this.status();
	}
}

export interface DiskGuardResult {
	readonly percentage: number;
	readonly action: "none" | "pause" | "drain";
	readonly paths: readonly string[];
}

export class DiskGuard {
	readonly #disk: DiskUsageAdapter;
	readonly #maintenance: MaintenanceCoordinator;
	readonly #notifications: FactoryNotifications;

	public constructor(input: {
		readonly disk: DiskUsageAdapter;
		readonly maintenance: MaintenanceCoordinator;
		readonly notifications: FactoryNotifications;
	}) {
		this.#disk = input.disk;
		this.#maintenance = input.maintenance;
		this.#notifications = input.notifications;
	}

	public async check(paths: readonly string[]): Promise<DiskGuardResult> {
		if (paths.length === 0) {
			throw new Error("disk guard requires at least one relevant path");
		}
		let maximum = 0;
		for (const path of paths) {
			const usage = await this.#disk.usage(path);
			if (
				!Number.isSafeInteger(usage.usedBytes) ||
				!Number.isSafeInteger(usage.totalBytes) ||
				usage.usedBytes < 0 ||
				usage.totalBytes <= 0 ||
				usage.usedBytes > usage.totalBytes
			) {
				throw new Error("disk usage adapter returned invalid byte counts");
			}
			maximum = Math.max(maximum, (usage.usedBytes / usage.totalBytes) * 100);
		}
		if (maximum >= 90) {
			this.#maintenance.clearReasons(["disk-guard-80"]);
			const alreadyActive = this.#maintenance
				.list()
				.some((request) => active(request) && request.reasonCode === "disk-guard-90");
			await this.#maintenance.drain("disk-guard-90");
			if (!alreadyActive) {
				await this.#notifications.alert("disk-guard", {
					threshold: 90,
					usagePercent: maximum,
				});
			}
			return { percentage: maximum, action: "drain", paths: [...paths] };
		}
		if (maximum >= 80) {
			this.#maintenance.clearReasons(["disk-guard-90"]);
			const alreadyActive = this.#maintenance
				.list()
				.some((request) => active(request) && request.reasonCode === "disk-guard-80");
			await this.#maintenance.pause("disk-guard-80");
			if (!alreadyActive) {
				await this.#notifications.alert("disk-guard", {
					threshold: 80,
					usagePercent: maximum,
				});
			}
			return { percentage: maximum, action: "pause", paths: [...paths] };
		}
		this.#maintenance.clearReasons(["disk-guard-80", "disk-guard-90"]);
		return { percentage: maximum, action: "none", paths: [...paths] };
	}
}

export interface DurableRecoveryVerifier {
	verify(executionIds: readonly string[]): Promise<{
		readonly durable: boolean;
		readonly failures: readonly string[];
	}>;
}

export interface FactoryOwnedProcessStopper {
	stopFactoryOwned(): Promise<readonly number[]>;
}

export class ShutdownCoordinator {
	readonly #controller: Controller;
	readonly #ledger: OperationsLedger;
	readonly #delay: DelayAdapter;
	readonly #recovery: DurableRecoveryVerifier;
	readonly #processes: FactoryOwnedProcessStopper;
	readonly #notifications: FactoryNotifications;
	readonly #idlePollMs: number;

	public constructor(input: {
		readonly controller: Controller;
		readonly ledger: OperationsLedger;
		readonly delay: DelayAdapter;
		readonly recovery: DurableRecoveryVerifier;
		readonly processes: FactoryOwnedProcessStopper;
		readonly notifications: FactoryNotifications;
		readonly idlePollMs?: number;
	}) {
		this.#controller = input.controller;
		this.#ledger = input.ledger;
		this.#delay = input.delay;
		this.#recovery = input.recovery;
		this.#processes = input.processes;
		this.#notifications = input.notifications;
		this.#idlePollMs = z
			.number()
			.int()
			.min(1)
			.max(60_000)
			.parse(input.idlePollMs ?? 1_000);
	}

	public async whenIdle(): Promise<{
		readonly request: MaintenanceRequest;
		readonly stoppedProcessIds: readonly number[];
		readonly recoveryVerified: true;
	}> {
		const existing = latestActive(this.#ledger, "shutdown-when-idle");
		const request =
			existing ??
			this.#ledger.createMaintenanceRequest({
				kind: "shutdown-when-idle",
				status: "pending",
				reasonCode: "operator-shutdown",
			});
		await this.#controller.command({ type: "set-mode", mode: "observation" });
		const activeRequest =
			request.status === "pending"
				? this.#ledger.updateMaintenanceRequest(request.requestId, "active")
				: request;

		while (this.#ledger.listExecutions().some((execution) => execution.status === "active")) {
			await this.#delay.wait(this.#idlePollMs);
		}
		const executionIds = this.#ledger
			.listExecutions()
			.map((execution) => execution.executionId)
			.sort();
		const recovery = await this.#recovery.verify(executionIds);
		if (!recovery.durable) {
			throw new Error(`shutdown recovery verification failed: ${recovery.failures.join(", ")}`);
		}
		const stoppedProcessIds = await this.#processes.stopFactoryOwned();
		const completed = this.#ledger.updateMaintenanceRequest(activeRequest.requestId, "completed");
		await this.#notifications.alert("shutdown-ready", {
			executionCount: executionIds.length,
			recoveryVerified: true,
		});
		return { request: completed, stoppedProcessIds, recoveryVerified: true };
	}
}

export interface RecoveryScanner {
	recover(): Promise<
		readonly {
			readonly executionId: string;
			readonly classification: "exited-with-result" | "orphaned" | "still-running";
			readonly paneId: string | null;
			readonly processId: number | null;
		}[]
	>;
}

export class RebootRecoveryCoordinator {
	readonly #controller: Controller;
	readonly #ledger: OperationsLedger;
	readonly #scanner: RecoveryScanner;

	public constructor(input: {
		readonly controller: Controller;
		readonly ledger: OperationsLedger;
		readonly scanner: RecoveryScanner;
	}) {
		this.#controller = input.controller;
		this.#ledger = input.ledger;
		this.#scanner = input.scanner;
	}

	public async recover(): Promise<{
		readonly classifications: Awaited<ReturnType<RecoveryScanner["recover"]>>;
		readonly reconciledRevision: number;
	}> {
		const maintenanceBlocksLaunches = this.#ledger
			.listMaintenanceRequests()
			.some(
				(request) =>
					active(request) &&
					(request.kind === "pause" ||
						request.kind === "drain" ||
						request.kind === "shutdown-when-idle"),
			);
		if (maintenanceBlocksLaunches && (await this.#controller.status()).mode !== "observation") {
			await this.#controller.command({ type: "set-mode", mode: "observation" });
		}
		const classifications = await this.#scanner.recover();
		const snapshot = await this.#ledger.read();
		const state = structuredClone(snapshot.state);
		for (const classification of classifications) {
			const index = state.executions.findIndex(
				(candidate) => candidate.executionId === classification.executionId,
			);
			const execution = state.executions[index];
			if (
				execution !== undefined &&
				execution.status === "active" &&
				classification.classification !== "still-running"
			) {
				const latest = this.#ledger.readExecutionRecovery(execution.executionId).attempts.at(-1);
				if (latest?.status === "active") {
					this.#ledger.updateAttempt?.({
						executionId: execution.executionId,
						attemptNumber: latest.attemptNumber,
						status: "stalled",
						checkpoint: latest.checkpoint,
						outcome: "stalled",
						reasonCode: "controller-reboot-orphaned",
					});
				}
				state.executions[index] = { ...execution, status: "completed" };
			}
		}
		let revision = snapshot.revision;
		if (JSON.stringify(state) !== JSON.stringify(snapshot.state)) {
			revision = (await this.#ledger.commit(snapshot.revision, state)).revision;
		}
		for (const request of this.#ledger.listMaintenanceRequests()) {
			if (request.kind === "shutdown-when-idle" && active(request)) {
				this.#ledger.updateMaintenanceRequest(request.requestId, "cancelled");
			}
		}
		this.#ledger.appendAudit("reboot-recovery-classified", { classifications });
		const reconciled = await this.#controller.reconcile({ reason: "recovery" });
		return { classifications, reconciledRevision: Math.max(revision, reconciled.revision) };
	}
}
