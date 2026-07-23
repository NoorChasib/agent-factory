import { describe, expect, test } from "bun:test";

import type {
  Controller,
  DiskGuard,
  FactoryNotifications,
  MaintenanceCoordinator,
  RetentionCoordinator,
  StructuredLogger,
} from "../src";
import { DaemonPollLoop } from "../src";

describe("deterministic daemon poll loop", () => {
  test("drives startup reconcile, disk, retention, logging, and injected delay", async () => {
    const events: string[] = [];
    let loop: DaemonPollLoop;
    const controller = {
      async reconcile(input: { reason: string }) {
        events.push(`reconcile:${input.reason}`);
        return {
          reason: input.reason,
          observedAt: "2026-07-23T00:00:00.000Z",
          applied: false,
          revision: 0,
          startedExecutionIds: [],
          stoppedExecutionIds: [],
          verifiedExecutionIds: [],
          blocks: [],
          invariantViolations: [],
          nextPollDelayMs: 123,
        };
      },
      async status() {
        events.push("status");
        return {
          observedAt: "2026-07-23T00:00:00.000Z",
          mode: "observation",
          rolloutStage: "observation",
          revision: 0,
          limits: { implementation: 0, feedback: 0, readyToMerge: 0 },
          circuits: {
            claude: { status: "closed", reasonCode: null },
            codex: { status: "closed", reasonCode: null },
            github: { status: "closed", reasonCode: null },
            reviewer: { status: "closed", reasonCode: null },
          },
          projects: [],
          executions: [],
          blocks: [],
          invariantViolations: [],
        };
      },
    } as unknown as Controller;
    loop = new DaemonPollLoop({
      controller,
      disk: {
        async check(paths: readonly string[]) {
          events.push(`disk:${paths.join(",")}`);
          return { percentage: 10, action: "none" as const, paths };
        },
      } as unknown as DiskGuard,
      retention: {
        async run() {
          events.push("retention");
          return { worktreesRemoved: [], logsRemoved: [] };
        },
      } as unknown as RetentionCoordinator,
      maintenance: {
        completeDrainsWhenIdle() {
          events.push("maintenance");
          return [];
        },
      } as unknown as MaintenanceCoordinator,
      notifications: {
        async alert() {
          throw new Error("no alert expected");
        },
      } as unknown as FactoryNotifications,
      logger: {
        async write() {
          events.push("log");
          return {};
        },
      } as unknown as StructuredLogger,
      delay: {
        async wait(milliseconds) {
          events.push(`delay:${milliseconds}`);
          loop.stop();
        },
      },
      updates: {
        async status() {
          return {};
        },
        async queue() {
          throw new Error("queue not expected");
        },
        async applyWhenIdle() {
          events.push("updates");
          return { state: "idle" as const };
        },
      },
      diskPaths: ["/state", "/data"],
    });

    await loop.run();
    expect(events).toEqual([
      "disk:/state,/data",
      "updates",
      "reconcile:startup",
      "status",
      "retention",
      "maintenance",
      "log",
      "delay:123",
    ]);
  });

  test("short-circuits normal work while an update restart or rollback restart is pending", async () => {
    const events: string[] = [];
    const loop = new DaemonPollLoop({
      controller: {
        async reconcile() {
          throw new Error("reconcile must not run while restart is pending");
        },
      } as unknown as Controller,
      disk: {
        async check() {
          events.push("disk");
          return { percentage: 10, action: "none" as const, paths: ["/state"] };
        },
      } as unknown as DiskGuard,
      retention: {
        async run() {
          throw new Error("retention must not run while restart is pending");
        },
      } as unknown as RetentionCoordinator,
      maintenance: {
        completeDrainsWhenIdle() {
          throw new Error("maintenance completion must not run while restart is pending");
        },
      } as unknown as MaintenanceCoordinator,
      notifications: {} as FactoryNotifications,
      logger: {
        async write() {
          events.push("log");
          return {};
        },
      } as unknown as StructuredLogger,
      delay: {
        async wait() {
          throw new Error("tick does not wait");
        },
      },
      updates: {
        async status() {
          return {};
        },
        async queue() {
          throw new Error("queue not expected");
        },
        async applyWhenIdle() {
          events.push("update");
          return {
            state: "rolled-back" as const,
            releaseId: "2".repeat(40),
            reason: "post-switch-health-failed",
          };
        },
      },
      diskPaths: ["/state"],
    });

    expect(await loop.tick("startup")).toMatchObject({
      reconcile: null,
      update: { state: "rolled-back" },
    });
    expect(events).toEqual(["disk", "update", "log"]);
  });
});
