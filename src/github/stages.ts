import type { ProjectProfile } from "../contracts/project-profile";
import { CANONICAL_STAGES, type CanonicalStage, resolveCanonicalLabels } from "../domain/stages";
import type {
  GitHubAllowedMutation,
  GitHubMutationExecutionResult,
  GitHubMutationExecutor,
} from "./mutations";

export interface StageTransitionResult {
  readonly verified: boolean;
  readonly lost: boolean;
  readonly mutationResults: readonly GitHubMutationExecutionResult[];
  readonly observedLabels: readonly string[];
}

function stageLabel(profile: ProjectProfile, stage: CanonicalStage): string {
  switch (stage) {
    case "needs-triage":
      return profile.labels.needsTriage;
    case "needs-info":
      return profile.labels.needsInfo;
    case "ready-for-implementation-agent":
      return profile.labels.implementationReady;
    case "ready-for-human":
      return profile.labels.operatorReady;
    case "in-progress":
      return profile.labels.inProgress;
    case "ready-for-feedback-agent":
      return profile.labels.feedbackReady;
    case "ready-to-merge":
      return profile.labels.readyToMerge;
  }
}

function stageLabels(profile: ProjectProfile): readonly string[] {
  return CANONICAL_STAGES.map((stage) => stageLabel(profile, stage));
}

function operationKeyPart(label: string): string {
  return encodeURIComponent(label);
}

export class CanonicalStageManager {
  readonly #profile: ProjectProfile;
  readonly #mutations: GitHubMutationExecutor;

  public constructor(profile: ProjectProfile, mutations: GitHubMutationExecutor) {
    this.#profile = profile;
    this.#mutations = mutations;
  }

  public async claimIssue(input: {
    readonly issueNumber: number;
    readonly executionId: string;
    readonly operationKey: string;
  }): Promise<StageTransitionResult> {
    return this.transition({
      subjectType: "issue",
      subjectNumber: input.issueNumber,
      expectedStage: "ready-for-implementation-agent",
      desiredStage: "in-progress",
      executionId: input.executionId,
      operationKey: input.operationKey,
    });
  }

  public async transition(input: {
    readonly subjectType: "issue" | "pull-request";
    readonly subjectNumber: number;
    readonly expectedStage: CanonicalStage | null;
    readonly desiredStage: CanonicalStage;
    readonly executionId: string | null;
    readonly operationKey: string;
  }): Promise<StageTransitionResult> {
    const mutationResults: GitHubMutationExecutionResult[] = [];
    const before = await this.#mutations.gateway.readSubjectLabels(
      this.#profile.id,
      input.subjectType,
      input.subjectNumber,
    );
    const resolvedBefore = resolveCanonicalLabels(this.#profile.labels, before);
    if (
      resolvedBefore.stage !== input.expectedStage ||
      resolvedBefore.conflictingStages.length > 0
    ) {
      return {
        verified: false,
        lost: true,
        mutationResults,
        observedLabels: before,
      };
    }

    const desiredLabel = stageLabel(this.#profile, input.desiredStage);
    const desiredInitiallyPresent = before.includes(desiredLabel);
    if (!desiredInitiallyPresent) {
      const addMutation: GitHubAllowedMutation = {
        kind: "add-label",
        projectId: this.#profile.id,
        subjectType: input.subjectType,
        subjectNumber: input.subjectNumber,
        label: desiredLabel,
      };
      const result = await this.#mutations.execute({
        operationKey: `${input.operationKey}:add:${operationKeyPart(desiredLabel)}`,
        executionId: input.executionId,
        mutation: addMutation,
      });
      mutationResults.push(result);
      if (result.status !== "verified") {
        return this.#unverifiedTransition(input, result.status === "not-observed", mutationResults);
      }
    }

    const afterAdd = await this.#mutations.gateway.readSubjectLabels(
      this.#profile.id,
      input.subjectType,
      input.subjectNumber,
    );
    if (!afterAdd.includes(desiredLabel)) {
      return {
        verified: false,
        lost: true,
        mutationResults,
        observedLabels: afterAdd,
      };
    }
    const expectedLabel =
      input.expectedStage === null ? null : stageLabel(this.#profile, input.expectedStage);
    const allowedDuringTransition = new Set(
      expectedLabel === null ? [desiredLabel] : [expectedLabel, desiredLabel],
    );
    const unexpectedStages = stageLabels(this.#profile).filter(
      (label) => afterAdd.includes(label) && !allowedDuringTransition.has(label),
    );
    if (unexpectedStages.length > 0) {
      if (!desiredInitiallyPresent && afterAdd.includes(desiredLabel)) {
        const cleanup = await this.#mutations.execute({
          operationKey: `${input.operationKey}:lost-cleanup:${operationKeyPart(desiredLabel)}`,
          executionId: input.executionId,
          mutation: {
            kind: "remove-label",
            projectId: this.#profile.id,
            subjectType: input.subjectType,
            subjectNumber: input.subjectNumber,
            label: desiredLabel,
          },
        });
        mutationResults.push(cleanup);
      }
      return this.#unverifiedTransition(input, true, mutationResults);
    }

    if (
      expectedLabel !== null &&
      expectedLabel !== desiredLabel &&
      afterAdd.includes(expectedLabel)
    ) {
      const result = await this.#mutations.execute({
        operationKey: `${input.operationKey}:remove:${operationKeyPart(expectedLabel)}`,
        executionId: input.executionId,
        mutation: {
          kind: "remove-label",
          projectId: this.#profile.id,
          subjectType: input.subjectType,
          subjectNumber: input.subjectNumber,
          label: expectedLabel,
        },
      });
      mutationResults.push(result);
      if (result.status !== "verified") {
        return this.#unverifiedTransition(input, result.status === "not-observed", mutationResults);
      }
    }

    const observedLabels = await this.#mutations.gateway.readSubjectLabels(
      this.#profile.id,
      input.subjectType,
      input.subjectNumber,
    );
    const resolved = resolveCanonicalLabels(this.#profile.labels, observedLabels);
    return {
      verified: resolved.stage === input.desiredStage,
      lost: resolved.stage !== input.desiredStage,
      mutationResults,
      observedLabels,
    };
  }

  async #unverifiedTransition(
    input: {
      readonly subjectType: "issue" | "pull-request";
      readonly subjectNumber: number;
    },
    lost: boolean,
    mutationResults: readonly GitHubMutationExecutionResult[],
  ): Promise<StageTransitionResult> {
    return {
      verified: false,
      lost,
      mutationResults,
      observedLabels: await this.#mutations.gateway.readSubjectLabels(
        this.#profile.id,
        input.subjectType,
        input.subjectNumber,
      ),
    };
  }

  public async revokeReadyToMerge(input: {
    readonly pullRequestNumber: number;
    readonly operationKey: string;
  }): Promise<StageTransitionResult> {
    const before = await this.#mutations.gateway.readSubjectLabels(
      this.#profile.id,
      "pull-request",
      input.pullRequestNumber,
    );
    if (!before.includes(this.#profile.labels.readyToMerge)) {
      return {
        verified: true,
        lost: false,
        mutationResults: [],
        observedLabels: before,
      };
    }
    const result = await this.#mutations.execute({
      operationKey: `${input.operationKey}:remove:${operationKeyPart(this.#profile.labels.readyToMerge)}`,
      executionId: null,
      mutation: {
        kind: "remove-label",
        projectId: this.#profile.id,
        subjectType: "pull-request",
        subjectNumber: input.pullRequestNumber,
        label: this.#profile.labels.readyToMerge,
      },
    });
    const observedLabels = await this.#mutations.gateway.readSubjectLabels(
      this.#profile.id,
      "pull-request",
      input.pullRequestNumber,
    );
    return {
      verified: !observedLabels.includes(this.#profile.labels.readyToMerge),
      lost: result.status === "not-observed",
      mutationResults: [result],
      observedLabels,
    };
  }
}
