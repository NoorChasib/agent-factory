import { z } from "zod";

import { safeId } from "@/contracts/primitives.ts";

const optionalText = z.string().nullable().optional();
const uint = z.number().int().nonnegative();

const AgentSessionInfoSchema = z.strictObject({
	source: z.string(),
	agent: z.string(),
	kind: z.enum(["id", "path"]),
	value: z.string(),
});

const PaneScrollInfoSchema = z.strictObject({
	offset_from_bottom: uint,
	max_offset_from_bottom: uint,
	viewport_rows: uint,
});

const ProtocolPaneSchema = z.strictObject({
	pane_id: safeId,
	terminal_id: z.string(),
	workspace_id: z.string(),
	tab_id: z.string(),
	focused: z.boolean(),
	agent_status: z.enum(["idle", "working", "blocked", "done", "unknown"]),
	revision: uint,
	cwd: optionalText,
	foreground_cwd: optionalText,
	agent: optionalText,
	title: optionalText,
	terminal_title: optionalText,
	terminal_title_stripped: optionalText,
	display_agent: optionalText,
	label: optionalText,
	state_labels: z.record(z.string(), z.string()).optional(),
	tokens: z.record(z.string(), z.string()).optional(),
	agent_session: AgentSessionInfoSchema.nullable().optional(),
	scroll: PaneScrollInfoSchema.nullable().optional(),
});

const ProtocolProcessSchema = z.strictObject({
	pid: uint,
	name: z.string(),
	argv: z.array(z.string()).nullable().optional(),
	argv0: optionalText,
	cmdline: optionalText,
	cwd: optionalText,
});

const ProtocolProcessInfoSchema = z.strictObject({
	pane_id: safeId,
	shell_pid: uint.nullable().optional(),
	foreground_process_group_id: uint.nullable().optional(),
	tty: optionalText,
	foreground_processes: z.array(ProtocolProcessSchema).optional(),
});

export const HerdrPaneSchema = z.strictObject({
	paneId: safeId,
	name: safeId.nullable(),
	processId: z.number().int().positive().nullable(),
});

export type HerdrPane = z.infer<typeof HerdrPaneSchema>;

export interface HerdrPaneReference {
	readonly paneId: string;
	readonly name: string | null;
}

const PaneInfoResponseSchema = z.strictObject({
	id: z.string(),
	result: z.strictObject({
		type: z.literal("pane_info"),
		pane: ProtocolPaneSchema,
	}),
});

const PaneListResponseSchema = z.strictObject({
	id: z.string(),
	result: z.strictObject({
		type: z.literal("pane_list"),
		panes: z.array(ProtocolPaneSchema).max(10_000),
	}),
});

const PaneProcessInfoResponseSchema = z.strictObject({
	id: z.string(),
	result: z.strictObject({
		type: z.literal("pane_process_info"),
		process_info: ProtocolProcessInfoSchema,
	}),
});

function jsonOutput(source: string): unknown {
	if (source.length > 10 * 1_024 * 1_024) {
		throw new Error("Herdr output exceeds 10 MiB");
	}
	try {
		return JSON.parse(source) as unknown;
	} catch {
		throw new Error("Herdr returned invalid JSON");
	}
}

function paneReference(pane: z.infer<typeof ProtocolPaneSchema>): HerdrPaneReference {
	return {
		paneId: pane.pane_id,
		name: pane.label === undefined ? null : safeId.nullable().parse(pane.label),
	};
}

export function parseHerdrPaneOutput(source: string): HerdrPaneReference {
	return paneReference(PaneInfoResponseSchema.parse(jsonOutput(source)).result.pane);
}

export function parseHerdrPaneListOutput(source: string): readonly HerdrPaneReference[] {
	return PaneListResponseSchema.parse(jsonOutput(source)).result.panes.map(paneReference);
}

export function parseHerdrPaneProcessOutput(source: string): {
	readonly paneId: string;
	readonly processId: number | null;
} {
	const process = PaneProcessInfoResponseSchema.parse(jsonOutput(source)).result.process_info;
	return {
		paneId: process.pane_id,
		processId:
			process.shell_pid === undefined || process.shell_pid === null
				? null
				: z.number().int().positive().parse(process.shell_pid),
	};
}
