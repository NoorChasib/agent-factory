import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  CANONICAL_CONDITION_SEMANTICS,
  CANONICAL_STAGE_SEMANTICS,
  loadProjectProfileFile,
  ProjectProfileFileError,
  ProjectProfilesSchema,
  parseProjectProfile,
  parseProjectProfileYaml,
  parseWorkerResult,
  resolveCanonicalLabels,
  WorkerTerminalStatusSchema,
} from "../src";
import { InMemoryFileSystemAdapter } from "../src/testing";

const hhcProfileYaml = await Bun.file(
  new URL("fixtures/profiles/hhc-aep.yaml", import.meta.url),
).text();
const secondProfileYaml = await Bun.file(
  new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url),
).text();

const completedWorkerResult = {
  schemaVersion: 1,
  executionId: "exec-01HX",
  target: {
    projectId: "lumen-notes",
    repository: "ExampleOrg/lumen-notes",
  },
  issue: {
    number: 42,
  },
  pullRequest: {
    number: 84,
  },
  branch: {
    name: "factory/issue-42",
    base: "trunk",
    headSha: "1234567890abcdef1234567890abcdef12345678",
    pushed: true,
  },
  providerSession: {
    provider: "codex",
    id: "thread-01HX",
  },
  checkpoint: {
    phase: "verification",
    sequence: 3,
    code: "checks-current",
  },
  terminalStatus: "completed",
} as const;

describe("project profile contract", () => {
  test("accepts the HHC AEP configuration-only compatibility fixture", () => {
    const profile = parseProjectProfileYaml(hhcProfileYaml);

    expect(profile.id).toBe("hhc-aep");
    expect(profile.repository).toBe("NoorChasib/HHC-AEP");
    expect(profile.workflow.implement).toBe("hhc-aep-agent-implement-issue");
    expect(profile.reviewPolicy.required).toEqual(["codex", "copilot"]);
    expect(profile.issueSelection).toEqual({
      owner: "project-workflow",
      controllerProvidesIssueNumber: false,
    });
  });

  test("accepts a fictional project with different labels, workflows, checks, and reviewers", () => {
    const profile = parseProjectProfileYaml(secondProfileYaml);

    expect(profile.id).toBe("lumen-notes");
    expect(profile.defaultBranch).toBe("trunk");
    expect(profile.labels.inProgress).toBe("queue/owned");
    expect(profile.requiredChecks.source).toBe("profile");
    expect(profile.reviewers.sentinel?.completionSignal.kind).toBe("check-run");
  });

  test("applies the documented review/check/quiescence defaults when omitted", () => {
    const valid = parseProjectProfileYaml(secondProfileYaml);
    const withoutTimeouts = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "timeouts"),
    );

    expect(parseProjectProfile(withoutTimeouts).timeouts).toEqual({
      reviewerMinutes: 45,
      requiredCheckMinutes: 90,
      quiescencePolls: 2,
    });
  });

  test("resolves one lifecycle stage while preserving coexisting condition labels", () => {
    const profile = parseProjectProfileYaml(secondProfileYaml);
    expect(
      resolveCanonicalLabels(profile.labels, [
        profile.labels.inProgress,
        profile.labels.workerStalled,
        profile.labels.blockedExternal,
      ]),
    ).toEqual({
      stage: "in-progress",
      conditions: ["worker-stalled", "blocked-external"],
      conflictingStages: [],
    });
    expect(CANONICAL_STAGE_SEMANTICS["in-progress"].subjects).toEqual(["issue", "pull-request"]);
    expect(Object.keys(CANONICAL_CONDITION_SEMANTICS)).toEqual([
      "worker-stalled",
      "review-stalled",
      "needs-respec",
      "blocked-external",
    ]);
  });

  test("validates a unique multi-project profile set", () => {
    const hhc = parseProjectProfileYaml(hhcProfileYaml);
    const second = parseProjectProfileYaml(secondProfileYaml);

    expect(ProjectProfilesSchema.parse([hhc, second])).toHaveLength(2);
    expect(() => ProjectProfilesSchema.parse([hhc, { ...second, id: hhc.id }])).toThrow(z.ZodError);
    expect(() =>
      ProjectProfilesSchema.parse([hhc, { ...second, repository: hhc.repository }]),
    ).toThrow(z.ZodError);
  });

  test("rejects unknown keys at the top level and in nested objects", () => {
    const valid = parseProjectProfileYaml(secondProfileYaml);

    expect(() => parseProjectProfile({ ...valid, injected: true })).toThrow(z.ZodError);
    expect(() =>
      parseProjectProfile({
        ...valid,
        workflow: { ...valid.workflow, injected: "untrusted" },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      parseProjectProfile({
        ...valid,
        reviewers: {
          ...valid.reviewers,
          sentinel: {
            ...valid.reviewers.sentinel,
            injected: "untrusted",
          },
        },
      }),
    ).toThrow(z.ZodError);
  });

  test("rejects ambiguous labels, missing reviewers, controller-owned selection, and excess limits", () => {
    const valid = parseProjectProfileYaml(secondProfileYaml);

    expect(() =>
      parseProjectProfile({
        ...valid,
        labels: { ...valid.labels, feedbackReady: valid.labels.inProgress },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      parseProjectProfile({
        ...valid,
        reviewPolicy: { required: ["missing"] },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      parseProjectProfile({
        ...valid,
        issueSelection: {
          owner: "controller",
          controllerProvidesIssueNumber: true,
        },
      }),
    ).toThrow(z.ZodError);
    expect(() => parseProjectProfile({ ...valid, ceilings: { feedback: 4 } })).toThrow(z.ZodError);
  });

  test("rejects malformed YAML, duplicate keys, aliases, and oversized input", () => {
    expect(() => parseProjectProfileYaml("schemaVersion: [")).toThrow(ProjectProfileFileError);
    expect(() => parseProjectProfileYaml("schemaVersion: 1\nschemaVersion: 1\n")).toThrow(
      ProjectProfileFileError,
    );
    expect(() =>
      parseProjectProfileYaml("base: &profile\n  schemaVersion: 1\ncopy: *profile\n"),
    ).toThrow();
    expect(() => parseProjectProfileYaml("x".repeat(1024 * 1024 + 1))).toThrow(
      ProjectProfileFileError,
    );
  });

  test("loads only a regular mode-0600 profile through the filesystem adapter", async () => {
    const fileSystem = new InMemoryFileSystemAdapter();
    fileSystem.put("/profiles/valid.yaml", secondProfileYaml, {
      kind: "file",
      mode: 0o100600,
    });
    fileSystem.put("/profiles/public.yaml", secondProfileYaml, {
      kind: "file",
      mode: 0o100644,
    });
    fileSystem.put("/profiles/link.yaml", secondProfileYaml, {
      kind: "symbolic-link",
      mode: 0o120600,
    });

    await expect(loadProjectProfileFile("/profiles/valid.yaml", fileSystem)).resolves.toMatchObject(
      {
        id: "lumen-notes",
      },
    );
    await expect(loadProjectProfileFile("/profiles/public.yaml", fileSystem)).rejects.toThrow(
      "mode 0600",
    );
    await expect(loadProjectProfileFile("/profiles/link.yaml", fileSystem)).rejects.toThrow(
      "regular file",
    );
    expect(fileSystem.readCount).toBe(1);
  });
});

describe("worker result contract", () => {
  test("accepts every terminal status in the exact v1 enum", () => {
    expect(WorkerTerminalStatusSchema.options).toEqual([
      "completed",
      "blocked",
      "operator_required",
      "provider_limit",
      "stalled",
      "failed",
    ]);

    for (const terminalStatus of WorkerTerminalStatusSchema.options) {
      expect(parseWorkerResult({ ...completedWorkerResult, terminalStatus }).terminalStatus).toBe(
        terminalStatus,
      );
    }
  });

  test("accepts a result without a pull request or pushed head", () => {
    const result = parseWorkerResult({
      ...completedWorkerResult,
      pullRequest: null,
      branch: {
        ...completedWorkerResult.branch,
        headSha: null,
        pushed: false,
      },
      providerSession: {
        provider: "claude",
        id: "session-01HX",
      },
      terminalStatus: "blocked",
    });

    expect(result.pullRequest).toBeNull();
    expect(result.branch.headSha).toBeNull();
  });

  test("rejects unknown, malformed, and unversioned worker input", () => {
    expect(() => parseWorkerResult({ ...completedWorkerResult, prompt: "do not retain" })).toThrow(
      z.ZodError,
    );
    expect(() =>
      parseWorkerResult({
        ...completedWorkerResult,
        providerSession: {
          ...completedWorkerResult.providerSession,
          token: "secret",
        },
      }),
    ).toThrow(z.ZodError);
    expect(() => parseWorkerResult({ ...completedWorkerResult, schemaVersion: 2 })).toThrow(
      z.ZodError,
    );
    expect(() =>
      parseWorkerResult({ ...completedWorkerResult, terminalStatus: "approved" }),
    ).toThrow(z.ZodError);
    expect(() =>
      parseWorkerResult({
        ...completedWorkerResult,
        branch: { ...completedWorkerResult.branch, headSha: "not-a-sha" },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      parseWorkerResult({
        ...completedWorkerResult,
        pullRequest: null,
        branch: { ...completedWorkerResult.branch, headSha: null, pushed: true },
      }),
    ).toThrow(z.ZodError);
  });
});
