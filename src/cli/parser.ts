import { z } from "zod";

import type { AgentFactoryOperation } from "../contracts/daemon-protocol";
import { AgentFactoryOperationSchema } from "../contracts/daemon-protocol";

export type CliInvocation =
	| { readonly kind: "help" }
	| { readonly kind: "version" }
	| { readonly kind: "doctor" }
	| { readonly kind: "daemon"; readonly request: AgentFactoryOperation };

export class CliUsageError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

const positiveInteger = z.coerce.number().int().min(1).max(10_000);

function daemon(request: unknown): CliInvocation {
	return { kind: "daemon", request: AgentFactoryOperationSchema.parse(request) };
}

function exact(args: readonly string[], count: number, usage: string): void {
	if (args.length !== count) {
		throw new CliUsageError(`usage: agent-factory ${usage}`);
	}
}

function parseWorker(args: readonly string[]): CliInvocation {
	exact(args, 2, "worker <show|attach|takeover|resume|release|stop|kill> <execution>");
	const action = args[0];
	if (action === "show") {
		return daemon({ operation: "show", executionId: args[1] });
	}
	if (
		action === undefined ||
		!["attach", "takeover", "resume", "release", "stop", "kill"].includes(action)
	) {
		throw new CliUsageError(
			"usage: agent-factory worker <show|attach|takeover|resume|release|stop|kill> <execution>",
		);
	}
	return daemon({ operation: "worker", action, executionId: args[1] });
}

function parseProject(args: readonly string[]): CliInvocation {
	const action = args[0];
	if (action === "list") {
		exact(args, 1, "project list");
		return daemon({ operation: "project", action });
	}
	if (action === "validate") {
		if (args.length < 1 || args.length > 2) {
			throw new CliUsageError("usage: agent-factory project validate [project]");
		}
		return daemon({
			operation: "project",
			action,
			...(args[1] === undefined ? {} : { projectId: args[1] }),
		});
	}
	if (action === "enable" || action === "disable") {
		exact(args, 2, `project ${action} <project>`);
		return daemon({ operation: "project", action, projectId: args[1] });
	}
	throw new CliUsageError("usage: agent-factory project <list|validate|enable|disable> [project]");
}

function parseLabels(args: readonly string[]): CliInvocation {
	const action = args[0];
	if (action === "plan" || action === "preview") {
		exact(args, 2, `labels ${action} <project>`);
		return daemon({ operation: "labels", action, projectId: args[1] });
	}
	if (action === "apply") {
		exact(args, 4, "labels apply <project> --hash <sha256>");
		if (args[2] !== "--hash") {
			throw new CliUsageError("usage: agent-factory labels apply <project> --hash <sha256>");
		}
		return daemon({
			operation: "labels",
			action,
			projectId: args[1],
			hash: args[3],
		});
	}
	throw new CliUsageError("usage: agent-factory labels <plan|preview|apply> ...");
}

export function parseCliArguments(argv: readonly string[]): CliInvocation {
	const [command, ...args] = argv;
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		exact(args, 0, "help");
		return { kind: "help" };
	}
	if (command === "version" || command === "--version" || command === "-V") {
		exact(args, 0, "version");
		return { kind: "version" };
	}
	switch (command) {
		case "status":
		case "workers":
		case "pause":
		case "resume":
		case "drain":
		case "circuits":
		case "reconcile":
			exact(args, 0, command);
			return daemon({ operation: command });
		case "show":
			exact(args, 1, "show <execution>");
			return daemon({ operation: "show", executionId: args[0] });
		case "logs": {
			if (args.length === 0) {
				return daemon({ operation: "logs", lines: 200 });
			}
			exact(args, 2, "logs [--lines <count>]");
			if (args[0] !== "--lines") {
				throw new CliUsageError("usage: agent-factory logs [--lines <count>]");
			}
			const lines = positiveInteger.safeParse(args[1]);
			if (!lines.success) {
				throw new CliUsageError("log line count must be an integer from 1 through 10000");
			}
			return daemon({ operation: "logs", lines: lines.data });
		}
		case "worker":
			return parseWorker(args);
		case "project":
			return parseProject(args);
		case "config": {
			exact(args, 1, "config <list|validate>");
			const action = args[0];
			if (action !== "list" && action !== "validate") {
				throw new CliUsageError("usage: agent-factory config <list|validate>");
			}
			return daemon({ operation: "config", action });
		}
		case "rollout": {
			exact(args, 1, "rollout <status|promote|demote>");
			const action = args[0];
			if (action !== "status" && action !== "promote" && action !== "demote") {
				throw new CliUsageError("usage: agent-factory rollout <status|promote|demote>");
			}
			return daemon({ operation: "rollout", action });
		}
		case "labels":
			return parseLabels(args);
		case "update": {
			const action = args[0];
			if (action === "status") {
				exact(args, 1, "update status");
				return daemon({ operation: "update", action });
			}
			if (action === "queue") {
				exact(args, 2, "update queue <release>");
				return daemon({ operation: "update", action, releaseId: args[1] });
			}
			throw new CliUsageError("usage: agent-factory update <status|queue> [release]");
		}
		case "doctor":
			if (args.length === 0) {
				return { kind: "doctor" };
			}
			exact(args, 1, "doctor [--live]");
			if (args[0] !== "--live") {
				throw new CliUsageError("usage: agent-factory doctor [--live]");
			}
			return daemon({ operation: "doctor-live" });
		case "notifications": {
			exact(args, 1, "notifications <test|digest>");
			const action = args[0];
			if (action !== "test" && action !== "digest") {
				throw new CliUsageError("usage: agent-factory notifications <test|digest>");
			}
			return daemon({ operation: "notifications", action });
		}
		case "shutdown":
			exact(args, 1, "shutdown --when-idle");
			if (args[0] !== "--when-idle") {
				throw new CliUsageError("usage: agent-factory shutdown --when-idle");
			}
			return daemon({ operation: "shutdown", whenIdle: true });
		default:
			throw new CliUsageError(`unknown command '${command}'`);
	}
}

export const CLI_HELP = `Agent Factory operator CLI

Usage: agent-factory <command>

Observation:
  status                       Show controller and maintenance state
  workers                      List tracked workers
  show <execution>             Show durable execution recovery
  logs [--lines N]             Read redacted structured logs
  circuits                     Show provider circuits

Control:
  pause | resume | drain
  worker <show|attach|takeover|resume|release|stop|kill> <execution>
  reconcile
  shutdown --when-idle

Configuration:
  project <list|validate|enable|disable> [project]
  config <list|validate>
  rollout <status|promote|demote>
  labels <plan|preview> <project>
  labels apply <project> --hash <sha256>
  update <status|queue> [release]

Diagnostics:
  doctor [--live]              --live is the only provider-consuming mode
  notifications <test|digest>
  version | help
`;
