import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  type ControllerConfig,
  type ControllerLocalState,
  createController,
  type ExecutionRecord,
  type GitHubIssueObservation,
  type GitHubProjectObservation,
  type GitHubPullRequestObservation,
  type ProjectProfile,
  parseGlobalLimitsFromEnvironment,
  parseProjectProfile,
  parseProjectProfileYaml,
} from "../src";
import {
  createInitialControllerState,
  createInMemoryAdapters,
  SequenceRandomAdapter,
} from "../src/testing";

const sha = "1234567890abcdef1234567890abcdef12345678";
const hhcProfile = parseProjectProfileYaml(
  await Bun.file(new URL("fixtures/profiles/hhc-aep.yaml", import.meta.url)).text(),
);
const secondProfile = parseProjectProfileYaml(
  await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);

function config(
  profiles: readonly ProjectProfile[],
  limits = { implementation: 3, feedback: 3, readyToMerge: 3 },
): ControllerConfig {
  return {
    profiles: [...profiles],
    limits,
    polling: {
      intervalMs: 60_000,
      jitterRatio: 0.1,
    },
  };
}

function issue(
  profile: ProjectProfile,
  number: number,
  stage: keyof Pick<
    ProjectProfile["labels"],
    "implementationReady" | "operatorReady" | "inProgress" | "needsInfo"
  >,
  overrides: Partial<GitHubIssueObservation> = {},
): GitHubIssueObservation {
  return {
    number,
    state: "open",
    labels: [profile.labels[stage]],
    branch: null,
    worktreeId: null,
    pullRequestNumber: null,
    ...overrides,
  };
}

function pullRequest(
  profile: ProjectProfile,
  number: number,
  stage: keyof Pick<ProjectProfile["labels"], "feedbackReady" | "inProgress" | "readyToMerge">,
  overrides: Partial<GitHubPullRequestObservation> = {},
): GitHubPullRequestObservation {
  return {
    number,
    state: "open",
    labels: [profile.labels[stage]],
    linkedIssueNumber: number,
    branch: `factory/issue-${number}`,
    headSha: sha,
    ...overrides,
  };
}

function observation(
  profile: ProjectProfile,
  issues: readonly GitHubIssueObservation[] = [],
  pullRequests: readonly GitHubPullRequestObservation[] = [],
): GitHubProjectObservation {
  return {
    projectId: profile.id,
    issues: [...issues],
    pullRequests: [...pullRequests],
  };
}

function activeState(profiles: readonly ProjectProfile[]): ControllerLocalState {
  const state = createInitialControllerState(profiles);
  state.mode = "active";
  return state;
}

function execution(
  profile: ProjectProfile,
  values: Partial<ExecutionRecord> & Pick<ExecutionRecord, "executionId" | "lane" | "issueNumber">,
): ExecutionRecord {
  const { executionId, issueNumber, lane, ...overrides } = values;
  return {
    executionId,
    projectId: profile.id,
    lane,
    provider: lane === "implementation" ? "claude" : "codex",
    workflow: lane === "implementation" ? profile.workflow.implement : profile.workflow.feedback,
    claimState: "verified",
    issueNumber,
    pullRequestNumber: null,
    branch: null,
    worktreeId: null,
    headSha: null,
    status: "active",
    ...overrides,
  };
}

describe("controller interface and observation mode", () => {
  test("exposes only status, command, and reconcile operations", () => {
    const adapters = createInMemoryAdapters([secondProfile], [observation(secondProfile)]);
    const controller = createController(config([secondProfile]), adapters);
    const operations = Object.getOwnPropertyNames(Object.getPrototypeOf(controller))
      .filter((name) => name !== "constructor")
      .sort();

    expect(operations).toEqual(["command", "reconcile", "status"]);
  });

  test("defaults to observation mode with no ledger writes, workers, stops, or notifications", async () => {
    const observations = [
      observation(
        secondProfile,
        [issue(secondProfile, 1, "implementationReady")],
        [pullRequest(secondProfile, 10, "feedbackReady")],
      ),
    ];
    const adapters = createInMemoryAdapters([secondProfile], observations);
    const controller = createController(config([secondProfile]), adapters);

    const result = await controller.reconcile({ reason: "startup" });
    const status = await controller.status();

    expect(result.applied).toBe(false);
    expect(result.startedExecutionIds).toEqual([]);
    expect(result.nextPollDelayMs).toBe(60_000);
    expect(status.mode).toBe("observation");
    expect(status.blocks).toContainEqual({
      projectId: null,
      lane: "implementation",
      reason: "observation-mode",
    });
    expect(adapters.processes.starts).toEqual([]);
    expect(adapters.processes.stops).toEqual([]);
    expect(adapters.notifications.sent).toEqual([]);
    expect(adapters.ledger.commitCount).toBe(0);
  });

  test("strictly validates commands and applies explicit control changes only through command", async () => {
    const adapters = createInMemoryAdapters([secondProfile], [observation(secondProfile)]);
    const controller = createController(config([secondProfile]), adapters);

    await expect(
      controller.command({ type: "set-mode", mode: "active", injected: true }),
    ).rejects.toThrow(z.ZodError);
    const active = await controller.command({ type: "set-mode", mode: "active" });
    const openCircuit = await controller.command({
      type: "set-provider-circuit",
      provider: "codex",
      status: "open",
      reasonCode: "account-limit",
    });

    expect(active.mode).toBe("active");
    expect(openCircuit.circuits.codex).toEqual({
      status: "open",
      reasonCode: "account-limit",
    });
    expect(adapters.ledger.commitCount).toBe(2);
    await expect(
      controller.command({
        type: "set-project-enabled",
        projectId: "unknown-project",
        enabled: true,
      }),
    ).rejects.toThrow("unknown project");
  });

  test("strictly rejects untrusted fields returned by an I/O adapter", async () => {
    const validObservation = observation(secondProfile);
    const base = createInMemoryAdapters([secondProfile], [validObservation]);
    const adapters = {
      ...base,
      github: {
        observe: async () => [{ ...validObservation, injected: "untrusted" }],
      },
    };

    await expect(createController(config([secondProfile]), adapters).status()).rejects.toThrow(
      z.ZodError,
    );
    expect(base.ledger.commitCount).toBe(0);
    expect(base.processes.starts).toEqual([]);
  });
});

describe("limits, claims, and fair scheduling", () => {
  test("parses default and zero-through-three global environment limits", () => {
    expect(parseGlobalLimitsFromEnvironment({})).toEqual({
      implementation: 1,
      feedback: 1,
      readyToMerge: 1,
    });
    expect(
      parseGlobalLimitsFromEnvironment({
        AGENT_FACTORY_IMPLEMENTATION_LIMIT: "0",
        AGENT_FACTORY_FEEDBACK_LIMIT: "2",
        AGENT_FACTORY_READY_TO_MERGE_LIMIT: "3",
      }),
    ).toEqual({ implementation: 0, feedback: 2, readyToMerge: 3 });
    expect(() =>
      parseGlobalLimitsFromEnvironment({
        AGENT_FACTORY_IMPLEMENTATION_LIMIT: "4",
      }),
    ).toThrow("integer from 0 through 3");
    expect(() =>
      parseGlobalLimitsFromEnvironment({
        AGENT_FACTORY_FEEDBACK_LIMIT: "1.0",
      }),
    ).toThrow("integer from 0 through 3");
  });

  test("zero global lane and backlog limits pause all launches", async () => {
    const observed = [
      observation(
        secondProfile,
        [issue(secondProfile, 1, "implementationReady")],
        [pullRequest(secondProfile, 10, "feedbackReady")],
      ),
    ];
    const state = activeState([secondProfile]);
    const adapters = createInMemoryAdapters([secondProfile], observed, state);
    const result = await createController(
      config([secondProfile], { implementation: 0, feedback: 0, readyToMerge: 0 }),
      adapters,
    ).reconcile();

    expect(adapters.processes.starts).toEqual([]);
    expect(result.blocks).toContainEqual({
      projectId: null,
      lane: "implementation",
      reason: "global-limit",
    });
    expect(result.blocks).toContainEqual({
      projectId: null,
      lane: "feedback",
      reason: "global-limit",
    });
    expect(result.blocks).toContainEqual({
      projectId: null,
      lane: "implementation",
      reason: "global-backlog-limit",
    });
  });

  test("allows only one unverified implementation claim globally", async () => {
    const observations = [
      observation(secondProfile, [
        issue(secondProfile, 1, "implementationReady"),
        issue(secondProfile, 2, "implementationReady"),
      ]),
    ];
    const state = activeState([secondProfile]);
    const adapters = createInMemoryAdapters([secondProfile], observations, state);
    adapters.processes.enqueueExecution(
      execution(secondProfile, {
        executionId: "claim-1",
        lane: "implementation",
        issueNumber: 1,
        claimState: "awaiting-verification",
        branch: "factory/issue-1",
        worktreeId: "worktree-1",
        headSha: sha,
      }),
    );
    const controller = createController(config([secondProfile]), adapters);

    const first = await controller.reconcile({ reason: "capacity" });
    const waiting = await controller.reconcile({ reason: "poll" });

    expect(first.startedExecutionIds).toEqual(["claim-1"]);
    expect(waiting.startedExecutionIds).toEqual([]);
    expect(waiting.blocks).toContainEqual({
      projectId: null,
      lane: "implementation",
      reason: "claim-in-flight",
    });
    expect(adapters.processes.starts).toHaveLength(1);

    adapters.github.setObservations([
      observation(secondProfile, [
        issue(secondProfile, 1, "inProgress", {
          branch: "factory/issue-1",
          worktreeId: "worktree-1",
        }),
        issue(secondProfile, 2, "implementationReady"),
      ]),
    ]);
    const verified = await controller.reconcile({ reason: "change" });

    expect(verified.verifiedExecutionIds).toEqual(["claim-1"]);
    expect(verified.startedExecutionIds).toEqual(["execution-1"]);
    expect(adapters.processes.starts).toHaveLength(2);
    expect(adapters.processes.starts[1]?.issueNumber).toBeNull();
  });

  test("fills the v1 maximum only after verified claims and respects a lower project ceiling", async () => {
    const state = activeState([secondProfile]);
    state.executions.push(
      execution(secondProfile, {
        executionId: "impl-1",
        lane: "implementation",
        issueNumber: 1,
      }),
      execution(secondProfile, {
        executionId: "impl-2",
        lane: "implementation",
        issueNumber: 2,
      }),
    );
    const observations = [
      observation(secondProfile, [
        issue(secondProfile, 1, "inProgress"),
        issue(secondProfile, 2, "inProgress"),
        issue(secondProfile, 3, "implementationReady"),
      ]),
    ];
    const adapters = createInMemoryAdapters([secondProfile], observations, state);
    const controller = createController(config([secondProfile]), adapters);

    expect((await controller.reconcile()).startedExecutionIds).toEqual(["execution-1"]);

    const limitedProfile = parseProjectProfile({
      ...secondProfile,
      id: "limited-project",
      repository: "ExampleOrg/limited-project",
      ceilings: { implementation: 1 },
    });
    const limitedState = activeState([limitedProfile]);
    limitedState.executions.push(
      execution(limitedProfile, {
        executionId: "at-project-limit",
        lane: "implementation",
        issueNumber: 1,
      }),
    );
    const limitedAdapters = createInMemoryAdapters(
      [limitedProfile],
      [
        observation(limitedProfile, [
          issue(limitedProfile, 1, "inProgress"),
          issue(limitedProfile, 2, "implementationReady"),
        ]),
      ],
      limitedState,
    );
    const limitedController = createController(config([limitedProfile]), limitedAdapters);
    const limited = await limitedController.reconcile();

    expect(limited.startedExecutionIds).toEqual([]);
    expect(limited.blocks).toContainEqual({
      projectId: limitedProfile.id,
      lane: "implementation",
      reason: "project-limit",
    });
  });

  test("rotates deterministically across enabled projects even when the last project is ineligible", async () => {
    const observations = [
      observation(hhcProfile, [issue(hhcProfile, 1, "implementationReady")]),
      observation(secondProfile, [issue(secondProfile, 2, "implementationReady")]),
    ];
    const afterHhc = activeState([hhcProfile, secondProfile]);
    afterHhc.rotation.implementation = hhcProfile.id;
    const adapters = createInMemoryAdapters([hhcProfile, secondProfile], observations, afterHhc);
    const result = await createController(
      config([hhcProfile, secondProfile]),
      adapters,
    ).reconcile();
    expect(result.startedExecutionIds).toEqual(["execution-1"]);
    expect(adapters.processes.starts[0]?.projectId).toBe(secondProfile.id);

    const afterSecond = activeState([hhcProfile, secondProfile]);
    afterSecond.rotation.implementation = secondProfile.id;
    const reverseAdapters = createInMemoryAdapters(
      [hhcProfile, secondProfile],
      observations,
      afterSecond,
    );
    await createController(config([hhcProfile, secondProfile]), reverseAdapters).reconcile();
    expect(reverseAdapters.processes.starts[0]?.projectId).toBe(hhcProfile.id);

    const onlySecondEligible = activeState([hhcProfile, secondProfile]);
    onlySecondEligible.rotation.implementation = hhcProfile.id;
    const sparseAdapters = createInMemoryAdapters(
      [hhcProfile, secondProfile],
      [
        observation(hhcProfile),
        observation(secondProfile, [issue(secondProfile, 2, "implementationReady")]),
      ],
      onlySecondEligible,
    );
    await createController(config([hhcProfile, secondProfile]), sparseAdapters).reconcile();
    expect(sparseAdapters.processes.starts[0]?.projectId).toBe(secondProfile.id);
  });

  test("fills feedback capacity in fair project rotation while honoring per-project limits", async () => {
    const observations = [
      observation(
        hhcProfile,
        [],
        [
          pullRequest(hhcProfile, 10, "feedbackReady"),
          pullRequest(hhcProfile, 11, "feedbackReady"),
        ],
      ),
      observation(
        secondProfile,
        [],
        [
          pullRequest(secondProfile, 20, "feedbackReady"),
          pullRequest(secondProfile, 21, "feedbackReady"),
        ],
      ),
    ];
    const state = activeState([hhcProfile, secondProfile]);
    const adapters = createInMemoryAdapters([hhcProfile, secondProfile], observations, state);

    await createController(config([hhcProfile, secondProfile]), adapters).reconcile();

    expect(adapters.processes.starts.map((request) => request.projectId)).toEqual([
      hhcProfile.id,
      secondProfile.id,
      secondProfile.id,
    ]);
    expect(adapters.processes.starts.map((request) => request.pullRequestNumber)).toEqual([
      10, 20, 21,
    ]);
  });
});

describe("circuits, backlog, ownership, and external precedence", () => {
  test("provider circuits pause only their launch lane and the GitHub circuit pauses both", async () => {
    const observed = [
      observation(
        secondProfile,
        [issue(secondProfile, 1, "implementationReady")],
        [pullRequest(secondProfile, 10, "feedbackReady")],
      ),
    ];
    const claudeOpen = activeState([secondProfile]);
    claudeOpen.circuits.claude = { status: "open", reasonCode: "provider-limit" };
    const claudeAdapters = createInMemoryAdapters([secondProfile], observed, claudeOpen);
    const claudeResult = await createController(
      config([secondProfile]),
      claudeAdapters,
    ).reconcile();
    expect(claudeAdapters.processes.starts.map((request) => request.lane)).toEqual(["feedback"]);
    expect(claudeResult.blocks).toContainEqual({
      projectId: null,
      lane: "implementation",
      reason: "provider-circuit-open",
    });

    const codexOpen = activeState([secondProfile]);
    codexOpen.circuits.codex = { status: "open", reasonCode: "provider-limit" };
    const codexAdapters = createInMemoryAdapters([secondProfile], observed, codexOpen);
    await createController(config([secondProfile]), codexAdapters).reconcile();
    expect(codexAdapters.processes.starts.map((request) => request.lane)).toEqual([
      "implementation",
    ]);

    const reviewerOpen = activeState([secondProfile]);
    reviewerOpen.circuits.reviewer = {
      status: "open",
      reasonCode: "reviewer-provider-unavailable",
    };
    const reviewerAdapters = createInMemoryAdapters([secondProfile], observed, reviewerOpen);
    await createController(config([secondProfile]), reviewerAdapters).reconcile();
    expect(reviewerAdapters.processes.starts.map((request) => request.lane)).toEqual([
      "implementation",
    ]);

    const githubOpen = activeState([secondProfile]);
    githubOpen.circuits.github = { status: "open", reasonCode: "unavailable" };
    const githubAdapters = createInMemoryAdapters([secondProfile], observed, githubOpen);
    await createController(config([secondProfile]), githubAdapters).reconcile();
    expect(githubAdapters.processes.starts).toEqual([]);
  });

  test("ready-to-merge backlog blocks implementation while feedback continues", async () => {
    const observed = [
      observation(
        secondProfile,
        [issue(secondProfile, 1, "implementationReady")],
        [
          pullRequest(secondProfile, 10, "readyToMerge"),
          pullRequest(secondProfile, 11, "feedbackReady"),
        ],
      ),
    ];
    const state = activeState([secondProfile]);
    const adapters = createInMemoryAdapters([secondProfile], observed, state);
    const result = await createController(
      config([secondProfile], { implementation: 2, feedback: 2, readyToMerge: 1 }),
      adapters,
    ).reconcile();

    expect(adapters.processes.starts.map((request) => request.lane)).toEqual(["feedback"]);
    expect(result.blocks).toContainEqual({
      projectId: null,
      lane: "implementation",
      reason: "global-backlog-limit",
    });
  });

  test("a lower project backlog ceiling blocks only that project", async () => {
    const observed = [
      observation(
        hhcProfile,
        [issue(hhcProfile, 1, "implementationReady")],
        [pullRequest(hhcProfile, 10, "readyToMerge")],
      ),
      observation(secondProfile, [issue(secondProfile, 2, "implementationReady")]),
    ];
    const state = activeState([hhcProfile, secondProfile]);
    const adapters = createInMemoryAdapters([hhcProfile, secondProfile], observed, state);
    const result = await createController(
      config([hhcProfile, secondProfile], {
        implementation: 3,
        feedback: 3,
        readyToMerge: 3,
      }),
      adapters,
    ).reconcile();

    expect(adapters.processes.starts[0]?.projectId).toBe(secondProfile.id);
    expect(result.blocks).toContainEqual({
      projectId: hhcProfile.id,
      lane: "implementation",
      reason: "project-backlog-limit",
    });
  });

  test("never launches a second feedback worker for an actively owned pull request", async () => {
    const state = activeState([secondProfile]);
    state.executions.push(
      execution(secondProfile, {
        executionId: "feedback-10",
        lane: "feedback",
        issueNumber: 10,
        pullRequestNumber: 10,
        branch: "factory/issue-10",
        headSha: sha,
      }),
    );
    const observed = [
      observation(
        secondProfile,
        [],
        [
          pullRequest(secondProfile, 10, "inProgress"),
          pullRequest(secondProfile, 11, "feedbackReady"),
        ],
      ),
    ];
    const adapters = createInMemoryAdapters([secondProfile], observed, state);
    await createController(
      config([secondProfile], { implementation: 0, feedback: 2, readyToMerge: 3 }),
      adapters,
    ).reconcile();

    expect(adapters.processes.starts).toHaveLength(1);
    expect(adapters.processes.starts[0]?.pullRequestNumber).toBe(11);
  });

  test("blocks launches when external ownership or stage mappings are ambiguous", async () => {
    const sharedBranch = "factory/shared";
    const observed = [
      observation(secondProfile, [
        issue(secondProfile, 1, "implementationReady", { branch: sharedBranch }),
        issue(secondProfile, 2, "implementationReady", { branch: sharedBranch }),
        {
          ...issue(secondProfile, 3, "implementationReady"),
          labels: [secondProfile.labels.implementationReady, secondProfile.labels.inProgress],
        },
      ]),
    ];
    const state = activeState([secondProfile]);
    const adapters = createInMemoryAdapters([secondProfile], observed, state);
    const result = await createController(config([secondProfile]), adapters).reconcile();

    expect(adapters.processes.starts).toEqual([]);
    expect(result.invariantViolations.some((violation) => violation.includes("one-to-one"))).toBe(
      true,
    );
    expect(
      result.invariantViolations.some((violation) => violation.includes("conflicting stages")),
    ).toBe(true);
  });

  test("external GitHub stages release stale local ownership before capacity is reused", async () => {
    const state = activeState([secondProfile]);
    state.executions.push(
      execution(secondProfile, {
        executionId: "stale-implementation",
        lane: "implementation",
        issueNumber: 1,
        branch: "factory/issue-1",
        worktreeId: "worktree-1",
        headSha: sha,
      }),
    );
    const observed = [
      observation(secondProfile, [
        issue(secondProfile, 1, "operatorReady", {
          branch: "factory/issue-1",
          worktreeId: "worktree-1",
        }),
        issue(secondProfile, 2, "implementationReady"),
      ]),
    ];
    const adapters = createInMemoryAdapters([secondProfile], observed, state);
    const result = await createController(
      config([secondProfile], { implementation: 1, feedback: 1, readyToMerge: 3 }),
      adapters,
    ).reconcile({ reason: "change" });

    expect(result.stoppedExecutionIds).toEqual(["stale-implementation"]);
    expect(adapters.processes.stops).toEqual([
      {
        executionId: "stale-implementation",
        reason: "external-stage-changed",
      },
    ]);
    expect(result.startedExecutionIds).toEqual(["execution-1"]);
    const ledger = await adapters.ledger.read();
    expect(
      ledger.state.executions.find((candidate) => candidate.executionId === "stale-implementation")
        ?.status,
    ).toBe("released");
  });

  test("merged external PR state releases a locally active feedback execution", async () => {
    const state = activeState([secondProfile]);
    state.executions.push(
      execution(secondProfile, {
        executionId: "stale-feedback",
        lane: "feedback",
        issueNumber: 5,
        pullRequestNumber: 5,
        branch: "factory/issue-5",
        headSha: sha,
      }),
    );
    const observed = [
      observation(
        secondProfile,
        [],
        [pullRequest(secondProfile, 5, "inProgress", { state: "merged" })],
      ),
    ];
    const adapters = createInMemoryAdapters([secondProfile], observed, state);
    const result = await createController(config([secondProfile]), adapters).reconcile();

    expect(result.stoppedExecutionIds).toEqual(["stale-feedback"]);
    expect(adapters.processes.stops[0]?.reason).toBe("external-subject-closed");
  });

  test("uses injected randomness for deterministic polling jitter", async () => {
    const base = createInMemoryAdapters([secondProfile], [observation(secondProfile)]);
    const adapters = { ...base, random: new SequenceRandomAdapter([0]) };
    const controller = createController(config([secondProfile]), adapters);

    expect((await controller.reconcile()).nextPollDelayMs).toBe(54_000);
    expect(adapters.random.callCount).toBe(1);
  });
});
