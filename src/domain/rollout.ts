import type { GlobalLimits } from "../controller/config";
import type { RolloutStage } from "../controller/model";

export const ROLLOUT_STAGES = ["observation", "stage1", "stage2", "stage3"] as const;

export const ROLLOUT_STAGE_CAPS = {
	observation: { implementation: 0, feedback: 0, readyToMerge: 0 },
	stage1: { implementation: 1, feedback: 1, readyToMerge: 1 },
	stage2: { implementation: 2, feedback: 2, readyToMerge: 2 },
	stage3: { implementation: 3, feedback: 3, readyToMerge: 3 },
} as const satisfies Record<RolloutStage, GlobalLimits>;

export function rolloutStageIndex(stage: RolloutStage): number {
	return ROLLOUT_STAGES.indexOf(stage);
}

export function nextRolloutStage(
	stage: RolloutStage,
	direction: "promote" | "demote",
): RolloutStage | null {
	const offset = direction === "promote" ? 1 : -1;
	return ROLLOUT_STAGES[rolloutStageIndex(stage) + offset] ?? null;
}

export function clampLimitsToRollout(limits: GlobalLimits, stage: RolloutStage): GlobalLimits {
	const cap = ROLLOUT_STAGE_CAPS[stage];
	return {
		implementation: Math.min(limits.implementation, cap.implementation),
		feedback: Math.min(limits.feedback, cap.feedback),
		readyToMerge: Math.min(limits.readyToMerge, cap.readyToMerge),
	};
}
