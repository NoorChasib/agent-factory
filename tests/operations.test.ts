import { describe, expect, test } from "bun:test";
import type {
	CommandResult,
	Controller,
	ControllerStatus,
	ReconcileResult,
} from "@/controller/controller.ts";
import type { ControllerLocalState, ExecutionRecord, LedgerSnapshot } from "@/controller/model.ts";
import type {
	AuditEvent,
	ExecutionRecovery,
	MaintenanceRequest,
	NewMaintenanceRequest,
} from "@/ledger/index.ts";
import type { OperationsLedger } from "@/operations/lifecycle.ts";
import {
	DiskGuard,
	MaintenanceCoordinator,
	RebootRecoveryCoordinator,
	RolloutCoordinator,
	ShutdownCoordinator,
} from "@/operations/lifecycle.ts";
import { FactoryNotifications } from "@/operations/observability.ts";
import { createInitialControllerState, InMemoryNotificationAdapter } from "@/testing/index.ts";

function execution(id = "execution-1"): ExecutionRecord {
	return {
		executionId: id,
		projectId: "project-one",
		lane: "implementation",
		provider: "claude",
		workflow: "workflow",
		claimState: "verified",
		issueNumber: 1,
		pullRequestNumber: null,
		branch: "factory/issue-1",
		worktreeId: "worktree-1",
		headSha: "1".repeat(40),
		status: "active",
	};
}

class MemoryOperationsLedger implements OperationsLedger {
	public revision = 0;
	public state: ControllerLocalState;
	public maintenance: MaintenanceRequest[] = [];
	public audit: AuditEvent[] = [];
	#maintenanceId = 0;

	public constructor(state = createInitialControllerState([])) {
		this.state = structuredClone(state);
	}

	public async read(): Promise<LedgerSnapshot> {
		return { revision: this.revision, state: structuredClone(this.state) };
	}

	public async commit(
		expectedRevision: number,
		state: ControllerLocalState,
	): Promise<LedgerSnapshot> {
		if (expectedRevision !== this.revision) {
			throw new Error("revision conflict");
		}
		this.revision += 1;
		this.state = structuredClone(state);
		return this.read();
	}

	public createMaintenanceRequest(input: NewMaintenanceRequest): MaintenanceRequest {
		this.#maintenanceId += 1;
		const record: MaintenanceRequest = {
			requestId: `maintenance-${this.#maintenanceId}`,
			...input,
			createdAt: "2026-07-23T00:00:00.000Z",
			updatedAt: "2026-07-23T00:00:00.000Z",
		};
		this.maintenance.push(record);
		return structuredClone(record);
	}

	public updateMaintenanceRequest(
		requestId: string,
		status: MaintenanceRequest["status"],
	): MaintenanceRequest {
		const index = this.maintenance.findIndex((request) => request.requestId === requestId);
		const current = this.maintenance[index];
		if (current === undefined) {
			throw new Error("unknown maintenance");
		}
		const updated = { ...current, status, updatedAt: "2026-07-23T00:00:01.000Z" };
		this.maintenance[index] = updated;
		return structuredClone(updated);
	}

	public listMaintenanceRequests(): readonly MaintenanceRequest[] {
		return structuredClone(this.maintenance);
	}

	public listExecutions(): readonly ExecutionRecord[] {
		return structuredClone(this.state.executions);
	}

	public readExecutionRecovery(executionId: string): ExecutionRecovery {
		const target = this.state.executions.find((item) => item.executionId === executionId);
		if (target === undefined) {
			throw new Error("unknown execution");
		}
		return { execution: structuredClone(target), attempts: [], sessions: [], process: null };
	}

	public appendAudit(kind: string, payload: unknown): AuditEvent {
		const event = {
			sequence: this.audit.length + 1,
			timestamp: "2026-07-23T00:00:00.000Z",
			kind,
			payload,
		};
		this.audit.push(event);
		return structuredClone(event);
	}
}

class MemoryController implements Controller {
	readonly ledger: MemoryOperationsLedger;

	public constructor(ledger: MemoryOperationsLedger) {
		this.ledger = ledger;
	}

	public async status(): Promise<ControllerStatus> {
		return {
			observedAt: "2026-07-23T00:00:00.000Z",
			mode: this.ledger.state.mode,
			rolloutStage: this.ledger.state.rolloutStage,
			revision: this.ledger.revision,
			limits: { implementation: 3, feedback: 3, readyToMerge: 3 },
			circuits: this.ledger.state.circuits,
			projects: [],
			executions: structuredClone(this.ledger.state.executions),
			blocks: [],
			invariantViolations: [],
		};
	}

	public async command(input: unknown): Promise<CommandResult> {
		const command = input as
			| { type: "set-mode"; mode: "active" | "observation" }
			| { type: "set-rollout-stage"; stage: ControllerLocalState["rolloutStage"] };
		if (command.type === "set-mode") {
			this.ledger.state.mode = command.mode;
		} else {
			this.ledger.state.rolloutStage = command.stage;
			if (command.stage === "observation") {
				this.ledger.state.mode = "observation";
			}
		}
		this.ledger.revision += 1;
		return {
			revision: this.ledger.revision,
			mode: this.ledger.state.mode,
			rolloutStage: this.ledger.state.rolloutStage,
			circuits: this.ledger.state.circuits,
			projectEnabled: this.ledger.state.projectEnabled,
		};
	}

	public async reconcile(input?: unknown): Promise<ReconcileResult> {
		return {
			reason: (input as { reason?: ReconcileResult["reason"] } | undefined)?.reason ?? "operator",
			observedAt: "2026-07-23T00:00:00.000Z",
			applied: false,
			revision: this.ledger.revision,
			startedExecutionIds: [],
			stoppedExecutionIds: [],
			verifiedExecutionIds: [],
			blocks: [],
			invariantViolations: [],
			nextPollDelayMs: 60_000,
		};
	}
}

function notificationFixture(): {
	readonly service: FactoryNotifications;
	readonly adapter: InMemoryNotificationAdapter;
} {
	const adapter = new InMemoryNotificationAdapter();
	return {
		adapter,
		service: new FactoryNotifications({ topic: "factory-test", notifications: adapter }),
	};
}

describe("maintenance and rollout", () => {
	test("persists pause, resume, and drain lifecycles", async () => {
		const state = createInitialControllerState([]);
		state.rolloutStage = "stage1";
		state.mode = "active";
		const ledger = new MemoryOperationsLedger(state);
		const controller = new MemoryController(ledger);
		const maintenance = new MaintenanceCoordinator({ controller, ledger });

		expect((await maintenance.pause()).status).toBe("active");
		expect(ledger.state.mode).toBe("observation");
		expect((await maintenance.resume()).status).toBe("completed");
		expect(ledger.state.mode).toBe("active");
		expect(ledger.maintenance[0]?.status).toBe("cancelled");

		ledger.state.executions.push(execution());
		expect((await maintenance.drain()).status).toBe("active");
		expect(ledger.state.mode).toBe("observation");
		ledger.state.executions[0] = { ...execution(), status: "completed" };
		expect(maintenance.completeDrainsWhenIdle()).toHaveLength(1);
		expect(ledger.maintenance.at(-1)?.status).toBe("completed");
	});

	test("allows only adjacent explicit rollout transitions and reports caps", async () => {
		const ledger = new MemoryOperationsLedger();
		ledger.state.rolloutStage = "observation";
		const rollout = new RolloutCoordinator(new MemoryController(ledger));
		expect(await rollout.status()).toMatchObject({
			stage: "observation",
			caps: { implementation: 0, feedback: 0, readyToMerge: 0 },
		});
		expect(await rollout.transition("promote")).toMatchObject({
			stage: "stage1",
			mode: "active",
			caps: { implementation: 1, feedback: 1, readyToMerge: 1 },
		});
		await rollout.transition("promote");
		await rollout.transition("promote");
		await expect(rollout.transition("promote")).rejects.toThrow("cannot promote");
		await rollout.transition("demote");
		await rollout.transition("demote");
		await rollout.transition("demote");
		await expect(rollout.transition("demote")).rejects.toThrow("cannot demote");
	});
});

describe("disk guards", () => {
	test("pauses at exactly 80 percent and drains at exactly 90 percent", async () => {
		const state = createInitialControllerState([]);
		state.rolloutStage = "stage1";
		state.mode = "active";
		const ledger = new MemoryOperationsLedger(state);
		const maintenance = new MaintenanceCoordinator({
			controller: new MemoryController(ledger),
			ledger,
		});
		const notifications = notificationFixture();
		let usedBytes = 79;
		const guard = new DiskGuard({
			disk: {
				async usage() {
					return { usedBytes, totalBytes: 100 };
				},
			},
			maintenance,
			notifications: notifications.service,
		});

		expect((await guard.check(["/state"])).action).toBe("none");
		usedBytes = 80;
		expect((await guard.check(["/state"])).action).toBe("pause");
		expect(ledger.maintenance.at(-1)?.reasonCode).toBe("disk-guard-80");
		usedBytes = 90;
		expect((await guard.check(["/state"])).action).toBe("drain");
		expect(ledger.maintenance.at(-1)?.reasonCode).toBe("disk-guard-90");
		expect(ledger.maintenance.at(-1)?.status).toBe("active");
		expect(notifications.adapter.sent).toHaveLength(2);
		expect(maintenance.completeDrainsWhenIdle()).toEqual([]);
		expect((await guard.check(["/state"])).action).toBe("drain");
		expect(notifications.adapter.sent).toHaveLength(2);
	});
});

describe("shutdown and reboot recovery", () => {
	test("drains active work, verifies recovery, stops owned processes, and notifies", async () => {
		const state = createInitialControllerState([]);
		state.rolloutStage = "stage1";
		state.mode = "active";
		state.executions.push(execution());
		const ledger = new MemoryOperationsLedger(state);
		const controller = new MemoryController(ledger);
		const notifications = notificationFixture();
		let waits = 0;
		let verified: readonly string[] = [];
		const shutdown = new ShutdownCoordinator({
			controller,
			ledger,
			delay: {
				async wait() {
					waits += 1;
					ledger.state.executions[0] = { ...execution(), status: "completed" };
				},
			},
			recovery: {
				async verify(executionIds) {
					verified = executionIds;
					return { durable: true, failures: [] };
				},
			},
			processes: {
				async stopFactoryOwned() {
					return [4321];
				},
			},
			notifications: notifications.service,
			idlePollMs: 1,
		});

		const result = await shutdown.whenIdle();
		expect(waits).toBe(1);
		expect(verified).toEqual(["execution-1"]);
		expect(result).toMatchObject({
			recoveryVerified: true,
			stoppedProcessIds: [4321],
			request: { kind: "shutdown-when-idle", status: "completed" },
		});
		expect(ledger.state.mode).toBe("observation");
		expect(notifications.adapter.sent[0]?.title).toContain("ready to restart");
	});

	test("classifies reboot state, preserves running work, and clears stale shutdown", async () => {
		const state = createInitialControllerState([]);
		state.rolloutStage = "stage1";
		state.mode = "observation";
		state.executions.push(execution("still-running"), execution("orphaned"));
		const ledger = new MemoryOperationsLedger(state);
		ledger.createMaintenanceRequest({
			kind: "shutdown-when-idle",
			status: "active",
			reasonCode: "operator-shutdown",
		});
		const recovery = new RebootRecoveryCoordinator({
			controller: new MemoryController(ledger),
			ledger,
			scanner: {
				async recover() {
					return [
						{
							executionId: "still-running",
							classification: "still-running" as const,
							paneId: "pane-1",
							processId: 10,
						},
						{
							executionId: "orphaned",
							classification: "orphaned" as const,
							paneId: null,
							processId: null,
						},
					];
				},
			},
		});

		const result = await recovery.recover();
		expect(result.classifications).toHaveLength(2);
		expect(ledger.state.executions.map((item) => [item.executionId, item.status])).toEqual([
			["still-running", "active"],
			["orphaned", "completed"],
		]);
		expect(ledger.maintenance[0]?.status).toBe("cancelled");
		expect(ledger.audit.at(-1)?.kind).toBe("reboot-recovery-classified");
	});

	test("reapplies durable launch-blocking maintenance before recovery reconcile", async () => {
		const state = createInitialControllerState([]);
		state.rolloutStage = "stage1";
		state.mode = "active";
		const ledger = new MemoryOperationsLedger(state);
		ledger.createMaintenanceRequest({
			kind: "pause",
			status: "pending",
			reasonCode: "operator-pause",
		});
		const recovery = new RebootRecoveryCoordinator({
			controller: new MemoryController(ledger),
			ledger,
			scanner: {
				async recover() {
					expect(ledger.state.mode).toBe("observation");
					return [];
				},
			},
		});

		await recovery.recover();
		expect(ledger.state.mode).toBe("observation");
		expect(ledger.maintenance[0]?.status).toBe("pending");
	});
});
