import { basename, extname, join } from "node:path";

import { normalizedAbsolutePath } from "@/path-guard.ts";

const RELEASE_BINARY_BUILD_FLAGS = [
	"build",
	"--compile",
	"--minify",
	"--sourcemap",
	"--bytecode",
	"--no-compile-autoload-dotenv",
	"--no-compile-autoload-bunfig",
] as const;

const RELEASE_BINARIES = [
	{
		name: "agent-factory",
		entrypoint: "src/cli/main.ts",
	},
	{
		name: "agent-factory-daemon",
		entrypoint: "src/daemon/main.ts",
	},
] as const;

export interface ReleaseBinaryBuildPlan {
	readonly name: (typeof RELEASE_BINARIES)[number]["name"];
	readonly outfile: string;
	readonly externalSourcemapPath: string;
	readonly argv: readonly string[];
}

export function releaseBinaryBuildPlans(
	artifactRootInput: string,
): readonly ReleaseBinaryBuildPlan[] {
	const artifactRoot = normalizedAbsolutePath(artifactRootInput, "release artifact root");
	return RELEASE_BINARIES.map(({ name, entrypoint }) => {
		const outfile = join(artifactRoot, "bin", name);
		const externalSourcemapPath = join(
			artifactRoot,
			"bin",
			`${basename(entrypoint, extname(entrypoint))}.js.map`,
		);
		return {
			name,
			outfile,
			externalSourcemapPath,
			argv: [...RELEASE_BINARY_BUILD_FLAGS, entrypoint, "--outfile", outfile],
		};
	});
}
