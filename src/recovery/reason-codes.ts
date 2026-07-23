import { z } from "zod";

import type { WorkerTerminalStatus } from "../contracts/worker-result";
import type { CanonicalCondition } from "../domain/stages";

export const RecoveryReasonCodeSchema = z.enum([
	"blocked-external",
	"execution-failed",
	"operator-required",
	"provider-limit",
	"provider-unavailable",
	"worker-stalled",
]);

export type RecoveryReasonCode = z.infer<typeof RecoveryReasonCodeSchema>;

export function recoveryReasonForWorkerStatus(
	status: WorkerTerminalStatus,
): RecoveryReasonCode | null {
	switch (status) {
		case "blocked":
			return "blocked-external";
		case "completed":
			return null;
		case "failed":
			return "execution-failed";
		case "operator_required":
			return "operator-required";
		case "provider_limit":
			return "provider-limit";
		case "stalled":
			return "worker-stalled";
	}
}

export function conditionForRecoveryReason(reason: RecoveryReasonCode): CanonicalCondition | null {
	switch (reason) {
		case "blocked-external":
			return "blocked-external";
		case "worker-stalled":
			return "worker-stalled";
		case "execution-failed":
		case "operator-required":
		case "provider-limit":
		case "provider-unavailable":
			return null;
	}
}
