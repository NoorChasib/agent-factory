import { z } from "zod";

import type { ClockAdapter, LedgerAdapter } from "@/adapters/interfaces.ts";
import type { AuditEvent } from "@/ledger/index.ts";
import { assessWorktreeCleanup, type WorktreeRecoveryState } from "@/worktrees/index.ts";

export const MERGED_EXECUTION_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface RetentionCandidate {
	readonly executionId: string;
	readonly projectId: string;
	readonly issueNumber: number;
	readonly branch: string;
	readonly mergedAt: string | null;
	readonly recoveryState: WorktreeRecoveryState;
	readonly explicitlyReleased: boolean;
}

export interface RetentionArtifacts {
	candidates(): Promise<readonly RetentionCandidate[]>;
	removeWorktree(candidate: RetentionCandidate): Promise<boolean>;
	removeExecutionLogs(executionId: string): Promise<boolean>;
}

export interface RetentionLedger extends LedgerAdapter {
	appendAudit(kind: string, payload: unknown): AuditEvent;
}

export type ExecutionLogCleanupAssessment =
	| { readonly eligible: true; readonly eligibleAt: string }
	| {
			readonly eligible: false;
			readonly reason:
				| "clock-before-merge"
				| "merged-retention-active"
				| "not-merged"
				| "recovery-retained";
			readonly eligibleAt: string | null;
	  };

export function assessExecutionLogCleanup(
	input: Pick<RetentionCandidate, "mergedAt" | "recoveryState" | "explicitlyReleased">,
	now: Date,
): ExecutionLogCleanupAssessment {
	if (!Number.isFinite(now.getTime())) {
		throw new Error("execution-log retention clock returned an invalid date");
	}
	if (input.recoveryState !== "none" && !input.explicitlyReleased) {
		return { eligible: false, reason: "recovery-retained", eligibleAt: null };
	}
	if (input.mergedAt === null) {
		return { eligible: false, reason: "not-merged", eligibleAt: null };
	}
	const merged = new Date(z.iso.datetime({ offset: true }).parse(input.mergedAt));
	const eligibleAt = new Date(merged.getTime() + MERGED_EXECUTION_LOG_RETENTION_MS);
	if (now.getTime() < merged.getTime()) {
		return {
			eligible: false,
			reason: "clock-before-merge",
			eligibleAt: eligibleAt.toISOString(),
		};
	}
	if (now.getTime() < eligibleAt.getTime()) {
		return {
			eligible: false,
			reason: "merged-retention-active",
			eligibleAt: eligibleAt.toISOString(),
		};
	}
	return { eligible: true, eligibleAt: eligibleAt.toISOString() };
}

export class RetentionCoordinator {
	readonly #clock: ClockAdapter;
	readonly #ledger: RetentionLedger;
	readonly #artifacts: RetentionArtifacts;

	public constructor(input: {
		readonly clock: ClockAdapter;
		readonly ledger: RetentionLedger;
		readonly artifacts: RetentionArtifacts;
	}) {
		this.#clock = input.clock;
		this.#ledger = input.ledger;
		this.#artifacts = input.artifacts;
	}

	public async run(): Promise<{
		readonly worktreesRemoved: readonly string[];
		readonly logsRemoved: readonly string[];
	}> {
		const now = this.#clock.now();
		const worktreesRemoved: string[] = [];
		const logsRemoved: string[] = [];
		for (const candidate of await this.#artifacts.candidates()) {
			const worktree = assessWorktreeCleanup(
				{
					mergedAt: candidate.mergedAt,
					recoveryState: candidate.recoveryState,
					explicitlyReleased: candidate.explicitlyReleased,
				},
				now,
			);
			if (worktree.eligible && (await this.#artifacts.removeWorktree(candidate))) {
				worktreesRemoved.push(candidate.executionId);
			}
			const logs = assessExecutionLogCleanup(candidate, now);
			if (logs.eligible && (await this.#artifacts.removeExecutionLogs(candidate.executionId))) {
				logsRemoved.push(candidate.executionId);
			}
		}
		if (worktreesRemoved.length > 0 || logsRemoved.length > 0) {
			this.#ledger.appendAudit("retention-cleanup", { worktreesRemoved, logsRemoved });
		}
		return { worktreesRemoved, logsRemoved };
	}

	public async release(executionId: string): Promise<void> {
		const snapshot = await this.#ledger.read();
		const state = structuredClone(snapshot.state);
		const index = state.executions.findIndex((candidate) => candidate.executionId === executionId);
		const execution = state.executions[index];
		if (execution === undefined) {
			throw new Error(`unknown execution '${executionId}'`);
		}
		if (execution.status === "active") {
			throw new Error(`cannot release active execution '${executionId}'`);
		}
		state.executions[index] = { ...execution, status: "released" };
		await this.#ledger.commit(snapshot.revision, state);
		this.#ledger.appendAudit("retention-explicit-release", { executionId });
	}
}
