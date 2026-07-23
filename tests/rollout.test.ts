import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseProjectProfile, parseProjectProfileYaml } from "../src/contracts/project-profile";
import { createController } from "../src/controller/controller";
import { createInitialControllerState, createInMemoryAdapters } from "../src/testing";

describe("rollout stage limit enforcement", () => {
  test("clamps to the minimum of stage, environment, and profile ceilings", async () => {
    const base = parseProjectProfileYaml(
      readFileSync(join(import.meta.dir, "fixtures", "profiles", "lumen-notes.yaml"), "utf8"),
    );
    const profile = parseProjectProfile({
      ...base,
      ceilings: { implementation: 3, feedback: 2, readyToMerge: 1 },
    });
    const state = createInitialControllerState([profile]);
    state.rolloutStage = "stage1";
    state.mode = "active";
    const adapters = createInMemoryAdapters(
      [profile],
      [{ projectId: profile.id, issues: [], pullRequests: [] }],
      state,
    );
    const controller = createController(
      {
        profiles: [profile],
        limits: { implementation: 3, feedback: 3, readyToMerge: 3 },
        polling: { intervalMs: 60_000, jitterRatio: 0 },
      },
      adapters,
    );
    expect(await controller.status()).toMatchObject({
      rolloutStage: "stage1",
      limits: { implementation: 1, feedback: 1, readyToMerge: 1 },
      projects: [
        {
          effectiveLimits: { implementation: 1, feedback: 1, readyToMerge: 1 },
        },
      ],
    });
    await controller.command({ type: "set-rollout-stage", stage: "stage3" });
    expect(await controller.status()).toMatchObject({
      limits: { implementation: 3, feedback: 3, readyToMerge: 3 },
      projects: [
        {
          effectiveLimits: { implementation: 3, feedback: 2, readyToMerge: 1 },
        },
      ],
    });
  });

  test("observation stage has zero caps and cannot be resumed directly", async () => {
    const profile = parseProjectProfileYaml(
      readFileSync(join(import.meta.dir, "fixtures", "profiles", "lumen-notes.yaml"), "utf8"),
    );
    const state = createInitialControllerState([profile]);
    state.rolloutStage = "observation";
    state.mode = "observation";
    const controller = createController(
      {
        profiles: [profile],
        limits: { implementation: 3, feedback: 3, readyToMerge: 3 },
        polling: { intervalMs: 60_000, jitterRatio: 0 },
      },
      createInMemoryAdapters(
        [profile],
        [{ projectId: profile.id, issues: [], pullRequests: [] }],
        state,
      ),
    );
    expect((await controller.status()).limits).toEqual({
      implementation: 0,
      feedback: 0,
      readyToMerge: 0,
    });
    await expect(controller.command({ type: "set-mode", mode: "active" })).rejects.toThrow(
      "requires rollout stage1",
    );
  });

  test("activates a worker only after its execution is durably committed", async () => {
    const profile = parseProjectProfileYaml(
      readFileSync(join(import.meta.dir, "fixtures", "profiles", "lumen-notes.yaml"), "utf8"),
    );
    const state = createInitialControllerState([profile]);
    state.rolloutStage = "stage1";
    state.mode = "active";
    const adapters = createInMemoryAdapters(
      [profile],
      [
        {
          projectId: profile.id,
          issues: [
            {
              number: 1,
              state: "open",
              labels: [profile.labels.implementationReady],
              branch: null,
              worktreeId: null,
              pullRequestNumber: null,
            },
          ],
          pullRequests: [],
        },
      ],
      state,
    );
    const controller = createController(
      {
        profiles: [profile],
        limits: { implementation: 3, feedback: 3, readyToMerge: 3 },
        polling: { intervalMs: 60_000, jitterRatio: 0 },
      },
      adapters,
    );
    const result = await controller.reconcile({ reason: "capacity" });
    expect(result.startedExecutionIds).toEqual(["execution-1"]);
    expect(adapters.ledger.commitCount).toBe(1);
    expect(adapters.processes.activations.map((execution) => execution.executionId)).toEqual([
      "execution-1",
    ]);
    expect((await adapters.ledger.read()).state.executions[0]?.executionId).toBe("execution-1");
  });
});
