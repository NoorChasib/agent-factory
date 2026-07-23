import { z } from "zod";

import { gitObjectId as GitCommitShaSchema } from "@/contracts/primitives.ts";

export { GitCommitShaSchema };

export const ReleaseRelativePathSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => !value.startsWith("/") && !value.includes("\\"), "path must be relative")
	.refine(
		(value) =>
			!value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
		"path must not contain empty, current, or parent segments",
	)
	.refine((value) => !/[\0\r\n]/u.test(value), "path must not contain control characters");

export const ReleaseInventoryEntrySchema = z.strictObject({
	path: ReleaseRelativePathSchema,
	kind: z.enum(["file", "symbolic-link"]),
	bytes: z.number().int().nonnegative(),
	mode: z.number().int().min(0).max(0o777),
	sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type ReleaseInventoryEntry = z.infer<typeof ReleaseInventoryEntrySchema>;

const sortedUniqueInventory = z
	.array(ReleaseInventoryEntrySchema)
	.min(1)
	.superRefine((entries, context) => {
		for (const [index, entry] of entries.entries()) {
			const prior = entries[index - 1];
			if (prior !== undefined && prior.path >= entry.path) {
				context.addIssue({
					code: "custom",
					message: "release inventory paths must be sorted and unique",
					path: [index, "path"],
				});
			}
		}
	});

export const ReleaseManifestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	commitSha: GitCommitShaSchema,
	builtAt: z.iso.datetime({ offset: true }),
	requiredLedgerSchemaVersion: z.number().int().positive(),
	inventory: sortedUniqueInventory,
	inventoryHash: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export const ReleaseBuildMetadataSchema = z.strictObject({
	schemaVersion: z.literal(1),
	version: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
	requiredLedgerSchemaVersion: z.number().int().positive(),
});
export type ReleaseBuildMetadata = z.infer<typeof ReleaseBuildMetadataSchema>;

export function parseReleaseBuildMetadata(input: unknown): ReleaseBuildMetadata {
	return ReleaseBuildMetadataSchema.parse(input);
}
