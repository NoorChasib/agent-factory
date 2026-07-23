import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecutionRecord,
  GitHubAllowedMutation,
  GitHubLabelGateway,
  GitHubProjectObservation,
  GitHubProjectSnapshot,
  GitHubPullRequestObservation,
  LaunchRequest,
  LedgerIdSource,
  ProjectProfile,
  RepositoryLabel,
  SqliteLedger,
  StopRequest,
  WorkerProcessAdapter,
} from "../src";
import {
  assertAllowedGitHubMutation,
  CanonicalStageManager,
  createController,
  FactoryCustodyPaths,
  GitHubAppTokenBroker,
  GitHubMutationExecutor,
  openSqliteLedger,
  parseProjectProfile,
  parseProjectProfileYaml,
  ReviewConvergenceEngine,
  WorktreeCustody,
} from "../src";
import {
  createInitialControllerState,
  FixedClockAdapter,
  InMemoryFileSystemAdapter,
  InMemoryGitCustodyAdapter,
  InMemoryGitHubAdapter,
  InMemoryNotificationAdapter,
  ScriptedGitHubTransport,
  SequenceRandomAdapter,
} from "../src/testing";

const repositoryRoot = join(import.meta.dir, "..");
const profileRoot = join(repositoryRoot, "config", "examples", "multi-project", "profiles");
const hhcProfile = parseProjectProfile({
  ...parseProjectProfileYaml(readFileSync(join(profileRoot, "hhc-aep.yaml"), "utf8")),
  enabled: true,
});
const lumenProfile = parseProjectProfile({
  ...parseProjectProfileYaml(readFileSync(join(profileRoot, "lumen-notes.yaml"), "utf8")),
  enabled: true,
});
const profiles = [hhcProfile, lumenProfile] as const;
const headA = "1111111111111111111111111111111111111111";
const headB = "2222222222222222222222222222222222222222";

class LedgerIds implements LedgerIdSource {
  #sequence = 0;

  public nextId(
    kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session",
  ): string {
    this.#sequence += 1;
    return `${kind}-${this.#sequence}`;
  }
}

function observation(
  profile: ProjectProfile,
  pullRequests: readonly GitHubPullRequestObservation[],
): GitHubProjectObservation {
  return {
    projectId: profile.id,
    issues: [],
    pullRequests: [...pullRequests],
  };
}

function pullRequest(
  profile: ProjectProfile,
  number: number,
  stage: "feedbackReady" | "inProgress" | "readyToMerge",
  values: Partial<GitHubPullRequestObservation> = {},
): GitHubPullRequestObservation {
  return {
    number,
    state: "open",
    labels: [profile.labels[stage]],
    linkedIssueNumber: number,
    branch: `factory/issue-${number}`,
    headSha: profile.id === hhcProfile.id ? headA : headB,
    ...values,
  };
}

function controllerState() {
  const state = createInitialControllerState(profiles);
  state.mode = "active";
  return state;
}

class SessionRecordingWorkers implements WorkerProcessAdapter {
  readonly starts: LaunchRequest[] = [];
  readonly stops: StopRequest[] = [];
  #sequence = 0;
  readonly #ledger: SqliteLedger;

  public constructor(ledger: SqliteLedger) {
    this.#ledger = ledger;
  }

  public async start(request: LaunchRequest): Promise<unknown> {
    this.starts.push(structuredClone(request));
    this.#sequence += 1;
    return {
      executionId: `${request.projectId}-feedback-${this.#sequence}`,
      projectId: request.projectId,
      lane: request.lane,
      provider: request.provider,
      workflow: request.workflow,
      claimState: "awaiting-verification",
      issueNumber: request.issueNumber,
      pullRequestNumber: request.pullRequestNumber,
      branch: request.branch,
      worktreeId:
        request.issueNumber === null ? null : `${request.projectId}-issue-${request.issueNumber}`,
      headSha: request.headSha,
      status: "active",
    };
  }

  public async activate(execution: ExecutionRecord): Promise<void> {
    const attempt = this.#ledger.startAttempt(execution.executionId);
    this.#ledger.registerProviderSession({
      executionId: execution.executionId,
      attemptNumber: attempt.attemptNumber,
      provider: execution.provider,
      providerSessionId: `${execution.projectId}-session-${execution.pullRequestNumber ?? "selector"}`,
      model: execution.provider === "codex" ? "gpt-fixture" : "claude-fixture",
      reasoningEffort: "high",
      runtimeMetadata: {
        projectId: execution.projectId,
        pullRequestNumber: execution.pullRequestNumber,
      },
    });
  }

  public async stop(request: StopRequest): Promise<void> {
    this.stops.push(structuredClone(request));
  }
}

class MemoryStageGateway implements GitHubLabelGateway {
  readonly #labels = new Map<string, string[]>();

  public set(
    projectId: string,
    subjectType: "issue" | "pull-request",
    subjectNumber: number,
    labels: readonly string[],
  ): void {
    this.#labels.set(this.#key(projectId, subjectType, subjectNumber), [...labels]);
  }

  public read(
    projectId: string,
    subjectType: "issue" | "pull-request",
    subjectNumber: number,
  ): readonly string[] {
    return [...(this.#labels.get(this.#key(projectId, subjectType, subjectNumber)) ?? [])];
  }

  public async apply(input: unknown): Promise<void> {
    const mutation = assertAllowedGitHubMutation(input);
    if (mutation.kind !== "add-label" && mutation.kind !== "remove-label") {
      throw new Error("multi-project stage fixture accepts label transitions only");
    }
    const key = this.#key(mutation.projectId, mutation.subjectType, mutation.subjectNumber);
    const labels = new Set(this.#labels.get(key) ?? []);
    if (mutation.kind === "add-label") {
      labels.add(mutation.label);
    } else {
      labels.delete(mutation.label);
    }
    this.#labels.set(key, [...labels]);
  }

  public async verify(input: GitHubAllowedMutation): Promise<boolean> {
    if (input.kind !== "add-label" && input.kind !== "remove-label") {
      return false;
    }
    const present = this.read(input.projectId, input.subjectType, input.subjectNumber).includes(
      input.label,
    );
    return input.kind === "add-label" ? present : !present;
  }

  public async readSubjectLabels(
    projectId: string,
    subjectType: "issue" | "pull-request",
    subjectNumber: number,
  ): Promise<readonly string[]> {
    return this.read(projectId, subjectType, subjectNumber);
  }

  public async listRepositoryLabels(): Promise<readonly RepositoryLabel[]> {
    return [];
  }

  #key(projectId: string, subjectType: string, subjectNumber: number): string {
    return `${projectId}:${subjectType}:${subjectNumber}`;
  }
}

function convergenceSnapshot(
  profile: ProjectProfile,
  pullRequestNumber: number,
  headSha: string,
): GitHubProjectSnapshot {
  const reviews =
    profile.id === hhcProfile.id
      ? [
          {
            login: "codex",
            state: "APPROVED" as const,
            submittedAt: "2026-07-23T00:00:00.000Z",
            headSha,
          },
          {
            login: "github-copilot",
            state: "APPROVED" as const,
            submittedAt: "2026-07-23T00:00:00.000Z",
            headSha,
          },
        ]
      : [];
  const checks =
    profile.id === lumenProfile.id
      ? [
          {
            name: "verify",
            appSlug: "example-ci",
            status: "completed" as const,
            conclusion: "SUCCESS" as const,
            headSha,
          },
          {
            name: "automated-review",
            appSlug: "review-bot",
            status: "completed" as const,
            conclusion: "SUCCESS" as const,
            headSha,
          },
        ]
      : [];
  return {
    projectId: profile.id,
    repository: profile.repository,
    issues: [],
    requiredCheckNames: [],
    pullRequests: [
      {
        number: pullRequestNumber,
        state: "open",
        draft: false,
        labels: [profile.labels.inProgress],
        linkedIssueNumber: pullRequestNumber,
        branch: `factory/issue-${pullRequestNumber}`,
        headSha,
        updatedAt: "2026-07-23T00:00:00.000Z",
        mergedAt: null,
        mergeability: "mergeable",
        reviewDecision: "approved",
        commentCount: 0,
        latestCommentAt: null,
        reviews,
        unresolvedThreads: 0,
        checks,
      },
    ],
  };
}

async function withLedger(
  name: string,
  run: (ledger: SqliteLedger, directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `agent-factory-${name}-`));
  const ledger = openSqliteLedger({
    stateDirectory: directory,
    instanceId: `${name}-controller`,
    clock: new FixedClockAdapter(),
    ids: new LedgerIds(),
    initialState: controllerState(),
  });
  try {
    await run(ledger, directory);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("multi-project isolation proof", () => {
  test("keeps concurrent work, stages, sessions, mutations, baselines, and counts target-scoped", async () => {
    await withLedger("project-isolation", async (ledger) => {
      const github = new InMemoryGitHubAdapter([
        observation(hhcProfile, [pullRequest(hhcProfile, 50, "feedbackReady")]),
        observation(lumenProfile, [pullRequest(lumenProfile, 50, "feedbackReady")]),
      ]);
      const workers = new SessionRecordingWorkers(ledger);
      const controller = createController(
        {
          profiles,
          limits: { implementation: 3, feedback: 2, readyToMerge: 3 },
          polling: { intervalMs: 60_000, jitterRatio: 0 },
        },
        {
          github,
          clock: new FixedClockAdapter(),
          random: new SequenceRandomAdapter(),
          fileSystem: new InMemoryFileSystemAdapter(),
          processes: workers,
          notifications: new InMemoryNotificationAdapter(),
          ledger,
        },
      );

      const concurrent = await controller.reconcile({ reason: "capacity" });
      expect(concurrent.startedExecutionIds).toHaveLength(2);
      expect(workers.starts.map((request) => request.projectId)).toEqual([
        hhcProfile.id,
        lumenProfile.id,
      ]);

      const executions = ledger.listExecutions();
      expect(new Set(executions.map((execution) => execution.worktreeId)).size).toBe(2);
      const hhcExecution = executions.find((execution) => execution.projectId === hhcProfile.id);
      const lumenExecution = executions.find(
        (execution) => execution.projectId === lumenProfile.id,
      );
      expect(hhcExecution).toBeDefined();
      expect(lumenExecution).toBeDefined();
      if (hhcExecution === undefined || lumenExecution === undefined) {
        throw new Error("missing concurrent fixture execution");
      }
      expect(ledger.readExecutionRecovery(hhcExecution.executionId).sessions[0]).toMatchObject({
        providerSessionId: "hhc-aep-session-50",
        runtimeMetadata: { projectId: hhcProfile.id, pullRequestNumber: 50 },
      });
      expect(ledger.readExecutionRecovery(lumenExecution.executionId).sessions[0]).toMatchObject({
        providerSessionId: "lumen-notes-session-50",
        runtimeMetadata: { projectId: lumenProfile.id, pullRequestNumber: 50 },
      });
      expect(ledger.findCodexSessionForPullRequest(hhcProfile.id, 50)?.executionId).toBe(
        hhcExecution.executionId,
      );
      expect(ledger.findCodexSessionForPullRequest(lumenProfile.id, 50)?.executionId).toBe(
        lumenExecution.executionId,
      );

      const custodyPaths = new FactoryCustodyPaths({
        mirrorBaseDirectory: "/factory-fixture/mirrors",
        worktreeBaseDirectory: "/factory-fixture/worktrees",
        protectedCheckoutDirectories: ["/operator/checkout"],
      });
      const custody = new WorktreeCustody(new InMemoryGitCustodyAdapter(custodyPaths));
      const hhcWorktree = await custody.createIssueWorktree({
        projectId: hhcProfile.id,
        repository: hhcProfile.repository,
        issueNumber: 50,
        branch: "factory/issue-50",
        startPoint: hhcProfile.defaultBranch,
      });
      const lumenWorktree = await custody.createIssueWorktree({
        projectId: lumenProfile.id,
        repository: lumenProfile.repository,
        issueNumber: 50,
        branch: "factory/issue-50",
        startPoint: lumenProfile.defaultBranch,
      });
      expect(hhcWorktree.path).not.toBe(lumenWorktree.path);
      expect(hhcWorktree.worktreeId).not.toBe(lumenWorktree.worktreeId);

      const stageGateway = new MemoryStageGateway();
      stageGateway.set(hhcProfile.id, "issue", 60, [hhcProfile.labels.implementationReady]);
      stageGateway.set(lumenProfile.id, "issue", 60, [lumenProfile.labels.implementationReady]);
      const mutations = new GitHubMutationExecutor(ledger, stageGateway);
      const hhcStages = new CanonicalStageManager(hhcProfile, mutations);
      const lumenStages = new CanonicalStageManager(lumenProfile, mutations);
      expect(
        await hhcStages.transition({
          subjectType: "issue",
          subjectNumber: 60,
          expectedStage: "ready-for-implementation-agent",
          desiredStage: "in-progress",
          executionId: null,
          operationKey: "shared-stage-60",
        }),
      ).toMatchObject({ verified: true });
      expect(
        await lumenStages.transition({
          subjectType: "issue",
          subjectNumber: 60,
          expectedStage: "ready-for-implementation-agent",
          desiredStage: "in-progress",
          executionId: null,
          operationKey: "shared-stage-60",
        }),
      ).toMatchObject({ verified: true });
      expect(stageGateway.read(hhcProfile.id, "issue", 60)).toEqual([hhcProfile.labels.inProgress]);
      expect(stageGateway.read(lumenProfile.id, "issue", 60)).toEqual([
        lumenProfile.labels.inProgress,
      ]);
      const mutationProjects = ledger.listMutations().map((mutation) => mutation.projectId);
      expect(mutationProjects.filter((projectId) => projectId === hhcProfile.id)).toHaveLength(2);
      expect(mutationProjects.filter((projectId) => projectId === lumenProfile.id)).toHaveLength(2);
      expect(new Set(ledger.listMutations().map((mutation) => mutation.idempotencyKey)).size).toBe(
        4,
      );

      const convergence = new ReviewConvergenceEngine(new FixedClockAdapter(), ledger);
      expect(
        convergence.evaluate({
          profile: hhcProfile,
          snapshot: convergenceSnapshot(hhcProfile, 80, headA),
          pullRequestNumber: 80,
          headObservedAt: "2026-07-23T00:00:00.000Z",
        }).action,
      ).toBe("wait-for-quiescence");
      expect(
        convergence.evaluate({
          profile: lumenProfile,
          snapshot: convergenceSnapshot(lumenProfile, 80, headB),
          pullRequestNumber: 80,
          headObservedAt: "2026-07-23T00:00:00.000Z",
        }).action,
      ).toBe("wait-for-quiescence");
      expect(ledger.getReviewBaseline(hhcProfile.id, 80)?.headSha).toBe(headA);
      expect(ledger.getReviewBaseline(lumenProfile.id, 80)?.headSha).toBe(headB);

      github.setObservations([
        observation(hhcProfile, [
          pullRequest(hhcProfile, 50, "inProgress"),
          pullRequest(hhcProfile, 70, "readyToMerge"),
          pullRequest(hhcProfile, 71, "readyToMerge"),
        ]),
        observation(lumenProfile, [
          pullRequest(lumenProfile, 50, "inProgress"),
          pullRequest(lumenProfile, 70, "readyToMerge"),
        ]),
      ]);
      const status = await controller.status();
      expect(
        status.projects.map((project) => ({
          id: project.id,
          readyToMerge: project.readyToMerge,
        })),
      ).toEqual([
        { id: hhcProfile.id, readyToMerge: 2 },
        { id: lumenProfile.id, readyToMerge: 1 },
      ]);
    });
  });

  test("keeps GitHub App installation and token caches keyed per enabled target", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const credentialPath = "/run/credentials/agent-factory/github-app.pem";
    const installationFixture = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "github", "installation.json"), "utf8"),
    ) as Record<string, unknown>;
    const tokenFixture = JSON.parse(
      readFileSync(join(import.meta.dir, "fixtures", "github", "installation-token.json"), "utf8"),
    ) as Record<string, unknown>;
    const response = (status: number, body: unknown) => ({
      kind: "response" as const,
      response: { status, headers: {}, body: JSON.stringify(body) },
    });
    const transport = new ScriptedGitHubTransport([
      response(200, { ...installationFixture, id: 7101 }),
      response(201, { ...tokenFixture, token: "fixture-hhc-token" }),
      response(200, { ...installationFixture, id: 7102 }),
      response(201, { ...tokenFixture, token: "fixture-lumen-token" }),
    ]);
    const broker = new GitHubAppTokenBroker({
      environment: {
        AGENT_FACTORY_GITHUB_APP_ID: "1234",
        AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: credentialPath,
      },
      profiles,
      fileSystem: new InMemoryFileSystemAdapter({
        [credentialPath]: {
          content: privateKeyPem,
          metadata: { kind: "file", mode: 0o400 },
        },
      }),
      clock: new FixedClockAdapter(),
      transport,
      apiUrl: "https://api.github.test",
    });

    expect(await broker.tokenForProject(hhcProfile.id)).toBe("fixture-hhc-token");
    expect(await broker.tokenForProject(hhcProfile.id)).toBe("fixture-hhc-token");
    expect(await broker.tokenForProject(lumenProfile.id)).toBe("fixture-lumen-token");
    expect(await broker.tokenForProject(lumenProfile.id)).toBe("fixture-lumen-token");
    expect(transport.requests.map((request) => request.url)).toEqual([
      `https://api.github.test/repos/${hhcProfile.repository}/installation`,
      "https://api.github.test/app/installations/7101/access_tokens",
      `https://api.github.test/repos/${lumenProfile.repository}/installation`,
      "https://api.github.test/app/installations/7102/access_tokens",
    ]);
    expect(
      transport.requests
        .filter((request) => request.method === "POST")
        .map((request) => JSON.parse(request.body ?? "{}")),
    ).toEqual([
      expect.objectContaining({ repositories: ["HHC-AEP"] }),
      expect.objectContaining({ repositories: ["lumen-notes"] }),
    ]);
  });
});

describe("multi-project fair rotation proof", () => {
  test("alternates eligible projects over repeated reconciles", async () => {
    await withLedger("project-fairness", async (ledger) => {
      const github = new InMemoryGitHubAdapter([
        observation(hhcProfile, [pullRequest(hhcProfile, 10, "feedbackReady")]),
        observation(lumenProfile, [pullRequest(lumenProfile, 10, "feedbackReady")]),
      ]);
      const workers = new SessionRecordingWorkers(ledger);
      const controller = createController(
        {
          profiles,
          limits: { implementation: 0, feedback: 1, readyToMerge: 3 },
          polling: { intervalMs: 60_000, jitterRatio: 0 },
        },
        {
          github,
          clock: new FixedClockAdapter(),
          random: new SequenceRandomAdapter(),
          fileSystem: new InMemoryFileSystemAdapter(),
          processes: workers,
          notifications: new InMemoryNotificationAdapter(),
          ledger,
        },
      );

      await controller.reconcile({ reason: "capacity" });
      github.setObservations([
        observation(hhcProfile, [pullRequest(hhcProfile, 10, "inProgress", { state: "merged" })]),
        observation(lumenProfile, [pullRequest(lumenProfile, 10, "feedbackReady")]),
      ]);
      await controller.reconcile({ reason: "change" });
      github.setObservations([
        observation(hhcProfile, [
          pullRequest(hhcProfile, 10, "inProgress", { state: "merged" }),
          pullRequest(hhcProfile, 11, "feedbackReady"),
        ]),
        observation(lumenProfile, [
          pullRequest(lumenProfile, 10, "inProgress", { state: "merged" }),
        ]),
      ]);
      await controller.reconcile({ reason: "change" });
      github.setObservations([
        observation(hhcProfile, [pullRequest(hhcProfile, 11, "inProgress", { state: "merged" })]),
        observation(lumenProfile, [
          pullRequest(lumenProfile, 10, "inProgress", { state: "merged" }),
          pullRequest(lumenProfile, 11, "feedbackReady"),
        ]),
      ]);
      await controller.reconcile({ reason: "change" });

      expect(workers.starts.map((request) => request.projectId)).toEqual([
        hhcProfile.id,
        lumenProfile.id,
        hhcProfile.id,
        lumenProfile.id,
      ]);
      expect(workers.stops).toHaveLength(3);
      expect((await ledger.read()).state.rotation.feedback).toBe(lumenProfile.id);
    });
  });
});
