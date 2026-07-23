import type { GlobalLimits } from "../controller/config";
import type { ControllerMode, RolloutStage } from "../controller/model";

export interface ReleasePolicySnapshot {
	readonly mode: ControllerMode;
	readonly rolloutStage: RolloutStage;
	readonly limits: GlobalLimits;
}

export interface ReleaseReconcileSignal {
	readonly revision: number;
	readonly invariantViolations: readonly string[];
}

export type ReleaseUpdatePhase =
	| "candidate"
	| "queued"
	| "validated"
	| "backup-created"
	| "migrated"
	| "restart-requested"
	| "installed"
	| "failed"
	| "rolled-back";

export type ReleaseUpdateResult =
	| { readonly state: "idle" }
	| { readonly state: "waiting-for-drain"; readonly releaseId: string }
	| { readonly state: "restart-requested"; readonly releaseId: string }
	| { readonly state: "installed"; readonly releaseId: string }
	| {
			readonly state: "failed" | "rolled-back";
			readonly releaseId: string;
			readonly reason: string;
	  };
