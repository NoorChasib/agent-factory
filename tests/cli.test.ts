import { describe, expect, test } from "bun:test";

import {
  AgentFactoryDaemonClient,
  type AgentFactoryOperation,
  DAEMON_PROTOCOL_VERSION,
  DaemonRequestSchema,
  DaemonUnavailableError,
  parseCliArguments,
} from "../src";
import type { DaemonTransport } from "../src/cli/client";
import { runCli } from "../src/cli/main";

const hash = "a".repeat(64);
const commitSha = "b".repeat(40);

const COMMANDS: readonly [
  readonly string[],
  AgentFactoryOperation | "doctor" | "help" | "version",
][] = [
  [["status"], { operation: "status" }],
  [["workers"], { operation: "workers" }],
  [["show", "execution-1"], { operation: "show", executionId: "execution-1" }],
  [["logs"], { operation: "logs", lines: 200 }],
  [["logs", "--lines", "20"], { operation: "logs", lines: 20 }],
  [["pause"], { operation: "pause" }],
  [["resume"], { operation: "resume" }],
  [["drain"], { operation: "drain" }],
  [["worker", "show", "execution-1"], { operation: "show", executionId: "execution-1" }],
  [
    ["worker", "attach", "execution-1"],
    { operation: "worker", action: "attach", executionId: "execution-1" },
  ],
  [
    ["worker", "takeover", "execution-1"],
    { operation: "worker", action: "takeover", executionId: "execution-1" },
  ],
  [
    ["worker", "resume", "execution-1"],
    { operation: "worker", action: "resume", executionId: "execution-1" },
  ],
  [
    ["worker", "release", "execution-1"],
    { operation: "worker", action: "release", executionId: "execution-1" },
  ],
  [
    ["worker", "stop", "execution-1"],
    { operation: "worker", action: "stop", executionId: "execution-1" },
  ],
  [
    ["worker", "kill", "execution-1"],
    { operation: "worker", action: "kill", executionId: "execution-1" },
  ],
  [["circuits"], { operation: "circuits" }],
  [["project", "list"], { operation: "project", action: "list" }],
  [["project", "validate"], { operation: "project", action: "validate" }],
  [
    ["project", "validate", "project-one"],
    { operation: "project", action: "validate", projectId: "project-one" },
  ],
  [
    ["project", "enable", "project-one"],
    { operation: "project", action: "enable", projectId: "project-one" },
  ],
  [
    ["project", "disable", "project-one"],
    { operation: "project", action: "disable", projectId: "project-one" },
  ],
  [["config", "list"], { operation: "config", action: "list" }],
  [["config", "validate"], { operation: "config", action: "validate" }],
  [["rollout", "status"], { operation: "rollout", action: "status" }],
  [["rollout", "promote"], { operation: "rollout", action: "promote" }],
  [["rollout", "demote"], { operation: "rollout", action: "demote" }],
  [
    ["labels", "plan", "project-one"],
    { operation: "labels", action: "plan", projectId: "project-one" },
  ],
  [
    ["labels", "preview", "project-one"],
    { operation: "labels", action: "preview", projectId: "project-one" },
  ],
  [
    ["labels", "apply", "project-one", "--hash", hash],
    { operation: "labels", action: "apply", projectId: "project-one", hash },
  ],
  [["update", "status"], { operation: "update", action: "status" }],
  [["update", "queue", commitSha], { operation: "update", action: "queue", releaseId: commitSha }],
  [["doctor"], "doctor"],
  [["doctor", "--live"], { operation: "doctor-live" }],
  [["reconcile"], { operation: "reconcile" }],
  [["notifications", "test"], { operation: "notifications", action: "test" }],
  [["notifications", "digest"], { operation: "notifications", action: "digest" }],
  [["shutdown", "--when-idle"], { operation: "shutdown", whenIdle: true }],
  [["version"], "version"],
  [["help"], "help"],
];

describe("CLI argument contract", () => {
  test("parses every documented command into a validated operation", () => {
    for (const [argv, expected] of COMMANDS) {
      const parsed = parseCliArguments(argv);
      if (typeof expected === "string") {
        expect(parsed.kind).toBe(expected);
      } else {
        expect(parsed).toEqual({ kind: "daemon", request: expected });
      }
    }
  });

  test("rejects missing operands, unknown flags, and non-exact label hashes", () => {
    expect(() => parseCliArguments(["worker", "kill"])).toThrow("usage:");
    expect(() => parseCliArguments(["shutdown"])).toThrow("usage:");
    expect(() => parseCliArguments(["doctor", "--network"])).toThrow("usage:");
    expect(() =>
      parseCliArguments(["labels", "apply", "project-one", "--hash", "short"]),
    ).toThrow();
  });
});

class ScriptedTransport implements DaemonTransport {
  public request: unknown = null;

  public async exchange(_socketPath: string, requestBody: string): Promise<string> {
    const request = DaemonRequestSchema.parse(JSON.parse(requestBody));
    this.request = request;
    return JSON.stringify({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: { accepted: request.request.operation },
    });
  }
}

describe("CLI dispatch", () => {
  test("dispatches every daemon-backed command through the scripted socket", async () => {
    for (const [argv, expected] of COMMANDS) {
      if (typeof expected === "string") {
        continue;
      }
      const transport = new ScriptedTransport();
      const client = new AgentFactoryDaemonClient({
        socketPath: "/tmp/factory.sock",
        transport,
        nextRequestId: () => "matrix-request",
      });
      expect(
        await runCli(argv, {
          client,
          doctor: {
            async run() {
              throw new Error("local doctor should not handle daemon-backed commands");
            },
          },
          version: "1",
          io: { out() {}, error() {} },
        }),
      ).toBe(0);
      expect(transport.request).toMatchObject({ request: expected });
    }
  });

  test("dispatches through the socket client and renders structured output", async () => {
    const transport = new ScriptedTransport();
    const client = new AgentFactoryDaemonClient({
      socketPath: "/tmp/factory.sock",
      transport,
      nextRequestId: () => "request-1",
    });
    const output: string[] = [];
    const errors: string[] = [];
    const code = await runCli(["pause"], {
      client,
      doctor: {
        async run() {
          throw new Error("doctor should not run");
        },
      },
      version: "1.2.3",
      io: { out: (text) => output.push(text), error: (text) => errors.push(text) },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(transport.request).toMatchObject({
      requestId: "request-1",
      request: { operation: "pause" },
    });
    expect(JSON.parse(output.join(""))).toEqual({ accepted: "pause" });
  });

  test("validates the outbound request envelope before transport", async () => {
    let transportCalls = 0;
    const client = new AgentFactoryDaemonClient({
      socketPath: "/tmp/factory.sock",
      transport: {
        async exchange() {
          transportCalls += 1;
          return "";
        },
      },
      nextRequestId: () => "invalid request id",
    });
    await expect(client.request({ operation: "status" })).rejects.toThrow();
    expect(transportCalls).toBe(0);
  });

  test("version and help do not contact the daemon", async () => {
    let daemonCalls = 0;
    const output: string[] = [];
    const dependencies = {
      client: {
        async request() {
          daemonCalls += 1;
          return {};
        },
      },
      doctor: {
        async run() {
          throw new Error("doctor should not run");
        },
      },
      version: "9.8.7",
      io: { out: (text: string) => output.push(text), error() {} },
    };
    expect(await runCli(["version"], dependencies)).toBe(0);
    expect(await runCli(["help"], dependencies)).toBe(0);
    expect(daemonCalls).toBe(0);
    expect(output[0]).toBe("agent-factory 9.8.7\n");
    expect(output[1]).toContain("shutdown --when-idle");
  });

  test("daemon absence is clear and non-zero", async () => {
    const errors: string[] = [];
    const code = await runCli(["status"], {
      client: {
        async request() {
          throw new DaemonUnavailableError("/state/agent-factory.sock");
        },
      },
      doctor: {
        async run() {
          throw new Error("unused");
        },
      },
      version: "1",
      io: { out() {}, error: (text) => errors.push(text) },
    });
    expect(code).toBe(1);
    expect(errors.join("")).toContain("daemon is not running");
  });
});
