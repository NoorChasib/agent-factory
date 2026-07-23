import { z } from "zod";

import { stageLabelName } from "../contracts/primitives";

export const CANONICAL_STAGES = [
  "needs-triage",
  "needs-info",
  "ready-for-implementation-agent",
  "ready-for-human",
  "in-progress",
  "ready-for-feedback-agent",
  "ready-to-merge",
] as const;

export const CANONICAL_CONDITIONS = [
  "worker-stalled",
  "review-stalled",
  "needs-respec",
  "blocked-external",
] as const;

export const CanonicalStageSchema = z.enum(CANONICAL_STAGES);
export const CanonicalConditionSchema = z.enum(CANONICAL_CONDITIONS);

export type CanonicalStage = z.infer<typeof CanonicalStageSchema>;
export type CanonicalCondition = z.infer<typeof CanonicalConditionSchema>;

export const CANONICAL_STAGE_SEMANTICS = {
  "needs-triage": {
    subjects: ["issue"],
    meaning: "Classification or tracker repair is required.",
  },
  "needs-info": {
    subjects: ["issue"],
    meaning: "Required information is unavailable.",
  },
  "ready-for-implementation-agent": {
    subjects: ["issue"],
    meaning: "The issue is eligible for autonomous implementation selection.",
  },
  "ready-for-human": {
    subjects: ["issue"],
    meaning: "Only an attended operator workflow may select the issue.",
  },
  "in-progress": {
    subjects: ["issue", "pull-request"],
    meaning: "A verified worker or operator owns the subject.",
  },
  "ready-for-feedback-agent": {
    subjects: ["pull-request"],
    meaning: "Actionable feedback or a repairable current-head failure is ready.",
  },
  "ready-to-merge": {
    subjects: ["pull-request"],
    meaning: "All configured convergence conditions currently hold.",
  },
} as const satisfies Record<
  CanonicalStage,
  {
    readonly subjects: readonly ("issue" | "pull-request")[];
    readonly meaning: string;
  }
>;

export const CANONICAL_CONDITION_SEMANTICS = {
  "worker-stalled": "The worker cannot make verified progress.",
  "review-stalled": "A required review did not produce a completion signal in time.",
  "needs-respec": "The subject requires specification repair before autonomous continuation.",
  "blocked-external": "An external dependency prevents continuation.",
} as const satisfies Record<CanonicalCondition, string>;

export const ProjectLabelMappingSchema = z
  .strictObject({
    needsTriage: stageLabelName,
    needsInfo: stageLabelName,
    implementationReady: stageLabelName,
    operatorReady: stageLabelName,
    inProgress: stageLabelName,
    feedbackReady: stageLabelName,
    readyToMerge: stageLabelName,
    workerStalled: stageLabelName,
    reviewStalled: stageLabelName,
    needsRespec: stageLabelName,
    blockedExternal: stageLabelName,
  })
  .superRefine((mapping, context) => {
    const labels = Object.values(mapping);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({
        code: "custom",
        message: "every canonical stage and condition must map to a distinct label",
      });
    }
  });

export type ProjectLabelMapping = z.infer<typeof ProjectLabelMappingSchema>;

const STAGE_KEYS = {
  "needs-triage": "needsTriage",
  "needs-info": "needsInfo",
  "ready-for-implementation-agent": "implementationReady",
  "ready-for-human": "operatorReady",
  "in-progress": "inProgress",
  "ready-for-feedback-agent": "feedbackReady",
  "ready-to-merge": "readyToMerge",
} as const satisfies Record<CanonicalStage, keyof ProjectLabelMapping>;

const CONDITION_KEYS = {
  "worker-stalled": "workerStalled",
  "review-stalled": "reviewStalled",
  "needs-respec": "needsRespec",
  "blocked-external": "blockedExternal",
} as const satisfies Record<CanonicalCondition, keyof ProjectLabelMapping>;

export interface ResolvedLabels {
  readonly stage: CanonicalStage | null;
  readonly conditions: readonly CanonicalCondition[];
  readonly conflictingStages: readonly CanonicalStage[];
}

export function resolveCanonicalLabels(
  mapping: ProjectLabelMapping,
  labels: readonly string[],
): ResolvedLabels {
  const present = new Set(labels);
  const stages = CANONICAL_STAGES.filter((stage) => present.has(mapping[STAGE_KEYS[stage]]));
  const conditions = CANONICAL_CONDITIONS.filter((condition) =>
    present.has(mapping[CONDITION_KEYS[condition]]),
  );

  return {
    stage: stages.length === 1 ? (stages[0] ?? null) : null,
    conditions,
    conflictingStages: stages.length > 1 ? stages : [],
  };
}
