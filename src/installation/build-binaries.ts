#!/usr/bin/env bun

import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { BunCommandAdapter } from "@/adapters/bun-command.ts";
import { LocalReleaseFileSystemAdapter } from "@/adapters/releases.ts";
import { releaseBinaryBuildPlans } from "@/releases/binaries.ts";

function requireBuildSuccess(
	name: string,
	result: Awaited<ReturnType<BunCommandAdapter["execute"]>>,
): void {
	if (result.status !== "exited" || result.exitCode !== 0) {
		const detail = result.stderr.trim();
		throw new Error(
			`release binary '${name}' compilation failed${detail === "" ? "" : `: ${detail}`}`,
		);
	}
}

export async function buildBinariesMain(argv: readonly string[]): Promise<void> {
	const artifactRootInput = argv[0];
	if (artifactRootInput === undefined || argv.length !== 1) {
		throw new Error("usage: bun run build:binaries -- <artifact-root>");
	}
	const sourceRoot = resolve(import.meta.dir, "..", "..");
	const artifactRoot = resolve(artifactRootInput);
	if (artifactRoot === sourceRoot) {
		throw new Error("refusing to replace the source checkout's development wrappers");
	}
	const fileSystem = new LocalReleaseFileSystemAdapter();
	await fileSystem.ensureDirectory(join(artifactRoot, "bin"), 0o700);
	const commands = new BunCommandAdapter();
	for (const plan of releaseBinaryBuildPlans(artifactRoot)) {
		const result = await commands.execute({
			executable: process.execPath,
			argv: plan.argv,
			cwd: sourceRoot,
			env: {},
			stdin: "",
			stdout: "capture-json-lines",
			stderr: "capture",
		});
		requireBuildSuccess(plan.name, result);
		rmSync(plan.externalSourcemapPath, { force: true });
		process.stdout.write(`${plan.name}: ${plan.outfile}\n`);
	}
}

if (import.meta.main) {
	try {
		await buildBinariesMain(Bun.argv.slice(2));
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : "Agent Factory binary build failed"}\n`,
		);
		process.exitCode = 1;
	}
}
