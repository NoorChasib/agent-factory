import { parse } from "yaml";
import { z } from "zod";
import type { FileSystemAdapter } from "@/adapters/interfaces.ts";
import {
	githubCheckName,
	githubLogin,
	projectDefaultBranch,
	projectId,
	projectProfileLabelName,
	projectProfileRepository,
	workflowEntryPoint,
} from "@/contracts/primitives.ts";
import { ProjectLabelMappingSchema } from "@/domain/stages.ts";

const reviewCompletionSignal = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("pull-request-review"),
	}),
	z.strictObject({
		kind: z.literal("check-run"),
		name: githubCheckName,
	}),
]);

const reviewer = z.strictObject({
	identity: z.strictObject({
		kind: z.enum(["github-user", "github-app"]),
		login: githubLogin,
	}),
	completionSignal: reviewCompletionSignal,
});

const requiredCheck = z.strictObject({
	name: githubCheckName,
	appSlug: githubLogin.optional(),
});

const laneCeiling = z.number().int().min(0).max(3);
const DEFAULT_TIMEOUTS = {
	reviewerMinutes: 45,
	requiredCheckMinutes: 90,
	quiescencePolls: 2,
} as const;

export const ProjectProfileSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		id: projectId,
		enabled: z.boolean(),
		repository: projectProfileRepository,
		defaultBranch: projectDefaultBranch,
		workflow: z.strictObject({
			implement: workflowEntryPoint,
			feedback: workflowEntryPoint,
			operatorImplement: workflowEntryPoint,
			operatorFeedback: workflowEntryPoint,
		}),
		labels: ProjectLabelMappingSchema,
		reviewPolicy: z.strictObject({
			required: z.array(projectId).min(1),
			optionalOwnerLabel: projectProfileLabelName.optional(),
		}),
		defaultBranchProtection: z.strictObject({
			requiresPullRequest: z.boolean(),
			requiredApprovingReviewCount: z.number().int().min(0).max(10),
			dismissesStaleReviews: z.boolean(),
			requiresCodeOwnerReviews: z.boolean(),
			requiresConversationResolution: z.boolean(),
			requiresStatusChecks: z.boolean(),
			prohibitsForcePushes: z.boolean(),
			prohibitsDeletions: z.boolean(),
		}),
		requiredChecks: z
			.strictObject({
				source: z.enum(["profile", "branch-protection"]),
				requireCurrentHead: z.literal(true),
				checks: z.array(requiredCheck),
			})
			.superRefine((policy, context) => {
				const identities = policy.checks.map(
					(check) => `${check.appSlug ?? ""}\u0000${check.name}`,
				);
				if (new Set(identities).size !== identities.length) {
					context.addIssue({ code: "custom", message: "required checks must be unique" });
				}
				if (policy.source === "profile" && policy.checks.length === 0) {
					context.addIssue({
						code: "custom",
						message: "profile-sourced required-check policy must name at least one check",
					});
				}
			}),
		reviewers: z.record(projectId, reviewer),
		issueSelection: z.strictObject({
			owner: z.literal("project-workflow"),
			controllerProvidesIssueNumber: z.literal(false),
		}),
		timeouts: z
			.strictObject({
				reviewerMinutes: z.number().int().positive().default(DEFAULT_TIMEOUTS.reviewerMinutes),
				requiredCheckMinutes: z
					.number()
					.int()
					.positive()
					.default(DEFAULT_TIMEOUTS.requiredCheckMinutes),
				quiescencePolls: z.number().int().positive().default(DEFAULT_TIMEOUTS.quiescencePolls),
			})
			.default(DEFAULT_TIMEOUTS),
		ceilings: z
			.strictObject({
				implementation: laneCeiling.optional(),
				feedback: laneCeiling.optional(),
				readyToMerge: laneCeiling.optional(),
			})
			.optional(),
	})
	.superRefine((profile, context) => {
		const reviewerIds = new Set(Object.keys(profile.reviewers));
		const required = profile.reviewPolicy.required;
		if (new Set(required).size !== required.length) {
			context.addIssue({
				code: "custom",
				path: ["reviewPolicy", "required"],
				message: "required reviewer ids must be unique",
			});
		}
		for (const reviewerId of required) {
			if (!reviewerIds.has(reviewerId)) {
				context.addIssue({
					code: "custom",
					path: ["reviewPolicy", "required"],
					message: `required reviewer '${reviewerId}' has no reviewer configuration`,
				});
			}
		}

		const optionalOwnerLabel = profile.reviewPolicy.optionalOwnerLabel;
		if (
			optionalOwnerLabel !== undefined &&
			Object.values(profile.labels).includes(optionalOwnerLabel)
		) {
			context.addIssue({
				code: "custom",
				path: ["reviewPolicy", "optionalOwnerLabel"],
				message: "optional owner-review label must not duplicate a lifecycle label",
			});
		}
	});

export const ProjectProfilesSchema = z
	.array(ProjectProfileSchema)
	.min(1)
	.superRefine((profiles, context) => {
		for (const key of ["id", "repository"] as const) {
			const values = profiles.map((profile) => profile[key].toLowerCase());
			if (new Set(values).size !== values.length) {
				context.addIssue({
					code: "custom",
					message: `project profile ${key} values must be unique`,
				});
			}
		}
	});

export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export class ProjectProfileFileError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProjectProfileFileError";
	}
}

const MAX_PROFILE_BYTES = 1024 * 1024;

export function parseProjectProfile(input: unknown): ProjectProfile {
	return ProjectProfileSchema.parse(input);
}

export function parseProjectProfileYaml(source: string): ProjectProfile {
	if (new TextEncoder().encode(source).byteLength > MAX_PROFILE_BYTES) {
		throw new ProjectProfileFileError("project profile exceeds the 1 MiB size limit");
	}

	let input: unknown;
	try {
		input = parse(source, { maxAliasCount: 0, uniqueKeys: true });
	} catch (error) {
		throw new ProjectProfileFileError("project profile is not valid YAML", { cause: error });
	}

	return parseProjectProfile(input);
}

export async function loadProjectProfileFile(
	path: string,
	fileSystem: FileSystemAdapter,
): Promise<ProjectProfile> {
	const metadata = await fileSystem.stat(path);
	if (metadata.kind !== "file") {
		throw new ProjectProfileFileError("project profile must be a regular file");
	}
	if ((metadata.mode & 0o777) !== 0o600) {
		throw new ProjectProfileFileError("project profile permissions must be exactly mode 0600");
	}

	return parseProjectProfileYaml(await fileSystem.readText(path));
}
