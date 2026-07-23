import { describe, expect, test } from "bun:test";

import {
  GitHubApiClient,
  GitHubObservationResponseSchema,
  GitHubReadError,
  ProductionGitHubAdapter,
  type ProjectProfile,
  parseProjectProfile,
  parseProjectProfileYaml,
} from "../src";
import {
  RecordingDelayAdapter,
  type ScriptedGitHubStep,
  ScriptedGitHubTransport,
} from "../src/testing";

const lumenProfile = parseProjectProfileYaml(
  await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);
const lumenObservation = await Bun.file(
  new URL("fixtures/github/lumen-observation.json", import.meta.url),
).json();
const orbitObservation = await Bun.file(
  new URL("fixtures/github/orbit-observation.json", import.meta.url),
).json();
const faults = (await Bun.file(
  new URL("fixtures/github/fault-scripts.json", import.meta.url),
).json()) as Record<string, ScriptedGitHubStep>;

function fault(name: string): ScriptedGitHubStep {
  const step = faults[name];
  if (step === undefined) {
    throw new Error(`missing GitHub fault fixture '${name}'`);
  }
  return step;
}

const orbitProfile = parseProjectProfile({
  ...lumenProfile,
  id: "orbit-tasks",
  repository: "ExampleOrg/orbit-tasks",
  defaultBranch: "main",
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
  reviewPolicy: {
    required: ["orbit-review"],
  },
  requiredChecks: {
    source: "branch-protection",
    requireCurrentHead: true,
    checks: [],
  },
  reviewers: {
    "orbit-review": {
      identity: {
        kind: "github-user",
        login: "orbit-reviewer",
      },
      completionSignal: {
        kind: "pull-request-review",
      },
    },
  },
});

function response(body: unknown, etag = '"fixture-v1"'): ScriptedGitHubStep {
  return {
    kind: "response",
    response: {
      status: 200,
      headers: { etag },
      body: JSON.stringify(body),
    },
  };
}

function client(
  steps: readonly ScriptedGitHubStep[],
  options: { readonly attempts?: number; readonly base?: number; readonly max?: number } = {},
): {
  readonly client: GitHubApiClient;
  readonly transport: ScriptedGitHubTransport;
  readonly delay: RecordingDelayAdapter;
} {
  const transport = new ScriptedGitHubTransport(steps);
  const delay = new RecordingDelayAdapter();
  return {
    transport,
    delay,
    client: new GitHubApiClient({
      transport,
      delay,
      apiUrl: "https://api.github.test",
      maxReadAttempts: options.attempts ?? 3,
      baseBackoffMs: options.base ?? 100,
      maxBackoffMs: options.max ?? 2_000,
    }),
  };
}

async function readObservation(api: GitHubApiClient) {
  return api.readGraphql({
    projectId: lumenProfile.id,
    cacheKey: "lumen:observation",
    token: "fixture-token",
    query: "query Fixture { viewer { login } }",
    variables: {},
    schema: GitHubObservationResponseSchema,
  });
}

describe("GitHub conditional reads and failures", () => {
  test("rejects GraphQL mutation operations before the transport seam", () => {
    const setup = client([]);

    expect(() =>
      setup.client.readGraphql({
        projectId: lumenProfile.id,
        cacheKey: "forbidden",
        token: "fixture-token",
        query: "mutation Forbidden { mergePullRequest(input: {}) { clientMutationId } }",
        variables: {},
        schema: GitHubObservationResponseSchema,
      }),
    ).toThrow("exactly one query operation");
    expect(setup.transport.requests).toEqual([]);
  });

  test("reuses a validated conditional-read cache on 304", async () => {
    const setup = client([response(lumenObservation), fault("conditional304")]);

    const first = await readObservation(setup.client);
    const second = await readObservation(setup.client);

    expect(first.changed).toBe(true);
    expect(second).toMatchObject({
      changed: false,
      etag: '"fixture-v1"',
      status: 304,
    });
    expect(second.value).toEqual(first.value);
    expect(setup.transport.requests[1]?.headers["if-none-match"]).toBe('"fixture-v1"');
    expect(setup.delay.waits).toEqual([]);
  });

  test("retries rate limits with bounded backoff and then succeeds", async () => {
    const setup = client([fault("rateLimit"), response(lumenObservation)]);

    const result = await readObservation(setup.client);

    expect(result.status).toBe(200);
    expect(setup.transport.requests).toHaveLength(2);
    expect(setup.delay.waits).toEqual([1_000]);
  });

  test("classifies exhausted 5xx and timeout reads for the GitHub circuit", async () => {
    const server = client([fault("server"), fault("server"), fault("server")]);
    await expect(readObservation(server.client)).rejects.toMatchObject({
      signal: {
        provider: "github",
        projectId: lumenProfile.id,
        classification: "server",
        reasonCode: "github-server",
        retryable: true,
        attempts: 3,
        status: 503,
      },
    });
    expect(server.delay.waits).toEqual([100, 200]);

    const timeout = client([fault("timeout"), fault("timeout")], { attempts: 2 });
    try {
      await readObservation(timeout.client);
      throw new Error("expected timeout read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubReadError);
      expect((error as GitHubReadError).signal).toMatchObject({
        classification: "timeout",
        attempts: 2,
        status: null,
      });
    }
    expect(timeout.delay.waits).toEqual([100]);
  });
});

describe("production observation mapping", () => {
  test("maps closing-issue references, branch/worktree associations, and isolates projects", async () => {
    const setup = client([response(lumenObservation), response(orbitObservation, '"orbit-v1"')]);
    const tokenProjects: string[] = [];
    const profiles: readonly ProjectProfile[] = [lumenProfile, orbitProfile];
    const adapter = new ProductionGitHubAdapter({
      profiles,
      client: setup.client,
      tokens: {
        tokenForProject: async (projectId) => {
          tokenProjects.push(projectId);
          return `token-${projectId}`;
        },
      },
      associations: {
        worktreeIds: {
          "lumen-notes:11": "lumen-worktree-11",
          "orbit-tasks:21": "orbit-worktree-21",
        },
      },
    });

    const observations = (await adapter.observe(["orbit-tasks", "lumen-notes"], {
      reason: "startup",
      allowMutations: false,
      enabledProjectIds: ["lumen-notes", "orbit-tasks"],
      activeFeedbackPullRequests: [],
    })) as {
      readonly projectId: string;
      readonly issues: readonly {
        readonly number: number;
        readonly branch: string | null;
        readonly worktreeId: string | null;
        readonly pullRequestNumber: number | null;
      }[];
      readonly pullRequests: readonly { readonly linkedIssueNumber: number | null }[];
    }[];

    expect(observations.map((observation) => observation.projectId)).toEqual([
      "lumen-notes",
      "orbit-tasks",
    ]);
    expect(observations[0]?.issues[0]).toMatchObject({
      number: 11,
      branch: "factory/issue-11",
      worktreeId: "lumen-worktree-11",
      pullRequestNumber: 101,
    });
    expect(observations[0]?.pullRequests[0]?.linkedIssueNumber).toBe(11);
    expect(observations[1]?.issues[0]).toMatchObject({
      number: 21,
      branch: "agents/issue-21",
      worktreeId: "orbit-worktree-21",
      pullRequestNumber: 201,
    });
    expect(tokenProjects).toEqual(["lumen-notes", "orbit-tasks"]);
    expect(
      setup.transport.requests.map((request) => {
        const body = JSON.parse(request.body ?? "{}") as {
          variables?: {
            owner?: string;
            name?: string;
            issueCursor?: string | null;
            pullRequestCursor?: string | null;
            protectionCursor?: string | null;
          };
        };
        return body.variables;
      }),
    ).toEqual([
      {
        owner: "ExampleOrg",
        name: "lumen-notes",
        issueCursor: null,
        pullRequestCursor: null,
        protectionCursor: null,
      },
      {
        owner: "ExampleOrg",
        name: "orbit-tasks",
        issueCursor: null,
        pullRequestCursor: null,
        protectionCursor: null,
      },
    ]);
  });

  test("does not resolve credentials or perform HTTP for disabled targets", async () => {
    const setup = client([]);
    const adapter = new ProductionGitHubAdapter({
      profiles: [lumenProfile, orbitProfile],
      client: setup.client,
      tokens: {
        tokenForProject: async () => {
          throw new Error("disabled target requested a token");
        },
      },
    });

    expect(
      await adapter.observe(["lumen-notes"], {
        reason: "status",
        allowMutations: false,
        enabledProjectIds: [],
        activeFeedbackPullRequests: [],
      }),
    ).toEqual([{ projectId: "lumen-notes", issues: [], pullRequests: [] }]);
    expect(setup.transport.requests).toEqual([]);
  });

  test("drives convergence on active unchanged polls only", async () => {
    const setup = client([response(lumenObservation)]);
    const snapshots: string[] = [];
    const adapter = new ProductionGitHubAdapter({
      profiles: [lumenProfile],
      client: setup.client,
      tokens: {
        tokenForProject: async () => "project-token",
      },
      convergence: {
        async reconcileProject(snapshot) {
          snapshots.push(snapshot.projectId);
          return { mutated: false };
        },
      },
    });

    await adapter.observe(["lumen-notes"], {
      reason: "poll",
      allowMutations: true,
      enabledProjectIds: ["lumen-notes"],
      activeFeedbackPullRequests: [],
    });
    expect(snapshots).toEqual(["lumen-notes"]);
  });
});
