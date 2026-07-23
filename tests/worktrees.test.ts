import { describe, expect, test } from "bun:test";
import type { CommandExecutionResult } from "../src";
import {
  assertAllowedGitOperation,
  assessWorktreeCleanup,
  FactoryCustodyPaths,
  FORBIDDEN_GIT_OPERATION_KINDS,
  ForbiddenGitOperationError,
  GuardedGitCommandAdapter,
  MERGED_WORKTREE_RETENTION_MS,
  parseGitWorktreePorcelain,
  WorktreeCleanupNotEligibleError,
  WorktreeCustody,
  WorktreeInvariantError,
} from "../src";
import { InMemoryGitCustodyAdapter, ScriptedCommandAdapter } from "../src/testing";

function ok(stdout = "", exitCode = 0): CommandExecutionResult {
  return {
    status: "exited",
    exitCode,
    stdout,
    stderr: "",
    processId: null,
  };
}

function custodyPaths(): FactoryCustodyPaths {
  return new FactoryCustodyPaths({
    mirrorBaseDirectory: "/factory-data/mirrors",
    worktreeBaseDirectory: "/factory-data/worktrees",
    protectedCheckoutDirectories: ["/operator/agent-factory", "/operator/target-project"],
  });
}

const request = {
  projectId: "project-one",
  repository: "ExampleOrg/project-one",
  issueNumber: 7,
  branch: "factory/issue-7",
  startPoint: "main",
} as const;

describe("factory mirror and issue-worktree custody", () => {
  test("strictly parses Git worktree porcelain without retaining unknown states", () => {
    const head = "1".repeat(40);
    expect(
      parseGitWorktreePorcelain(
        [
          "worktree /factory-data/mirrors/project-one.git",
          "bare",
          "",
          "worktree /factory-data/worktrees/project-one/issue-7",
          `HEAD ${head}`,
          "branch refs/heads/factory/issue-7",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      {
        path: "/factory-data/worktrees/project-one/issue-7",
        branch: "factory/issue-7",
        headSha: head,
      },
    ]);
    expect(() =>
      parseGitWorktreePorcelain(
        [
          "worktree /factory-data/worktrees/project-one/issue-7",
          `HEAD ${head}`,
          "branch refs/heads/factory/issue-7",
          "future-field untrusted",
          "",
        ].join("\n"),
      ),
    ).toThrow("unknown field");
  });

  test("keeps injected custody roots outside protected checkouts", () => {
    const paths = custodyPaths();
    expect(paths.mirrorPath("project-one")).toBe("/factory-data/mirrors/project-one.git");
    expect(paths.worktreePath("project-one", 7)).toBe(
      "/factory-data/worktrees/project-one/issue-7",
    );
    expect(
      () =>
        new FactoryCustodyPaths({
          mirrorBaseDirectory: "/operator/agent-factory/mirrors",
          worktreeBaseDirectory: "/factory-data/worktrees",
          protectedCheckoutDirectories: ["/operator/agent-factory"],
        }),
    ).toThrow("outside factory and operator checkouts");
    expect(
      () =>
        new FactoryCustodyPaths({
          mirrorBaseDirectory: "/factory-data",
          worktreeBaseDirectory: "/factory-data/worktrees",
          protectedCheckoutDirectories: [],
        }),
    ).toThrow("must not overlap");
  });

  test("clones or fetches mirrors and enforces one issue and branch per worktree", async () => {
    const git = new InMemoryGitCustodyAdapter(custodyPaths());
    const custody = new WorktreeCustody(git);

    expect(await custody.createIssueWorktree(request)).toEqual({
      worktreeId: "project-one-issue-7",
      projectId: "project-one",
      issueNumber: 7,
      branch: "factory/issue-7",
      path: "/factory-data/worktrees/project-one/issue-7",
      created: true,
    });
    expect(await custody.createIssueWorktree(request)).toMatchObject({
      created: false,
      issueNumber: 7,
    });
    expect(git.operations).toEqual([
      "inspect:project-one",
      "clone:project-one:ExampleOrg/project-one",
      "list:project-one",
      "add:project-one:7:factory/issue-7:main",
      "inspect:project-one",
      "fetch:project-one",
      "list:project-one",
    ]);

    await expect(
      custody.createIssueWorktree({
        ...request,
        issueNumber: 8,
      }),
    ).rejects.toBeInstanceOf(WorktreeInvariantError);
    await expect(
      custody.createIssueWorktree({
        ...request,
        branch: "factory/different-branch",
      }),
    ).rejects.toBeInstanceOf(WorktreeInvariantError);
  });

  test("uses only structurally allowlisted Git commands through the injected adapter", async () => {
    for (const kind of FORBIDDEN_GIT_OPERATION_KINDS) {
      expect(() => assertAllowedGitOperation({ kind })).toThrow(ForbiddenGitOperationError);
    }
    expect(() =>
      assertAllowedGitOperation({
        kind: "add-worktree",
        ...request,
        push: true,
      }),
    ).toThrow(ForbiddenGitOperationError);

    const commands = new ScriptedCommandAdapter([
      ok("", 128),
      ok(),
      ok(["worktree /factory-data/mirrors/project-one.git", "bare", ""].join("\n")),
      ok(),
    ]);
    const git = new GuardedGitCommandAdapter({
      commands,
      mirrorBaseDirectory: "/factory-data/mirrors",
      worktreeBaseDirectory: "/factory-data/worktrees",
      protectedCheckoutDirectories: ["/operator/checkout"],
    });
    const created = await new WorktreeCustody(git).createIssueWorktree(request);

    expect(created.created).toBe(true);
    expect(commands.requests.map((command) => command.executable)).toEqual([
      "git",
      "git",
      "git",
      "git",
    ]);
    expect(commands.requests[1]?.argv).toEqual([
      "clone",
      "--mirror",
      "https://github.com/ExampleOrg/project-one.git",
      "/factory-data/mirrors/project-one.git",
    ]);
    expect(commands.requests[3]?.argv).toEqual([
      "--git-dir",
      "/factory-data/mirrors/project-one.git",
      "worktree",
      "add",
      "-b",
      "factory/issue-7",
      "--",
      "/factory-data/worktrees/project-one/issue-7",
      "main",
    ]);
    expect(
      commands.requests.some((command) =>
        command.argv.some((argument) => /^(?:push|rebase|reset|merge|commit)$/u.test(argument)),
      ),
    ).toBe(false);
    expect(commands.remaining()).toBe(0);
  });
});

describe("worktree cleanup eligibility and safe removal", () => {
  const mergedAt = "2026-07-22T00:00:00.000Z";
  const exactBoundary = new Date(new Date(mergedAt).getTime() + MERGED_WORKTREE_RETENTION_MS);

  test("becomes eligible exactly at 24 hours and retains recovery state", () => {
    expect(
      assessWorktreeCleanup(
        {
          mergedAt,
          recoveryState: "none",
          explicitlyReleased: false,
        },
        new Date(exactBoundary.getTime() - 1),
      ),
    ).toEqual({
      eligible: false,
      reason: "merged-retention-active",
      eligibleAt: exactBoundary.toISOString(),
    });
    expect(
      assessWorktreeCleanup(
        {
          mergedAt,
          recoveryState: "none",
          explicitlyReleased: false,
        },
        exactBoundary,
      ),
    ).toEqual({
      eligible: true,
      reason: "merged-retention-elapsed",
      eligibleAt: exactBoundary.toISOString(),
    });
    expect(
      assessWorktreeCleanup(
        {
          mergedAt,
          recoveryState: "stalled",
          explicitlyReleased: false,
        },
        new Date(exactBoundary.getTime() + MERGED_WORKTREE_RETENTION_MS),
      ),
    ).toEqual({
      eligible: false,
      reason: "recovery-retained",
      eligibleAt: null,
    });
    expect(
      assessWorktreeCleanup(
        {
          mergedAt: null,
          recoveryState: "operator-required",
          explicitlyReleased: true,
        },
        exactBoundary,
      ),
    ).toEqual({
      eligible: true,
      reason: "explicit-release",
      eligibleAt: exactBoundary.toISOString(),
    });
  });

  test("removes only the exact eligible issue worktree without force", async () => {
    const git = new InMemoryGitCustodyAdapter(custodyPaths());
    const custody = new WorktreeCustody(git);
    await custody.createIssueWorktree(request);

    await expect(
      custody.removeEligible({
        projectId: request.projectId,
        issueNumber: request.issueNumber,
        branch: request.branch,
        cleanup: {
          mergedAt,
          recoveryState: "operator-required",
          explicitlyReleased: false,
        },
        now: exactBoundary,
      }),
    ).rejects.toBeInstanceOf(WorktreeCleanupNotEligibleError);
    expect(
      await custody.removeEligible({
        projectId: request.projectId,
        issueNumber: request.issueNumber,
        branch: request.branch,
        cleanup: {
          mergedAt,
          recoveryState: "none",
          explicitlyReleased: false,
        },
        now: exactBoundary,
      }),
    ).toMatchObject({
      removed: true,
      assessment: { eligible: true, reason: "merged-retention-elapsed" },
    });
    expect(git.operations.at(-1)).toBe("remove:project-one:7");
    expect(
      await custody.removeEligible({
        projectId: request.projectId,
        issueNumber: request.issueNumber,
        branch: request.branch,
        cleanup: {
          mergedAt,
          recoveryState: "none",
          explicitlyReleased: false,
        },
        now: exactBoundary,
      }),
    ).toMatchObject({ removed: false });
  });

  test("builds safe removal without force for only the derived issue path", async () => {
    const commands = new ScriptedCommandAdapter([ok()]);
    const git = new GuardedGitCommandAdapter({
      commands,
      mirrorBaseDirectory: "/factory-data/mirrors",
      worktreeBaseDirectory: "/factory-data/worktrees",
      protectedCheckoutDirectories: ["/operator/checkout"],
    });

    await git.removeWorktree("project-one", 7);
    expect(commands.requests[0]?.argv).toEqual([
      "--git-dir",
      "/factory-data/mirrors/project-one.git",
      "worktree",
      "remove",
      "/factory-data/worktrees/project-one/issue-7",
    ]);
    expect(commands.requests[0]?.argv).not.toContain("--force");
  });
});
