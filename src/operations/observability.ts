import { z } from "zod";

import type {
	ClockAdapter,
	Notification,
	NotificationAdapter,
	StructuredLogSink,
} from "@/adapters/interfaces.ts";
import type { ControllerStatus } from "@/controller/controller.ts";
import type { MaintenanceRequest, ProviderCircuitRecord, ReleaseRecord } from "@/ledger/index.ts";
import {
	DEFAULT_REDACTION_BOUNDARY,
	type RedactedJson,
	type RedactionBoundary,
} from "@/redaction/index.ts";

const logLevel = z.enum(["debug", "info", "warn", "error"]);
const logEvent = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u);

export interface StructuredLogRecord {
	readonly timestamp: string;
	readonly level: z.infer<typeof logLevel>;
	readonly event: string;
	readonly data: RedactedJson;
}

export class StructuredLogger {
	readonly #clock: ClockAdapter;
	readonly #sink: StructuredLogSink;
	readonly #redaction: RedactionBoundary;

	public constructor(input: {
		readonly clock: ClockAdapter;
		readonly sink: StructuredLogSink;
		readonly redaction?: RedactionBoundary;
	}) {
		this.#clock = input.clock;
		this.#sink = input.sink;
		this.#redaction = input.redaction ?? DEFAULT_REDACTION_BOUNDARY;
	}

	public async write(
		levelInput: z.input<typeof logLevel>,
		eventInput: string,
		data: unknown,
	): Promise<StructuredLogRecord> {
		const now = this.#clock.now();
		if (!Number.isFinite(now.getTime())) {
			throw new Error("structured logger clock returned an invalid date");
		}
		const record: StructuredLogRecord = {
			timestamp: now.toISOString(),
			level: logLevel.parse(levelInput),
			event: logEvent.parse(eventInput),
			data: this.#redaction.sanitize(data),
		};
		const line = JSON.stringify(record);
		const sentinels = this.#redaction.scan(line);
		if (sentinels.length > 0) {
			throw new Error(`structured log failed redaction: ${sentinels.join(", ")}`);
		}
		await this.#sink.append(line);
		return record;
	}

	public async recent(lines: number): Promise<readonly RedactedJson[]> {
		const requested = z.number().int().min(1).max(10_000).parse(lines);
		const raw = await this.#sink.readRecent(requested);
		return raw.map((line) => this.#redaction.sanitize(JSON.parse(line)));
	}
}

export type FactoryAlert =
	| "circuit-open"
	| "disk-guard"
	| "drained"
	| "shutdown-ready"
	| "stalled-handoff"
	| "update-failed"
	| "update-rollback";

export interface NotificationDigestInput {
	readonly status: ControllerStatus;
	readonly maintenance: readonly MaintenanceRequest[];
	readonly circuits: readonly ProviderCircuitRecord[];
	readonly releases: readonly ReleaseRecord[];
}

export class FactoryNotifications {
	readonly #topic: string;
	readonly #notifications: NotificationAdapter;
	readonly #redaction: RedactionBoundary;

	public constructor(input: {
		readonly topic: string;
		readonly notifications: NotificationAdapter;
		readonly redaction?: RedactionBoundary;
	}) {
		this.#topic = z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9_-]+$/u)
			.parse(input.topic);
		this.#notifications = input.notifications;
		this.#redaction = input.redaction ?? DEFAULT_REDACTION_BOUNDARY;
	}

	public async alert(kind: FactoryAlert, detail: unknown): Promise<Notification> {
		const titles: Record<FactoryAlert, string> = {
			"circuit-open": "Agent Factory provider circuit opened",
			"disk-guard": "Agent Factory disk guard activated",
			drained: "Agent Factory drained",
			"shutdown-ready": "Agent Factory VPS ready to restart",
			"stalled-handoff": "Agent Factory worker handoff stalled",
			"update-failed": "Agent Factory update failed",
			"update-rollback": "Agent Factory update rolled back",
		};
		return this.#send(titles[kind], { kind, detail });
	}

	public async test(): Promise<Notification> {
		return this.#send("Agent Factory notification test", {
			kind: "test",
			status: "notification transport is configured",
		});
	}

	public async digest(input: NotificationDigestInput): Promise<Notification> {
		return this.#send("Agent Factory digest", {
			mode: input.status.mode,
			rolloutStage: input.status.rolloutStage,
			activeWorkers: input.status.executions.filter((execution) => execution.status === "active")
				.length,
			projects: input.status.projects.map((project) => ({
				id: project.id,
				enabled: project.enabled,
				readyToMerge: project.readyToMerge,
			})),
			activeMaintenance: input.maintenance.filter(
				(request) => request.status === "active" || request.status === "pending",
			),
			openCircuits: input.circuits.filter((circuit) => circuit.status === "open"),
			releases: input.releases.map((release) => ({
				releaseId: release.releaseId,
				status: release.status,
			})),
		});
	}

	async #send(title: string, body: unknown): Promise<Notification> {
		const notification = {
			topic: this.#topic,
			title: this.#redaction.sanitizeText(title),
			body: JSON.stringify(this.#redaction.sanitize(body)),
		};
		const sentinels = this.#redaction.scan(JSON.stringify(notification));
		if (sentinels.length > 0) {
			throw new Error(`notification failed redaction: ${sentinels.join(", ")}`);
		}
		await this.#notifications.send(notification);
		return notification;
	}
}
