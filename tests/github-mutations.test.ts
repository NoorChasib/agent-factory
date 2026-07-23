import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertAllowedGitHubMutation,
  CanonicalStageManager,
  FORBIDDEN_GITHUB_MUTATION_KINDS,
  ForbiddenGitHubMutationError,
  type GitHubAllowedMutation,
  GitHubApiClient,
  type GitHubLabelGateway,
  GitHubMutationAmbiguousError,
  GitHubMutationExecutor,
  GuardedGitHubLabelApi,
  type LedgerIdSource,
  openSqliteLedger,
  type ProjectProfile,
  parseProjectProfile,
  parseProjectProfileYaml,
  type RepositoryLabel,
} from "../src";
import {
  createInitialControllerState,
  FixedClockAdapter,
  InMemoryGitHubMutationLedger,
  RecordingDelayAdapter,
  type ScriptedGitHubStep,
  ScriptedGitHubTransport,
} from "../src/testing";

const lumenProfile = parseProjectProfileYaml(
  await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);
const orbitProfile = parseProjectProfile({
  ...lumenProfile,
  id: "orbit-tasks",
  repository: "ExampleOrg/orbit-tasks",
  labels: {
    needsTriage: "orbit/triage",
    needsInfo: "orbit/needs-info",
    implementationReady: "orbit/implementation-ready",
    operatorReady: "orbit/operator",
    inProgress: "orbit/in-progress",
    feedbackReady: "orbit/feedback-ready",
    readyToMerge: "orbit/ready-to-merge",
    workerStalled: "orbit/worker-stalled",
    reviewStalled: "orbit/review-stalled",
    needsRespec: "orbit/needs-respec",
    blockedExternal: "orbit/blocked-external",
  },
});
const faultFixtures = (await Bun.file(
  new URL("fixtures/github/fault-scripts.json", import.meta.url),
).json()) as Record<string, ScriptedGitHubStep>;

class SequenceMutationIds {
  #next = 1;

  public nextMutationId(): string {
    const value = `mutation-${this.#next}`;
    this.#next += 1;
    return value;
  }
}

class LedgerIds implements LedgerIdSource {
  #next = 1;

  public nextId(
    kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session",
  ): string {
    const value = `${kind}-phase3-${this.#next}`;
    this.#next += 1;
    return value;
  }
}

function subjectKey(
  projectId: string,
  subjectType: "issue" | "pull-request",
  number: number,
): string {
  return `${projectId}:${subjectType}:${number}`;
}

class MemoryLabelGateway implements GitHubLabelGateway {
  readonly #subjects = new Map<string, string[]>();
  readonly #repositoryLabels = new Map<string, RepositoryLabel[]>();
  public readonly events: string[] = [];
  public readonly applyCalls: GitHubAllowedMutation[] = [];
  public ambiguousWrites = 0;
  public removeLabelAtRead: { readonly read: number; readonly label: string } | null = null;
  #reads = 0;

  public setSubject(
    projectId: string,
    subjectType: "issue" | "pull-request",
    number: number,
    labels: readonly string[],
  ): void {
    this.#subjects.set(subjectKey(projectId, subjectType, number), [...labels]);
  }

  public subject(
    projectId: string,
    subjectType: "issue" | "pull-request",
    number: number,
  ): readonly string[] {
    return [...(this.#subjects.get(subjectKey(projectId, subjectType, number)) ?? [])];
  }

  public async apply(input: unknown): Promise<void> {
    const mutation = assertAllowedGitHubMutation(input);
    this.events.push(`apply:${mutation.kind}`);
    this.applyCalls.push(mutation);
    if (this.ambiguousWrites > 0) {
      this.ambiguousWrites -= 1;
      throw new GitHubMutationAmbiguousError("transport");
    }
    if (mutation.kind === "add-label" || mutation.kind === "remove-label") {
      const key = subjectKey(mutation.projectId, mutation.subjectType, mutation.subjectNumber);
      const labels = new Set(this.#subjects.get(key) ?? []);
      if (mutation.kind === "add-label") {
        labels.add(mutation.label);
      } else {
        labels.delete(mutation.label);
      }
      this.#subjects.set(key, [...labels]);
      return;
    }
    const labels = this.#repositoryLabels.get(mutation.projectId) ?? [];
    if (mutation.kind === "create-label") {
      labels.push({
        name: mutation.name,
        color: mutation.color,
        description: mutation.description,
      });
    } else {
      const index = labels.findIndex((label) => label.name === mutation.currentName);
      if (index >= 0) {
        labels[index] = {
          name: mutation.name,
          color: mutation.color,
          description: mutation.description,
        };
      }
    }
    this.#repositoryLabels.set(mutation.projectId, labels);
  }

  public async verify(input: GitHubAllowedMutation): Promise<boolean> {
    this.events.push(`verify:${input.kind}`);
    if (input.kind === "add-label" || input.kind === "remove-label") {
      const labels = await this.readSubjectLabels(
        input.projectId,
        input.subjectType,
        input.subjectNumber,
      );
      return input.kind === "add-label"
        ? labels.includes(input.label)
        : !labels.includes(input.label);
    }
    return (await this.listRepositoryLabels(input.projectId)).some(
      (label) =>
        label.name === input.name &&
        label.color === input.color &&
        label.description === input.description,
    );
  }

  public async readSubjectLabels(
    projectId: string,
    subjectType: "issue" | "pull-request",
    subjectNumber: number,
  ): Promise<readonly string[]> {
    this.#reads += 1;
    this.events.push("read-labels");
    const key = subjectKey(projectId, subjectType, subjectNumber);
    const labels = [...(this.#subjects.get(key) ?? [])];
    if (this.removeLabelAtRead?.read === this.#reads) {
      const changed = labels.filter((label) => label !== this.removeLabelAtRead?.label);
      this.#subjects.set(key, changed);
      return changed;
    }
    return labels;
  }

  public async listRepositoryLabels(projectId: string): Promise<readonly RepositoryLabel[]> {
    return structuredClone(this.#repositoryLabels.get(projectId) ?? []);
  }
}

function setup(profile: ProjectProfile, gateway = new MemoryLabelGateway()) {
  const ledger = new InMemoryGitHubMutationLedger(
    new FixedClockAdapter(),
    new SequenceMutationIds(),
  );
  const executor = new GitHubMutationExecutor(ledger, gateway);
  return {
    gateway,
    ledger,
    executor,
    stages: new CanonicalStageManager(profile, executor),
  };
}

describe("guarded mutations and sequential verified claims", () => {
  test("adds in-progress, verifies it, removes the prior stage, and verifies the final claim", async () => {
    const state = setup(lumenProfile);
    state.gateway.setSubject(lumenProfile.id, "issue", 42, [
      lumenProfile.labels.implementationReady,
      "feature",
    ]);

    const result = await state.stages.claimIssue({
      issueNumber: 42,
      executionId: "execution-42",
      operationKey: "claim-42",
    });

    expect(result).toMatchObject({ verified: true, lost: false });
    expect(state.gateway.applyCalls.map((mutation) => mutation.kind)).toEqual([
      "add-label",
      "remove-label",
    ]);
    expect(state.gateway.subject(lumenProfile.id, "issue", 42)).toEqual([
      "feature",
      lumenProfile.labels.inProgress,
    ]);
    expect(state.ledger.listMutations().map((record) => record.state)).toEqual([
      "reconciled",
      "reconciled",
    ]);
    expect(state.gateway.events.indexOf("verify:add-label")).toBeLessThan(
      state.gateway.events.indexOf("apply:remove-label"),
    );
  });

  test("does not report a claim verified when another actor removes in-progress", async () => {
    const state = setup(lumenProfile);
    state.gateway.setSubject(lumenProfile.id, "issue", 43, [
      lumenProfile.labels.implementationReady,
    ]);
    state.gateway.removeLabelAtRead = {
      read: 3,
      label: lumenProfile.labels.inProgress,
    };

    const result = await state.stages.claimIssue({
      issueNumber: 43,
      executionId: "execution-43",
      operationKey: "claim-43",
    });

    expect(result).toMatchObject({ verified: false, lost: true });
    expect(state.gateway.applyCalls.map((mutation) => mutation.kind)).toEqual(["add-label"]);
    expect(state.gateway.subject(lumenProfile.id, "issue", 43)).toEqual([
      lumenProfile.labels.implementationReady,
    ]);
  });

  test("reconciles an ambiguous outcome before an explicit retry writes again", async () => {
    const state = setup(lumenProfile);
    state.gateway.setSubject(lumenProfile.id, "issue", 44, []);
    state.gateway.ambiguousWrites = 1;
    const mutation = {
      kind: "add-label",
      projectId: lumenProfile.id,
      subjectType: "issue",
      subjectNumber: 44,
      label: lumenProfile.labels.inProgress,
    } as const;

    expect(
      await state.executor.execute({
        operationKey: "ambiguous-claim",
        executionId: "execution-44",
        mutation,
      }),
    ).toMatchObject({
      status: "ambiguous",
      attempts: 1,
      reconciledBeforeWrite: false,
    });
    const eventsBeforeRetry = state.gateway.events.length;

    expect(
      await state.executor.execute({
        operationKey: "ambiguous-claim",
        executionId: "execution-44",
        mutation,
      }),
    ).toMatchObject({
      status: "verified",
      attempts: 2,
      reconciledBeforeWrite: true,
    });
    expect(state.gateway.events.slice(eventsBeforeRetry, eventsBeforeRetry + 2)).toEqual([
      "verify:add-label",
      "read-labels",
    ]);
    expect(state.gateway.events.slice(eventsBeforeRetry)).toContain("apply:add-label");
    expect(state.gateway.applyCalls).toHaveLength(2);
    expect(state.ledger.listMutations().map((record) => record.state)).toEqual([
      "reconciled",
      "reconciled",
    ]);
  });

  test("classifies the fixture transport's ambiguous write without retrying it", async () => {
    const ambiguousWrite = faultFixtures.ambiguousWrite;
    if (ambiguousWrite === undefined) {
      throw new Error("missing ambiguous-write fixture");
    }
    const transport = new ScriptedGitHubTransport([ambiguousWrite]);
    const gateway = new GuardedGitHubLabelApi({
      profiles: [lumenProfile],
      client: new GitHubApiClient({
        transport,
        delay: new RecordingDelayAdapter(),
        apiUrl: "https://api.github.test",
      }),
      transport,
      tokens: {
        tokenForProject: async () => "fixture-token",
      },
      apiUrl: "https://api.github.test",
    });

    await expect(
      gateway.apply({
        kind: "add-label",
        projectId: lumenProfile.id,
        subjectType: "issue",
        subjectNumber: 45,
        label: lumenProfile.labels.inProgress,
      }),
    ).rejects.toMatchObject({
      name: "GitHubMutationAmbiguousError",
      classification: "transport",
    });
    expect(transport.requests).toHaveLength(1);
  });

  test("uses the Phase 2 SqliteLedger through the narrow mutation repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-factory-phase3-ledger-"));
    try {
      const clock = new FixedClockAdapter();
      const ledger = openSqliteLedger({
        stateDirectory: directory,
        instanceId: "phase3-controller",
        clock,
        ids: new LedgerIds(),
        initialState: createInitialControllerState([lumenProfile]),
      });
      const gateway = new MemoryLabelGateway();
      gateway.setSubject(lumenProfile.id, "issue", 46, []);
      const executor = new GitHubMutationExecutor(ledger, gateway);

      expect(
        await executor.execute({
          operationKey: "sqlite-integration",
          executionId: null,
          mutation: {
            kind: "add-label",
            projectId: lumenProfile.id,
            subjectType: "issue",
            subjectNumber: 46,
            label: lumenProfile.labels.inProgress,
          },
        }),
      ).toMatchObject({ status: "verified", attempts: 1 });
      expect(ledger.listMutations()).toMatchObject([
        {
          projectId: lumenProfile.id,
          state: "reconciled",
          kind: "add-label",
        },
      ]);
      ledger.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects every forbidden mutation kind before any transport-capable gateway is reached", () => {
    for (const kind of FORBIDDEN_GITHUB_MUTATION_KINDS) {
      expect(() => assertAllowedGitHubMutation({ kind })).toThrow(ForbiddenGitHubMutationError);
    }
    expect(() =>
      assertAllowedGitHubMutation({
        kind: "add-label",
        projectId: lumenProfile.id,
        subjectType: "issue",
        subjectNumber: 1,
        label: "ok",
        merge: true,
      }),
    ).toThrow(ForbiddenGitHubMutationError);
    expect(() =>
      assertAllowedGitHubMutation({
        kind: "update-label",
        projectId: lumenProfile.id,
        currentName: "existing",
        name: "renamed",
        color: "ffffff",
        description: "rename is not allowlisted",
      }),
    ).toThrow(ForbiddenGitHubMutationError);
  });

  test("keeps claims and ledger intents isolated by project", async () => {
    const gateway = new MemoryLabelGateway();
    gateway.setSubject(lumenProfile.id, "issue", 50, [lumenProfile.labels.implementationReady]);
    gateway.setSubject(orbitProfile.id, "issue", 50, [orbitProfile.labels.implementationReady]);
    const lumen = setup(lumenProfile, gateway);

    expect(
      await lumen.stages.claimIssue({
        issueNumber: 50,
        executionId: "lumen-execution",
        operationKey: "claim-50",
      }),
    ).toMatchObject({ verified: true });
    expect(gateway.subject(orbitProfile.id, "issue", 50)).toEqual([
      orbitProfile.labels.implementationReady,
    ]);
    expect(
      lumen.ledger.listMutations().every((record) => record.projectId === lumenProfile.id),
    ).toBe(true);
  });
});
