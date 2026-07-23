import { describe, expect, test } from "bun:test";
import type { ControllerLocalState, LedgerSnapshot } from "../src/controller/model";
import {
  assessExecutionLogCleanup,
  MERGED_EXECUTION_LOG_RETENTION_MS,
  type RetentionCandidate,
  RetentionCoordinator,
} from "../src/operations/retention";
import { createInitialControllerState, FixedClockAdapter } from "../src/testing";
import { assessWorktreeCleanup, MERGED_WORKTREE_RETENTION_MS } from "../src/worktrees";

const mergedAt = "2026-06-01T00:00:00.000Z";

function candidate(overrides: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    executionId: "execution-1",
    projectId: "project-one",
    issueNumber: 1,
    branch: "factory/issue-1",
    mergedAt,
    recoveryState: "none",
    explicitlyReleased: false,
    ...overrides,
  };
}

describe("retention boundaries", () => {
  test("worktrees become eligible at exactly 24 hours", () => {
    const before = new Date(new Date(mergedAt).getTime() + MERGED_WORKTREE_RETENTION_MS - 1);
    const exact = new Date(new Date(mergedAt).getTime() + MERGED_WORKTREE_RETENTION_MS);
    const input = { mergedAt, recoveryState: "none" as const, explicitlyReleased: false };
    expect(assessWorktreeCleanup(input, before)).toMatchObject({
      eligible: false,
      reason: "merged-retention-active",
    });
    expect(assessWorktreeCleanup(input, exact)).toMatchObject({
      eligible: true,
      reason: "merged-retention-elapsed",
    });
  });

  test("merged detail logs become eligible at exactly 30 days", () => {
    const before = new Date(new Date(mergedAt).getTime() + MERGED_EXECUTION_LOG_RETENTION_MS - 1);
    const exact = new Date(new Date(mergedAt).getTime() + MERGED_EXECUTION_LOG_RETENTION_MS);
    expect(assessExecutionLogCleanup(candidate(), before)).toMatchObject({
      eligible: false,
      reason: "merged-retention-active",
    });
    expect(assessExecutionLogCleanup(candidate(), exact)).toEqual({
      eligible: true,
      eligibleAt: exact.toISOString(),
    });
  });

  test("stalled state is retained until explicit release", () => {
    const now = new Date(new Date(mergedAt).getTime() + MERGED_EXECUTION_LOG_RETENTION_MS * 2);
    expect(assessExecutionLogCleanup(candidate({ recoveryState: "stalled" }), now)).toMatchObject({
      eligible: false,
      reason: "recovery-retained",
    });
    expect(
      assessWorktreeCleanup(
        {
          mergedAt,
          recoveryState: "operator-required",
          explicitlyReleased: false,
        },
        now,
      ),
    ).toMatchObject({ eligible: false, reason: "recovery-retained" });
    expect(
      assessExecutionLogCleanup(
        candidate({ recoveryState: "stalled", explicitlyReleased: true }),
        now,
      ).eligible,
    ).toBe(true);
    expect(
      assessWorktreeCleanup(
        {
          mergedAt,
          recoveryState: "operator-required",
          explicitlyReleased: true,
        },
        now,
      ).eligible,
    ).toBe(true);
  });
});

describe("retention coordinator", () => {
  test("runs safe cleanup and release persists through the ledger", async () => {
    let revision = 0;
    let state: ControllerLocalState = createInitialControllerState([]);
    state.executions.push({
      executionId: "execution-1",
      projectId: "project-one",
      lane: "implementation",
      provider: "claude",
      workflow: "workflow",
      claimState: "verified",
      issueNumber: 1,
      pullRequestNumber: null,
      branch: "factory/issue-1",
      worktreeId: "worktree-1",
      headSha: "1".repeat(40),
      status: "completed",
    });
    const audit: string[] = [];
    const ledger = {
      async read(): Promise<LedgerSnapshot> {
        return { revision, state: structuredClone(state) };
      },
      async commit(expectedRevision: number, next: ControllerLocalState): Promise<LedgerSnapshot> {
        expect(expectedRevision).toBe(revision);
        revision += 1;
        state = structuredClone(next);
        return { revision, state: structuredClone(state) };
      },
      appendAudit(kind: string, payload: unknown) {
        audit.push(kind);
        return {
          sequence: audit.length,
          timestamp: "2026-07-23T00:00:00.000Z",
          kind,
          payload,
        };
      },
    };
    const removedWorktrees: string[] = [];
    const removedLogs: string[] = [];
    const clock = new FixedClockAdapter(
      new Date(new Date(mergedAt).getTime() + MERGED_EXECUTION_LOG_RETENTION_MS),
    );
    const coordinator = new RetentionCoordinator({
      clock,
      ledger,
      artifacts: {
        async candidates() {
          return [candidate()];
        },
        async removeWorktree(value) {
          removedWorktrees.push(value.executionId);
          return true;
        },
        async removeExecutionLogs(executionId) {
          removedLogs.push(executionId);
          return true;
        },
      },
    });
    expect(await coordinator.run()).toEqual({
      worktreesRemoved: ["execution-1"],
      logsRemoved: ["execution-1"],
    });
    expect(removedWorktrees).toEqual(["execution-1"]);
    expect(removedLogs).toEqual(["execution-1"]);
    const completed = state.executions[0];
    if (completed === undefined) {
      throw new Error("retention fixture lost its execution");
    }
    state.executions[0] = { ...completed, status: "active" };
    await expect(coordinator.release("execution-1")).rejects.toThrow(
      "cannot release active execution",
    );
    state.executions[0] = { ...completed, status: "completed" };
    await coordinator.release("execution-1");
    expect(state.executions[0]?.status).toBe("released");
    expect(audit).toEqual(["retention-cleanup", "retention-explicit-release"]);
  });
});
