import { z } from "zod";
import { GitCommitShaSchema, ReleaseManifestSchema } from "@/contracts/release-manifest.ts";
import { GlobalLimitsSchema } from "@/controller/config.ts";
import { ControllerModeSchema, RolloutStageSchema } from "@/controller/model.ts";

export const ReleasePolicySnapshotSchema = z.strictObject({
	mode: ControllerModeSchema,
	rolloutStage: RolloutStageSchema,
	limits: GlobalLimitsSchema,
});

export const ReleaseUpdatePhaseSchema = z.enum([
	"candidate",
	"queued",
	"validated",
	"backup-created",
	"migrated",
	"restart-requested",
	"installed",
	"failed",
	"rolled-back",
]);

export const CandidateReleaseMetadataSchema = z.strictObject({
	schemaVersion: z.literal(1),
	manifest: ReleaseManifestSchema,
	update: z.strictObject({
		phase: ReleaseUpdatePhaseSchema,
		priorPolicy: ReleasePolicySnapshotSchema.nullable(),
		previousReleaseId: GitCommitShaSchema.nullable(),
		previousSchemaVersion: z.number().int().positive().nullable(),
		failureCode: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
			.nullable(),
	}),
});
export type CandidateReleaseMetadata = z.infer<typeof CandidateReleaseMetadataSchema>;

export const FailedReleaseMetadataSchema = z.strictObject({
	schemaVersion: z.literal(1),
	failureCode: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
});
