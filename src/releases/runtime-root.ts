import { basename, dirname, resolve } from "node:path";

export function resolveFactoryRuntimeRoot(input: {
	readonly moduleDirectory: string;
	readonly executablePath: string;
	readonly compiledExecutableName: "agent-factory" | "agent-factory-daemon";
}): string {
	const executablePath = resolve(input.executablePath);
	const executableDirectory = dirname(executablePath);
	if (
		basename(executablePath) === input.compiledExecutableName &&
		basename(executableDirectory) === "bin"
	) {
		return resolve(executableDirectory, "..");
	}
	return resolve(input.moduleDirectory, "..", "..");
}
