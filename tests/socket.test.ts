import { describe, expect, test } from "bun:test";
import { DAEMON_PROTOCOL_VERSION, DaemonResponseSchema } from "../src/contracts/daemon-protocol";
import type { DaemonCommandRouter } from "../src/daemon/router";
import { AGENT_FACTORY_SOCKET_MODE, handleDaemonRequest } from "../src/daemon/socket";

class ScriptedRouter implements DaemonCommandRouter {
  public calls: unknown[] = [];

  public async dispatch(request: unknown): Promise<unknown> {
    this.calls.push(request);
    return { status: "ok" };
  }
}

describe("daemon socket protocol", () => {
  test("declares an owner-only socket mode", () => {
    expect(AGENT_FACTORY_SOCKET_MODE).toBe(0o600);
  });

  test("validates requests and responses on both sides", async () => {
    const router = new ScriptedRouter();
    const result = await handleDaemonRequest(
      JSON.stringify({
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        requestId: "request-1",
        request: { operation: "status" },
      }),
      router,
    );
    expect(result.status).toBe(200);
    expect(DaemonResponseSchema.parse(JSON.parse(result.body))).toEqual({
      protocolVersion: 1,
      requestId: "request-1",
      ok: true,
      result: { status: "ok" },
    });
    expect(router.calls).toEqual([{ operation: "status" }]);
  });

  test("rejects malformed JSON, unknown keys, and oversized requests without dispatch", async () => {
    const router = new ScriptedRouter();
    const invalidJson = await handleDaemonRequest("{", router);
    expect(JSON.parse(invalidJson.body)).toMatchObject({
      ok: false,
      error: { code: "invalid-json" },
    });
    const unknown = await handleDaemonRequest(
      JSON.stringify({
        protocolVersion: 1,
        requestId: "request-2",
        request: { operation: "status", unexpected: true },
      }),
      router,
    );
    expect(JSON.parse(unknown.body)).toMatchObject({
      ok: false,
      error: { code: "invalid-request" },
    });
    const unsafeRequestId = await handleDaemonRequest(
      JSON.stringify({
        protocolVersion: 1,
        requestId: "not a safe request id",
        request: { operation: "status" },
      }),
      router,
    );
    expect(JSON.parse(unsafeRequestId.body)).toMatchObject({
      requestId: "invalid-request",
      ok: false,
    });
    const oversized = await handleDaemonRequest("x".repeat(1024 * 1024 + 1), router);
    expect(JSON.parse(oversized.body)).toMatchObject({
      ok: false,
      error: { code: "request-too-large" },
    });
    expect(router.calls).toEqual([]);
  });

  test("redacts daemon errors before returning them", async () => {
    const result = await handleDaemonRequest(
      JSON.stringify({
        protocolVersion: 1,
        requestId: "request-3",
        request: { operation: "status" },
      }),
      {
        async dispatch() {
          throw new Error("failed at /srv/private/checkout");
        },
      },
    );
    expect(result.body).not.toContain("/srv/private");
    expect(result.body).toContain("[REDACTED_PATH]");
  });
});
