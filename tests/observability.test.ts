import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NtfyNotificationAdapter } from "@/adapters/ntfy.ts";
import { RotatingJsonLinesSink } from "@/adapters/structured-log.ts";
import { FactoryNotifications, StructuredLogger } from "@/operations/observability.ts";
import { StructuredRedactionBoundary } from "@/redaction/index.ts";
import { FixedClockAdapter, InMemoryNotificationAdapter } from "@/testing/index.ts";

describe("structured logging", () => {
	test("redacts sentinels before writing and rotates by size", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-factory-log-"));
		try {
			const path = join(directory, "factory.jsonl");
			const redaction = new StructuredRedactionBoundary({
				environmentValues: ["environment-secret"],
			});
			const logger = new StructuredLogger({
				clock: new FixedClockAdapter(),
				sink: new RotatingJsonLinesSink({
					path,
					rotateBytes: 220,
					retainedFiles: 2,
				}),
				redaction,
			});
			await logger.write("info", "worker.started", {
				path: "/srv/private/project",
				token: "github_pat_super-secret",
				environment: "environment-secret",
			});
			await logger.write("warn", "worker.stalled", {
				detail: "Bearer abcdefghijklmnop",
			});
			expect(existsSync(`${path}.1`)).toBe(true);
			const all = [path, `${path}.1`]
				.filter(existsSync)
				.map((file) => readFileSync(file, "utf8"))
				.join("");
			expect(redaction.scan(all)).toEqual([]);
			expect(all).toContain("[REDACTED_PATH]");
			expect(all).toContain("[REDACTED]");
			expect(all).toContain("[REDACTED_ENV]");
			expect(await logger.recent(10)).toHaveLength(2);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("ntfy notifications", () => {
	test("sanitizes alert and digest content", async () => {
		const adapter = new InMemoryNotificationAdapter();
		const redaction = new StructuredRedactionBoundary({
			environmentValues: ["secret-environment-value"],
		});
		const notifications = new FactoryNotifications({
			topic: "factory-alerts",
			notifications: adapter,
			redaction,
		});
		await notifications.alert("stalled-handoff", {
			detail: "/private/path github_pat_abcdef secret-environment-value",
		});
		await notifications.digest({
			status: {
				observedAt: "2026-07-23T00:00:00.000Z",
				mode: "observation",
				rolloutStage: "stage1",
				revision: 1,
				limits: { implementation: 1, feedback: 1, readyToMerge: 1 },
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
			},
			maintenance: [],
			circuits: [],
			releases: [],
		});
		expect(adapter.sent).toHaveLength(2);
		expect(redaction.scan(JSON.stringify(adapter.sent))).toEqual([]);
		expect(adapter.sent[0]?.body).toContain("[REDACTED_PATH]");
		expect(adapter.sent[1]?.body).toContain('"rolloutStage":"stage1"');
	});

	test("uses injected HTTP transport without ambient network", async () => {
		const requests: unknown[] = [];
		const adapter = new NtfyNotificationAdapter({
			baseUrl: "https://ntfy.example.test",
			transport: {
				async request(input) {
					requests.push(input);
					return { status: 200, body: "ok" };
				},
			},
		});
		await adapter.send({
			topic: "factory-alerts",
			title: "Digest",
			body: "safe body",
		});
		expect(requests).toEqual([
			{
				url: "https://ntfy.example.test/factory-alerts",
				headers: {
					"content-type": "text/plain; charset=utf-8",
					title: "Digest",
				},
				body: "safe body",
			},
		]);
	});
});
