import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";

import { z } from "zod";

import {
  DAEMON_PROTOCOL_VERSION,
  DaemonRequestSchema,
  type DaemonResponse,
  DaemonResponseSchema,
} from "../contracts/daemon-protocol";
import { MAX_UNIX_SOCKET_PATH_BYTES } from "../operations/runtime";
import { DEFAULT_REDACTION_BOUNDARY, type RedactionBoundary } from "../redaction";
import type { DaemonCommandRouter } from "./router";

const MAX_REQUEST_BYTES = 1024 * 1024;
export const AGENT_FACTORY_SOCKET_MODE = 0o600;

export interface DaemonHttpResult {
  readonly status: number;
  readonly body: string;
}

function jsonValue(input: unknown): z.infer<ReturnType<typeof z.json>> {
  return z.json().parse(JSON.parse(JSON.stringify(input)));
}

function failure(requestId: string, code: string, message: string): DaemonResponse {
  return DaemonResponseSchema.parse({
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  });
}

export async function handleDaemonRequest(
  raw: string,
  router: DaemonCommandRouter,
  redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
): Promise<DaemonHttpResult> {
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    return {
      status: 200,
      body: JSON.stringify(
        failure("invalid-request", "request-too-large", "request exceeds 1 MiB"),
      ),
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      status: 200,
      body: JSON.stringify(failure("invalid-request", "invalid-json", "request is not valid JSON")),
    };
  }
  const parsed = DaemonRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    const candidate = z
      .object({ requestId: DaemonRequestSchema.shape.requestId })
      .safeParse(decoded);
    const requestId = candidate.success ? candidate.data.requestId : "invalid-request";
    return {
      status: 200,
      body: JSON.stringify(
        failure(requestId, "invalid-request", "request does not match the daemon protocol"),
      ),
    };
  }
  try {
    const result = await router.dispatch(parsed.data.request);
    const response = DaemonResponseSchema.parse({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId: parsed.data.requestId,
      ok: true,
      result: jsonValue(result),
    });
    return { status: 200, body: JSON.stringify(response) };
  } catch (error) {
    const message = redaction.sanitizeText(
      error instanceof Error ? error.message : "daemon request failed",
    );
    const response = failure(parsed.data.requestId, "request-failed", message);
    return { status: 200, body: JSON.stringify(response) };
  }
}

export interface UnixSocketServer {
  readonly socketPath: string;
  stop(): Promise<void>;
}

export function startUnixSocketServer(input: {
  readonly socketPath: string;
  readonly router: DaemonCommandRouter;
  readonly redaction?: RedactionBoundary;
}): UnixSocketServer {
  if (new TextEncoder().encode(input.socketPath).byteLength > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error("Agent Factory Unix socket path is too long");
  }
  if (existsSync(input.socketPath)) {
    const metadata = lstatSync(input.socketPath);
    if (!metadata.isSocket()) {
      throw new Error("refusing to replace a non-socket at the Agent Factory socket path");
    }
    unlinkSync(input.socketPath);
  }
  const server = Bun.serve({
    unix: input.socketPath,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, protocolVersion: DAEMON_PROTOCOL_VERSION });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/request") {
        return new Response("not found", { status: 404 });
      }
      const result = await handleDaemonRequest(await request.text(), input.router, input.redaction);
      return new Response(result.body, {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  chmodSync(input.socketPath, AGENT_FACTORY_SOCKET_MODE);
  return {
    socketPath: input.socketPath,
    async stop(): Promise<void> {
      await server.stop(true);
      if (existsSync(input.socketPath) && lstatSync(input.socketPath).isSocket()) {
        unlinkSync(input.socketPath);
      }
    },
  };
}
