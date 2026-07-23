import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandExecutionResult, CommandRequest } from "../src/adapters/interfaces";
import type { ControllerLocalState, ExecutionRecord } from "../src/controller/model";
import {
  assertFactoryHerdrOperation,
  FACTORY_HERDR_SESSION,
  GuardedHerdrCommandAdapter,
  type HerdrPane,
  HerdrScopeError,
  HerdrSessionManager,
  parseHerdrPaneOutput,
  parseHerdrPaneProcessOutput,
} from "../src/herdr";
import { type LedgerIdSource, openSqliteLedger } from "../src/ledger";
import {
  createInitialControllerState,
  FixedClockAdapter,
  ScriptedCommandAdapter,
  ScriptedProcessTreeAdapter,
} from "../src/testing";

const startedAt = "2026-07-23T00:00:00.000Z";

class Ids implements LedgerIdSource {
  #next = 1;

  public nextId(
    kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session",
  ): string {
    const id = `${kind}-herdr-${this.#next}`;
    this.#next += 1;
    return id;
  }
}

function execution(id: string, issueNumber: number): ExecutionRecord {
  return {
    executionId: id,
    projectId: "project-one",
    lane: "implementation",
    provider: "claude",
    workflow: "fixture-workflow",
    claimState: "verified",
    issueNumber,
    pullRequestNumber: null,
    branch: `factory/issue-${issueNumber}`,
    worktreeId: `worktree-${issueNumber}`,
    headSha: "1".repeat(40),
    status: "active",
  };
}

function state(executions: readonly ExecutionRecord[]): ControllerLocalState {
  const value = createInitialControllerState([]);
  value.projectEnabled["project-one"] = true;
  value.executions.push(...executions);
  return value;
}

function ok(stdout = ""): CommandExecutionResult {
  return {
    status: "exited",
    exitCode: 0,
    stdout,
    stderr: "",
    processId: null,
  };
}

function pane(paneId: string, name: string, processId: number): HerdrPane {
  return { paneId, name, processId };
}

function protocolPane(paneId: string, name: string | null): Record<string, unknown> {
  return {
    pane_id: paneId,
    terminal_id: `terminal-${paneId}`,
    workspace_id: "workspace-factory",
    tab_id: "tab-factory",
    focused: false,
    agent_status: "working",
    revision: 1,
    label: name,
  };
}

function paneInfoOutput(paneId: string, name: string | null): string {
  return JSON.stringify({
    id: "response-pane",
    result: {
      type: "pane_info",
      pane: protocolPane(paneId, name),
    },
  });
}

function paneListOutput(...panes: readonly [string, string | null][]): string {
  return JSON.stringify({
    id: "response-list",
    result: {
      type: "pane_list",
      panes: panes.map(([paneId, name]) => protocolPane(paneId, name)),
    },
  });
}

function processInfoOutput(paneId: string, processId: number): string {
  return JSON.stringify({
    id: "response-process",
    result: {
      type: "pane_process_info",
      process_info: {
        pane_id: paneId,
        shell_pid: processId,
      },
    },
  });
}

function workerCommand(): CommandRequest {
  return {
    executable: "bun",
    argv: [
      "/factory/bin/worker-command.ts",
      "/factory/state/execution-details/execution-1-1.spec.json",
    ],
    cwd: "/factory/worktrees/project-one/issue-1",
    env: {},
    stdin: "",
    stdout: "capture-json-lines",
    stderr: "capture",
  };
}

async function temporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "agent-factory-herdr-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Herdr session scoping and pane custody", () => {
  test("strictly parses untrusted Herdr pane output", () => {
    expect(parseHerdrPaneOutput(paneInfoOutput("pane-1", "execution-1"))).toEqual({
      paneId: "pane-1",
      name: "execution-1",
    });
    expect(() =>
      parseHerdrPaneOutput(
        JSON.stringify({
          id: "response-pane",
          result: {
            type: "pane_info",
            pane: {
              ...protocolPane("pane-1", "execution-1"),
              unknown: "do-not-retain",
            },
          },
          unrelatedSession: "do-not-retain",
        }),
      ),
    ).toThrow();
    expect(parseHerdrPaneProcessOutput(processInfoOutput("pane-1", 101))).toEqual({
      paneId: "pane-1",
      processId: 101,
    });
    expect(
      parseHerdrPaneProcessOutput(
        JSON.stringify({
          id: "response-process",
          result: {
            type: "pane_process_info",
            process_info: {
              pane_id: "pane-1",
              shell_pid: null,
            },
          },
        }),
      ),
    ).toEqual({ paneId: "pane-1", processId: null });
  });

  test("structurally rejects every operation aimed at another Herdr session", async () => {
    const command = workerCommand();
    const operations = [
      { kind: "ensure-session", sessionName: "unrelated" },
      { kind: "list-panes", sessionName: "unrelated" },
      {
        kind: "create-pane",
        sessionName: "unrelated",
        paneName: "execution-1",
        command,
      },
      {
        kind: "kill-pane",
        sessionName: "unrelated",
        paneId: "pane-1",
      },
      {
        kind: "attach-pane",
        sessionName: "unrelated",
        paneId: "pane-1",
      },
      {
        kind: "takeover-pane",
        sessionName: "unrelated",
        paneId: "pane-1",
      },
    ];
    for (const operation of operations) {
      expect(() => assertFactoryHerdrOperation(operation)).toThrow(HerdrScopeError);
    }
    expect(() =>
      assertFactoryHerdrOperation({
        kind: "create-pane",
        sessionName: FACTORY_HERDR_SESSION,
        paneName: "execution-1",
        command: {
          ...command,
          env: { GH_TOKEN: "ghs_must-not-reach-herdr-argv" },
        },
      }),
    ).toThrow(HerdrScopeError);
    expect(() =>
      assertFactoryHerdrOperation({
        kind: "create-pane",
        sessionName: FACTORY_HERDR_SESSION,
        paneName: "execution-1",
        command: {
          ...command,
          stdin: "must not reach herdr send-text argv",
        },
      }),
    ).toThrow(HerdrScopeError);
    expect(() =>
      assertFactoryHerdrOperation({
        kind: "create-pane",
        sessionName: FACTORY_HERDR_SESSION,
        paneName: "execution-1",
        command: {
          ...command,
          executable: "claude",
          argv: ["--print"],
        },
      }),
    ).toThrow(HerdrScopeError);

    const commands = new ScriptedCommandAdapter([]);
    const guarded = new GuardedHerdrCommandAdapter({
      commands,
      workingDirectory: "/factory/state",
    });
    await expect(guarded.execute(operations[0])).rejects.toBeInstanceOf(HerdrScopeError);
    expect(commands.requests).toEqual([]);
  });

  test("creates, lists, attaches, takes over, and kills only factory panes", async () => {
    await temporaryDirectory(async (directory) => {
      const clock = new FixedClockAdapter();
      const ledger = openSqliteLedger({
        stateDirectory: directory,
        instanceId: "controller-a",
        clock,
        ids: new Ids(),
        initialState: state([execution("execution-1", 1)]),
      });
      const attempt = ledger.startAttempt("execution-1");
      const livePane = pane("pane-1", "execution-1", 101);
      const paneList = paneListOutput(["pane-1", "execution-1"]);
      const paneProcess = processInfoOutput("pane-1", 101);
      const commands = new ScriptedCommandAdapter([
        ok(),
        ok(paneInfoOutput("pane-1", null)),
        ok(),
        ok(),
        ok(paneProcess),
        ok(paneList),
        ok(paneProcess),
        ok(paneList),
        ok(paneProcess),
        ok(),
        ok(paneList),
        ok(paneProcess),
        ok(),
        ok(paneList),
        ok(paneProcess),
        ok(),
      ]);
      const manager = new HerdrSessionManager({
        herdr: new GuardedHerdrCommandAdapter({
          commands,
          workingDirectory: "/factory/state",
        }),
        processes: new ScriptedProcessTreeAdapter([
          {
            rootProcessId: 101,
            tree: [
              {
                processId: 101,
                parentProcessId: null,
                startedAt,
              },
              {
                processId: 102,
                parentProcessId: 101,
                startedAt,
              },
            ],
          },
          {
            rootProcessId: 101,
            tree: [{ processId: 101, parentProcessId: null, startedAt }],
          },
          {
            rootProcessId: 101,
            tree: [{ processId: 101, parentProcessId: null, startedAt }],
          },
          {
            rootProcessId: 101,
            tree: [{ processId: 101, parentProcessId: null, startedAt }],
          },
        ]),
        repository: ledger,
        clock,
        hostIdentity: "factory-host",
      });

      const created = await manager.createPane({
        executionId: "execution-1",
        attemptNumber: attempt.attemptNumber,
        providerSessionId: "session-1",
        command: workerCommand(),
      });
      expect(created).toMatchObject({
        paneId: "pane-1",
        processId: 101,
        processStartedAt: startedAt,
        hostIdentity: "factory-host",
      });
      expect(await manager.listPanes()).toEqual([livePane]);

      await manager.attach("execution-1");
      clock.advance(1_000);
      await manager.takeover("execution-1");
      clock.advance(1_000);
      const killed = await manager.kill("execution-1");
      expect(killed.runtimeMetadata).toMatchObject({
        sessionName: FACTORY_HERDR_SESSION,
        custody: "operator",
        providerSessionId: "session-1",
        lastAttachedAt: "2026-07-23T00:00:01.000Z",
        takenOverAt: "2026-07-23T00:00:01.000Z",
        killedAt: "2026-07-23T00:00:02.000Z",
      });
      expect(
        commands.requests.every((request) => {
          return request.argv[0] === "--session" && request.argv[1] === FACTORY_HERDR_SESSION;
        }),
      ).toBe(true);
      expect(commands.requests[0]?.argv).toEqual([
        "--session",
        FACTORY_HERDR_SESSION,
        "api",
        "snapshot",
      ]);
      expect(commands.requests[1]?.argv).toEqual([
        "--session",
        FACTORY_HERDR_SESSION,
        "pane",
        "split",
        "--current",
        "--direction",
        "right",
        "--cwd",
        "/factory/worktrees/project-one/issue-1",
        "--no-focus",
      ]);
      expect(commands.requests[3]?.argv).toEqual([
        "--session",
        FACTORY_HERDR_SESSION,
        "pane",
        "run",
        "pane-1",
        "--",
        "bun",
        "/factory/bin/worker-command.ts",
        "/factory/state/execution-details/execution-1-1.spec.json",
      ]);
      expect(commands.requests[9]?.argv).toEqual([
        "--session",
        FACTORY_HERDR_SESSION,
        "agent",
        "attach",
        "pane-1",
      ]);
      expect(commands.requests[12]?.argv).toEqual([
        "--session",
        FACTORY_HERDR_SESSION,
        "agent",
        "attach",
        "pane-1",
        "--takeover",
      ]);
      expect(commands.requests.at(-1)?.argv).toEqual([
        "--session",
        FACTORY_HERDR_SESSION,
        "pane",
        "close",
        "pane-1",
      ]);
      expect(commands.remaining()).toBe(0);
      ledger.close();
    });
  });

  test("refuses to kill a reused pane identity", async () => {
    await temporaryDirectory(async (directory) => {
      const clock = new FixedClockAdapter();
      const ledger = openSqliteLedger({
        stateDirectory: directory,
        instanceId: "controller-a",
        clock,
        ids: new Ids(),
        initialState: state([execution("execution-1", 1)]),
      });
      const attempt = ledger.startAttempt("execution-1");
      ledger.saveProcessMetadata({
        executionId: "execution-1",
        attemptNumber: attempt.attemptNumber,
        paneId: "pane-1",
        processId: 101,
        processStartedAt: startedAt,
        hostIdentity: "factory-host",
        runtimeMetadata: {},
      });
      const commands = new ScriptedCommandAdapter([
        ok(paneListOutput(["pane-1", "execution-1"])),
        ok(processInfoOutput("pane-1", 999)),
      ]);
      const manager = new HerdrSessionManager({
        herdr: new GuardedHerdrCommandAdapter({
          commands,
          workingDirectory: "/factory/state",
        }),
        processes: new ScriptedProcessTreeAdapter([
          {
            rootProcessId: 101,
            tree: [
              {
                processId: 101,
                parentProcessId: null,
                startedAt,
              },
            ],
          },
        ]),
        repository: ledger,
        clock,
        hostIdentity: "factory-host",
      });

      await expect(manager.kill("execution-1")).rejects.toThrow(
        "no longer has its recorded live Herdr pane",
      );
      expect(commands.requests.some((request) => request.argv.includes("close"))).toBe(false);
      ledger.close();
    });
  });
});

describe("controller restart recovery", () => {
  test("re-associates live panes and classifies results and PID reuse without killing workers", async () => {
    await temporaryDirectory(async (directory) => {
      const clock = new FixedClockAdapter();
      const initial = state([
        execution("execution-1", 1),
        execution("execution-2", 2),
        execution("execution-3", 3),
      ]);
      const first = openSqliteLedger({
        stateDirectory: directory,
        instanceId: "controller-a",
        clock,
        ids: new Ids(),
        initialState: initial,
      });
      for (const [index, id] of ["execution-1", "execution-2", "execution-3"].entries()) {
        const attempt = first.startAttempt(id);
        first.saveProcessMetadata({
          executionId: id,
          attemptNumber: attempt.attemptNumber,
          paneId: `pane-${index + 1}`,
          processId: 201 + index,
          processStartedAt: startedAt,
          hostIdentity: "factory-host",
          runtimeMetadata: {},
        });
        if (id === "execution-2") {
          first.updateAttempt({
            executionId: id,
            attemptNumber: attempt.attemptNumber,
            status: "blocked",
            checkpoint: "handoff",
            outcome: "blocked",
            reasonCode: "blocked-external",
          });
        }
      }
      first.close();

      const restarted = openSqliteLedger({
        stateDirectory: directory,
        instanceId: "controller-b",
        clock,
        ids: new Ids(),
        initialState: state([]),
      });
      const commands = new ScriptedCommandAdapter([
        ok(),
        ok(paneListOutput(["pane-1", "execution-1"], ["pane-3", "execution-3"])),
        ok(processInfoOutput("pane-1", 201)),
        ok(processInfoOutput("pane-3", 203)),
      ]);
      const processes = new ScriptedProcessTreeAdapter([
        {
          rootProcessId: 201,
          tree: [
            {
              processId: 201,
              parentProcessId: null,
              startedAt,
            },
          ],
        },
        { rootProcessId: 202, tree: [] },
        {
          rootProcessId: 203,
          tree: [
            {
              processId: 203,
              parentProcessId: null,
              startedAt: "2026-07-23T00:05:00.000Z",
            },
          ],
        },
      ]);
      const manager = new HerdrSessionManager({
        herdr: new GuardedHerdrCommandAdapter({
          commands,
          workingDirectory: "/factory/state",
        }),
        processes,
        repository: restarted,
        clock,
        hostIdentity: "factory-host",
      });

      expect(await manager.recover()).toEqual([
        {
          executionId: "execution-1",
          classification: "still-running",
          paneId: "pane-1",
          processId: 201,
        },
        {
          executionId: "execution-2",
          classification: "exited-with-result",
          paneId: "pane-2",
          processId: 202,
        },
        {
          executionId: "execution-3",
          classification: "orphaned",
          paneId: "pane-3",
          processId: 203,
        },
      ]);
      expect(processes.inspections).toEqual([201, 202, 203]);
      expect(commands.requests.some((request) => request.argv.includes("close"))).toBe(false);
      expect(commands.remaining()).toBe(0);
      restarted.close();
    });
  });
});
