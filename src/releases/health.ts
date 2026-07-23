import type {
	ReleaseLedgerAdapter,
	ReleaseReconciliationAdapter,
	ReleaseServiceAdapter,
} from "@/adapters/release-interfaces.ts";
import type { ReleaseManifest } from "@/contracts/release-manifest.ts";
import type { ReleaseStore } from "@/releases/store.ts";
import type { ReleasePolicySnapshot } from "@/releases/types.ts";

export interface ReleaseHealthCheck {
	readonly name:
		| "artifact"
		| "current-pointer"
		| "ledger-schema"
		| "policy"
		| "reconciliation"
		| "running-release"
		| "service";
	readonly ok: boolean;
	readonly detail: string;
}

export interface ReleaseHealthReport {
	readonly ok: boolean;
	readonly checks: readonly ReleaseHealthCheck[];
	readonly reconciledRevision: number | null;
}

function sameLimits(
	left: ReleasePolicySnapshot["limits"],
	right: ReleasePolicySnapshot["limits"],
): boolean {
	return (
		left.implementation === right.implementation &&
		left.feedback === right.feedback &&
		left.readyToMerge === right.readyToMerge
	);
}

export class ReleaseHealthChecker {
	readonly #store: ReleaseStore;
	readonly #ledger: ReleaseLedgerAdapter;
	readonly #service: ReleaseServiceAdapter;
	readonly #reconciliation: ReleaseReconciliationAdapter;

	public constructor(input: {
		readonly store: ReleaseStore;
		readonly ledger: ReleaseLedgerAdapter;
		readonly service: ReleaseServiceAdapter;
		readonly reconciliation: ReleaseReconciliationAdapter;
	}) {
		this.#store = input.store;
		this.#ledger = input.ledger;
		this.#service = input.service;
		this.#reconciliation = input.reconciliation;
	}

	public async check(input: {
		readonly releaseId: string;
		readonly manifest: ReleaseManifest;
		readonly priorPolicy: ReleasePolicySnapshot;
	}): Promise<ReleaseHealthReport> {
		const checks: ReleaseHealthCheck[] = [];
		try {
			await this.#store.validate(input.releaseId);
			checks.push({ name: "artifact", ok: true, detail: "manifest and inventory verified" });
		} catch {
			checks.push({
				name: "artifact",
				ok: false,
				detail: "manifest or inventory verification failed",
			});
		}

		const current = await this.#store.currentReleaseId();
		checks.push({
			name: "current-pointer",
			ok: current === input.releaseId,
			detail: current === input.releaseId ? "candidate is current" : "candidate is not current",
		});

		checks.push({
			name: "ledger-schema",
			ok: this.#ledger.schemaVersion === input.manifest.requiredLedgerSchemaVersion,
			detail: `ledger=${this.#ledger.schemaVersion} required=${input.manifest.requiredLedgerSchemaVersion}`,
		});

		const running = await this.#service.runningReleaseId();
		checks.push({
			name: "running-release",
			ok: running === input.releaseId,
			detail:
				running === input.releaseId
					? "candidate daemon is running"
					: "candidate daemon is not running",
		});

		const service = await this.#service.probe();
		checks.push({ name: "service", ...service });

		const currentPolicy = await this.#reconciliation.snapshotPolicy();
		const policyUnchanged =
			currentPolicy.mode === "observation" &&
			currentPolicy.rolloutStage === input.priorPolicy.rolloutStage &&
			sameLimits(currentPolicy.limits, input.priorPolicy.limits);
		checks.push({
			name: "policy",
			ok: policyUnchanged,
			detail: policyUnchanged
				? "temporary drain preserved rollout and limits"
				: "rollout, limits, or drained mode changed unexpectedly",
		});

		let reconciledRevision: number | null = null;
		try {
			const reconciliation = await this.#reconciliation.reconcile();
			reconciledRevision = reconciliation.revision;
			checks.push({
				name: "reconciliation",
				ok: reconciliation.invariantViolations.length === 0,
				detail:
					reconciliation.invariantViolations.length === 0
						? "reconciliation completed without invariant violations"
						: "reconciliation reported invariant violations",
			});
		} catch {
			checks.push({
				name: "reconciliation",
				ok: false,
				detail: "reconciliation failed",
			});
		}

		return {
			ok: checks.every((check) => check.ok),
			checks,
			reconciledRevision,
		};
	}
}
