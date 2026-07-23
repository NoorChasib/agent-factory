import { createHash } from "node:crypto";
import { z } from "zod";
import { looseLabelName } from "../contracts/primitives";
import type { ProjectProfile } from "../contracts/project-profile";
import { CANONICAL_CONDITION_SEMANTICS, CANONICAL_STAGE_SEMANTICS } from "../domain/stages";
import type { GitHubMutationExecutor, RepositoryLabel } from "./mutations";

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const repositoryLabelSchema = z.strictObject({
  name: looseLabelName,
  color: z.string().regex(/^[0-9a-f]{6}$/u),
  description: z.string().max(100),
});

const desiredLabelSchema = repositoryLabelSchema.extend({
  semantic: z.string().min(1).max(100),
});

const createOperationSchema = z.strictObject({
  kind: z.literal("create"),
  desired: desiredLabelSchema,
});

const updateOperationSchema = z.strictObject({
  kind: z.literal("update"),
  current: repositoryLabelSchema,
  desired: desiredLabelSchema,
});

const planContentSchema = z.strictObject({
  version: z.literal(1),
  projectId: z.string().min(1).max(64),
  repository: z.string().min(3).max(201),
  sourceFingerprint: hashSchema,
  desiredLabels: z.array(desiredLabelSchema),
  operations: z.array(z.discriminatedUnion("kind", [createOperationSchema, updateOperationSchema])),
});

export const LabelMigrationPlanSchema = planContentSchema.extend({
  hash: hashSchema,
});

export type LabelMigrationPlan = z.infer<typeof LabelMigrationPlanSchema>;
export type LabelMigrationOperation = LabelMigrationPlan["operations"][number];

export class LabelMigrationApprovalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LabelMigrationApprovalError";
  }
}

export class LabelMigrationDriftError extends Error {
  public constructor() {
    super("repository labels drifted after the approved migration preview");
    this.name = "LabelMigrationDriftError";
  }
}

const LABEL_COLORS = {
  stage: "1d76db",
  ready: "0e8a16",
  handoff: "5319e7",
  condition: "b60205",
} as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalJson(input: unknown): string {
  return JSON.stringify(input);
}

function sourceLabels(labels: readonly RepositoryLabel[]): readonly RepositoryLabel[] {
  return labels
    .map((label) => repositoryLabelSchema.parse(label))
    .sort((left, right) => compareText(left.name, right.name));
}

export function fingerprintRepositoryLabels(labels: readonly RepositoryLabel[]): string {
  return sha256(canonicalJson(sourceLabels(labels)));
}

function desiredLabels(profile: ProjectProfile): LabelMigrationPlan["desiredLabels"] {
  return [
    {
      semantic: "needs-triage",
      name: profile.labels.needsTriage,
      color: LABEL_COLORS.stage,
      description: CANONICAL_STAGE_SEMANTICS["needs-triage"].meaning,
    },
    {
      semantic: "needs-info",
      name: profile.labels.needsInfo,
      color: LABEL_COLORS.stage,
      description: CANONICAL_STAGE_SEMANTICS["needs-info"].meaning,
    },
    {
      semantic: "ready-for-implementation-agent",
      name: profile.labels.implementationReady,
      color: LABEL_COLORS.ready,
      description: CANONICAL_STAGE_SEMANTICS["ready-for-implementation-agent"].meaning,
    },
    {
      semantic: "ready-for-human",
      name: profile.labels.operatorReady,
      color: LABEL_COLORS.handoff,
      description: CANONICAL_STAGE_SEMANTICS["ready-for-human"].meaning,
    },
    {
      semantic: "in-progress",
      name: profile.labels.inProgress,
      color: LABEL_COLORS.stage,
      description: CANONICAL_STAGE_SEMANTICS["in-progress"].meaning,
    },
    {
      semantic: "ready-for-feedback-agent",
      name: profile.labels.feedbackReady,
      color: LABEL_COLORS.ready,
      description: CANONICAL_STAGE_SEMANTICS["ready-for-feedback-agent"].meaning,
    },
    {
      semantic: "ready-to-merge",
      name: profile.labels.readyToMerge,
      color: LABEL_COLORS.handoff,
      description: CANONICAL_STAGE_SEMANTICS["ready-to-merge"].meaning,
    },
    {
      semantic: "worker-stalled",
      name: profile.labels.workerStalled,
      color: LABEL_COLORS.condition,
      description: CANONICAL_CONDITION_SEMANTICS["worker-stalled"],
    },
    {
      semantic: "review-stalled",
      name: profile.labels.reviewStalled,
      color: LABEL_COLORS.condition,
      description: CANONICAL_CONDITION_SEMANTICS["review-stalled"],
    },
    {
      semantic: "needs-respec",
      name: profile.labels.needsRespec,
      color: LABEL_COLORS.condition,
      description: CANONICAL_CONDITION_SEMANTICS["needs-respec"],
    },
    {
      semantic: "blocked-external",
      name: profile.labels.blockedExternal,
      color: LABEL_COLORS.condition,
      description: CANONICAL_CONDITION_SEMANTICS["blocked-external"],
    },
  ].sort((left, right) => compareText(left.semantic, right.semantic));
}

function planContent(plan: LabelMigrationPlan): z.infer<typeof planContentSchema> {
  const { hash: _hash, ...content } = plan;
  return planContentSchema.parse(content);
}

export function hashLabelMigrationPlanContent(content: z.infer<typeof planContentSchema>): string {
  return sha256(canonicalJson(planContentSchema.parse(content)));
}

export function planLabelMigration(
  profile: ProjectProfile,
  currentLabels: readonly RepositoryLabel[],
): LabelMigrationPlan {
  const current = sourceLabels(currentLabels);
  const byName = new Map(current.map((label) => [label.name, label]));
  const desired = desiredLabels(profile);
  const operations = desired.flatMap((label): LabelMigrationOperation[] => {
    const existing = byName.get(label.name);
    if (existing === undefined) {
      return [{ kind: "create", desired: label }];
    }
    if (existing.color !== label.color || existing.description !== label.description) {
      return [{ kind: "update", current: existing, desired: label }];
    }
    return [];
  });
  const content = planContentSchema.parse({
    version: 1,
    projectId: profile.id,
    repository: profile.repository,
    sourceFingerprint: fingerprintRepositoryLabels(current),
    desiredLabels: desired,
    operations,
  });
  return LabelMigrationPlanSchema.parse({
    ...content,
    hash: hashLabelMigrationPlanContent(content),
  });
}

export function renderLabelMigrationPreview(input: unknown): string {
  const plan = LabelMigrationPlanSchema.parse(input);
  const lines = [
    "Agent Factory label migration v1",
    `target: ${plan.projectId} (${plan.repository})`,
    `source: ${plan.sourceFingerprint}`,
    `operations: ${plan.operations.length}`,
  ];
  for (const operation of plan.operations) {
    lines.push(
      operation.kind === "create"
        ? `create ${JSON.stringify(operation.desired.name)} ${operation.desired.color} ${JSON.stringify(operation.desired.description)}`
        : `update ${JSON.stringify(operation.current.name)} ${operation.current.color}->${operation.desired.color} ${JSON.stringify(operation.desired.description)}`,
    );
  }
  lines.push(`approval-hash: ${plan.hash}`);
  return `${lines.join("\n")}\n`;
}

export function approveLabelMigration(input: unknown, exactHash: string): LabelMigrationPlan {
  const plan = LabelMigrationPlanSchema.parse(input);
  const recomputed = hashLabelMigrationPlanContent(planContent(plan));
  if (plan.hash !== recomputed || exactHash !== recomputed) {
    throw new LabelMigrationApprovalError(
      "label migration approval must exactly match the preview content hash",
    );
  }
  return plan;
}

export async function applyLabelMigration(input: {
  readonly profile: ProjectProfile;
  readonly plan: unknown;
  readonly approvedHash: string;
  readonly mutations: GitHubMutationExecutor;
}): Promise<readonly string[]> {
  const plan = approveLabelMigration(input.plan, input.approvedHash);
  const expectedDesired = desiredLabels(input.profile);
  const desiredMatches =
    plan.desiredLabels.length === expectedDesired.length &&
    plan.desiredLabels.every((label, index) => {
      const expected = expectedDesired[index];
      return (
        expected !== undefined &&
        label.semantic === expected.semantic &&
        label.name === expected.name &&
        label.color === expected.color &&
        label.description === expected.description
      );
    });
  if (
    plan.projectId !== input.profile.id ||
    plan.repository !== input.profile.repository ||
    !desiredMatches
  ) {
    throw new LabelMigrationApprovalError(
      "approved label migration does not match the selected target profile",
    );
  }
  const current = await input.mutations.gateway.listRepositoryLabels(input.profile.id, false);
  if (fingerprintRepositoryLabels(current) !== plan.sourceFingerprint) {
    throw new LabelMigrationDriftError();
  }

  const applied: string[] = [];
  for (const [index, operation] of plan.operations.entries()) {
    const mutation =
      operation.kind === "create"
        ? {
            kind: "create-label" as const,
            projectId: input.profile.id,
            name: operation.desired.name,
            color: operation.desired.color,
            description: operation.desired.description,
          }
        : {
            kind: "update-label" as const,
            projectId: input.profile.id,
            currentName: operation.current.name,
            name: operation.desired.name,
            color: operation.desired.color,
            description: operation.desired.description,
          };
    const result = await input.mutations.execute({
      operationKey: `label-migration:${plan.hash}:${index + 1}`,
      executionId: null,
      mutation,
    });
    if (result.status !== "verified") {
      throw new LabelMigrationDriftError();
    }
    applied.push(result.mutationId);
  }
  return applied;
}
