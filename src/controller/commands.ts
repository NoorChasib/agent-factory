import { z } from "zod";

import { projectId, safeId } from "@/contracts/primitives.ts";
import {
	CircuitStatusSchema,
	ControllerModeSchema,
	ProviderSchema,
	RolloutStageSchema,
} from "@/controller/model.ts";

export const ControllerCommandSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("set-mode"),
		mode: ControllerModeSchema,
	}),
	z.strictObject({
		type: z.literal("set-project-enabled"),
		projectId,
		enabled: z.boolean(),
	}),
	z.strictObject({
		type: z.literal("set-provider-circuit"),
		provider: ProviderSchema,
		status: CircuitStatusSchema,
		reasonCode: safeId.nullable(),
	}),
	z.strictObject({
		type: z.literal("set-rollout-stage"),
		stage: RolloutStageSchema,
	}),
]);

export const ReconcileRequestSchema = z.strictObject({
	reason: z
		.enum(["startup", "poll", "change", "capacity", "recovery", "operator"])
		.default("operator"),
});
