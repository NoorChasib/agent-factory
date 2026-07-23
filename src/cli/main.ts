#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	LocalDiskUsageAdapter,
	LocalDoctorSystemAdapter,
	LocalRuntimeFileSystemAdapter,
} from "@/adapters/local-runtime.ts";
import { AgentFactoryDaemonClient, BunUnixDaemonTransport } from "@/cli/client.ts";
import { CLI_HELP, CliUsageError, parseCliArguments } from "@/cli/parser.ts";
import { parseReleaseBuildMetadata } from "@/contracts/release-manifest.ts";
import { Doctor } from "@/operations/doctor.ts";
import { loadFactoryConfiguration, resolveXdgPaths } from "@/operations/runtime.ts";

export interface CliIo {
	out(text: string): void;
	error(text: string): void;
}

export interface CliDependencies {
	readonly client: Pick<AgentFactoryDaemonClient, "request">;
	readonly doctor: Pick<Doctor, "run">;
	readonly version: string;
	readonly io: CliIo;
}

function render(input: unknown): string {
	return `${JSON.stringify(input, null, 2)}\n`;
}

export async function runCli(
	argv: readonly string[],
	dependencies: CliDependencies,
): Promise<number> {
	try {
		const invocation = parseCliArguments(argv);
		switch (invocation.kind) {
			case "help":
				dependencies.io.out(CLI_HELP);
				return 0;
			case "version":
				dependencies.io.out(`agent-factory ${dependencies.version}\n`);
				return 0;
			case "doctor": {
				const report = await dependencies.doctor.run({ live: false });
				dependencies.io.out(render(report));
				return report.ok ? 0 : 1;
			}
			case "daemon":
				dependencies.io.out(render(await dependencies.client.request(invocation.request)));
				return 0;
		}
	} catch (error) {
		let message = "Agent Factory command failed";
		if (error instanceof CliUsageError) {
			message = `${error.message}\nTry 'agent-factory help'.`;
		} else if (error instanceof Error) {
			message = error.message;
		}
		dependencies.io.error(`${message}\n`);
		return 1;
	}
}

async function productionMain(): Promise<number> {
	const argv = Bun.argv.slice(2);
	const version = parseReleaseBuildMetadata(
		JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "release.json"), "utf8")) as unknown,
	).version;
	const io = {
		out: (text: string) => process.stdout.write(text),
		error: (text: string) => process.stderr.write(text),
	};
	if (
		argv[0] === undefined ||
		["help", "--help", "-h", "version", "--version", "-V"].includes(argv[0])
	) {
		return runCli(argv, {
			client: {
				async request() {
					throw new Error("local command attempted daemon access");
				},
			},
			doctor: {
				async run() {
					throw new Error("local command attempted doctor access");
				},
			},
			version,
			io,
		});
	}
	const environment = Bun.env as Readonly<Record<string, string | undefined>>;
	const paths = resolveXdgPaths(environment);
	const fileSystem = new LocalRuntimeFileSystemAdapter();
	const disk = new LocalDiskUsageAdapter();
	const system = new LocalDoctorSystemAdapter({
		environment,
		systemdUserDirectory: join(dirname(paths.configDirectory), "systemd", "user"),
		workingDirectory: paths.stateDirectory,
	});
	const doctor = new Doctor({
		paths,
		fileSystem,
		disk,
		system,
		loadConfiguration: () => loadFactoryConfiguration(paths, fileSystem),
	});
	const client = new AgentFactoryDaemonClient({
		socketPath: paths.socketPath,
		transport: new BunUnixDaemonTransport(),
		nextRequestId: () => crypto.randomUUID(),
	});
	return runCli(argv, {
		client,
		doctor,
		version,
		io,
	});
}

if (import.meta.main) {
	process.exitCode = await productionMain();
}
