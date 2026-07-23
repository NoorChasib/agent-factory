import { parse } from "yaml";
import { z } from "zod";
import type { FileSystemAdapter } from "../adapters/interfaces";
import { ProjectLabelMappingSchema } from "../domain/stages";

const safeIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);

const workflowEntryPoint = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:/-]*[A-Za-z0-9])?$/u);

const githubLogin = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u);

const githubLabel = z
  .string()
  .min(1)
  .max(50)
  .refine((value) => value.trim() === value, "label must not have surrounding whitespace")
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
      }),
    "label must not contain controls",
  );

const githubRepository = z
  .string()
  .min(3)
  .max(201)
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    "repository must be an owner/name GitHub repository",
  );

function hasForbiddenGitCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      "~^:?*[\\\\".includes(character)
    );
  });
}

const gitBranch = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value, "branch must not have surrounding whitespace")
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !hasForbiddenGitCharacter(value),
    "defaultBranch must be a valid Git branch name",
  );

const reviewCompletionSignal = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pull-request-review"),
  }),
  z.strictObject({
    kind: z.literal("check-run"),
    name: z.string().min(1).max(255),
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
  name: z.string().min(1).max(255),
  appSlug: githubLogin.optional(),
});

const laneCeiling = z.number().int().min(0).max(3);

export const ProjectProfileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: safeIdentifier,
    enabled: z.boolean(),
    repository: githubRepository,
    defaultBranch: gitBranch,
    workflow: z.strictObject({
      implement: workflowEntryPoint,
      feedback: workflowEntryPoint,
      operatorImplement: workflowEntryPoint,
      operatorFeedback: workflowEntryPoint,
    }),
    labels: ProjectLabelMappingSchema,
    reviewPolicy: z.strictObject({
      required: z.array(safeIdentifier).min(1),
      optionalOwnerLabel: githubLabel.optional(),
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
    reviewers: z.record(safeIdentifier, reviewer),
    issueSelection: z.strictObject({
      owner: z.literal("project-workflow"),
      controllerProvidesIssueNumber: z.literal(false),
    }),
    timeouts: z.strictObject({
      reviewerMinutes: z.number().int().positive(),
      requiredCheckMinutes: z.number().int().positive(),
      quiescencePolls: z.number().int().positive(),
    }),
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
