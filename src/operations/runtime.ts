import { isAbsolute, join, resolve } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import type { FileSystemAdapter, RuntimeFileSystemAdapter } from "../adapters/interfaces";
import {
	loadProjectProfileFile,
	type ProjectProfile,
	ProjectProfilesSchema,
} from "../contracts/project-profile";

const relativeProfilePath = z
	.string()
	.min(1)
	.max(255)
	.regex(
		/^profiles\/[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?\.ya?ml$/u,
		"profile paths must be relative files below profiles/",
	)
	.refine((value) => !value.split("/").includes(".."), "profile paths must not traverse");

export const FactoryRuntimeConfigSchema = z.strictObject({
	schemaVersion: z.literal(1),
	profiles: z
		.array(relativeProfilePath)
		.min(1)
		.refine((paths) => new Set(paths).size === paths.length, "profile paths must be unique"),
	ntfy: z.strictObject({
		baseUrl: z.url().refine((value) => value.startsWith("https://"), "ntfy baseUrl must use HTTPS"),
		topic: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9_-]+$/u),
	}),
	logging: z
		.strictObject({
			rotateBytes: z
				.number()
				.int()
				.min(64 * 1_024)
				.max(1024 * 1024 * 1024)
				.default(10 * 1024 * 1024),
			retainedFiles: z.number().int().min(1).max(20).default(5),
		})
		.default({ rotateBytes: 10 * 1024 * 1024, retainedFiles: 5 }),
});

export type FactoryRuntimeConfig = z.infer<typeof FactoryRuntimeConfigSchema>;

export interface XdgPaths {
	readonly configDirectory: string;
	readonly configFile: string;
	readonly profilesDirectory: string;
	readonly stateDirectory: string;
	readonly logDirectory: string;
	readonly socketPath: string;
	readonly dataDirectory: string;
	readonly mirrorDirectory: string;
	readonly worktreeDirectory: string;
	readonly releaseDirectory: string;
	readonly releaseBackupDirectory: string;
	readonly releaseBuildDirectory: string;
}

export interface LoadedFactoryConfiguration {
	readonly runtime: FactoryRuntimeConfig;
	readonly profiles: readonly ProjectProfile[];
	readonly profilePaths: readonly string[];
}

export const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const MAX_CONFIG_BYTES = 1024 * 1024;

function environmentBase(
	environment: Readonly<Record<string, string | undefined>>,
	variable: string,
	fallback: () => string,
): string {
	const configured = environment[variable];
	const value = configured === undefined || configured === "" ? fallback() : configured;
	if (!isAbsolute(value) || /[\0\r\n]/u.test(value)) {
		throw new Error(`${variable} must resolve to an absolute path without controls`);
	}
	return resolve(value);
}

export function resolveXdgPaths(
	environment: Readonly<Record<string, string | undefined>>,
): XdgPaths {
	const homeFallback = (...segments: readonly string[]): string => {
		const home = environment.HOME;
		if (home === undefined || home === "" || !isAbsolute(home) || /[\0\r\n]/u.test(home)) {
			throw new Error("HOME must be an absolute path for XDG fallback resolution");
		}
		return join(resolve(home), ...segments);
	};
	const configBase = environmentBase(environment, "XDG_CONFIG_HOME", () => homeFallback(".config"));
	const stateBase = environmentBase(environment, "XDG_STATE_HOME", () =>
		homeFallback(".local", "state"),
	);
	const dataBase = environmentBase(environment, "XDG_DATA_HOME", () =>
		homeFallback(".local", "share"),
	);
	const configDirectory = join(configBase, "agent-factory");
	const stateDirectory = join(stateBase, "agent-factory");
	const dataDirectory = join(dataBase, "agent-factory");
	const socketPath = join(stateDirectory, "agent-factory.sock");
	if (new TextEncoder().encode(socketPath).byteLength > MAX_UNIX_SOCKET_PATH_BYTES) {
		throw new Error(
			`Agent Factory Unix socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} bytes; shorten XDG_STATE_HOME`,
		);
	}
	return {
		configDirectory,
		configFile: join(configDirectory, "config.yaml"),
		profilesDirectory: join(configDirectory, "profiles"),
		stateDirectory,
		logDirectory: join(stateDirectory, "logs"),
		socketPath,
		dataDirectory,
		mirrorDirectory: join(dataDirectory, "mirrors"),
		worktreeDirectory: join(dataDirectory, "worktrees"),
		releaseDirectory: join(dataDirectory, "releases"),
		releaseBackupDirectory: join(stateDirectory, "release-backups"),
		releaseBuildDirectory: join(stateDirectory, "release-builds"),
	};
}

function assertPrivate(
	metadata: { readonly kind: string; readonly mode: number },
	kind: string,
): void {
	if (
		metadata.kind !== kind ||
		(metadata.mode & 0o777) !== (kind === "directory" ? 0o700 : 0o600)
	) {
		throw new Error(
			`${kind === "directory" ? "directory" : "configuration file"} must be ${kind === "directory" ? "a directory with mode 0700" : "a regular file with mode 0600"}`,
		);
	}
}

export async function prepareXdgDirectories(
	paths: XdgPaths,
	fileSystem: RuntimeFileSystemAdapter,
): Promise<void> {
	for (const directory of [
		paths.configDirectory,
		paths.profilesDirectory,
		paths.stateDirectory,
		paths.logDirectory,
		paths.dataDirectory,
		paths.mirrorDirectory,
		paths.worktreeDirectory,
		paths.releaseDirectory,
		paths.releaseBackupDirectory,
		paths.releaseBuildDirectory,
	]) {
		await fileSystem.ensureDirectory(directory, 0o700);
		assertPrivate(await fileSystem.stat(directory), "directory");
	}
}

function parseRuntimeConfig(source: string): FactoryRuntimeConfig {
	if (new TextEncoder().encode(source).byteLength > MAX_CONFIG_BYTES) {
		throw new Error("Agent Factory configuration exceeds the 1 MiB size limit");
	}
	let decoded: unknown;
	try {
		decoded = parse(source, { maxAliasCount: 0, uniqueKeys: true });
	} catch (error) {
		throw new Error("Agent Factory configuration is not valid YAML", { cause: error });
	}
	return FactoryRuntimeConfigSchema.parse(decoded);
}

export async function loadFactoryConfiguration(
	paths: XdgPaths,
	fileSystem: FileSystemAdapter,
): Promise<LoadedFactoryConfiguration> {
	assertPrivate(await fileSystem.stat(paths.configFile), "file");
	const runtime = parseRuntimeConfig(await fileSystem.readText(paths.configFile));
	const profilePaths = runtime.profiles.map((path) => join(paths.configDirectory, path));
	const profiles: ProjectProfile[] = [];
	for (const profilePath of profilePaths) {
		profiles.push(await loadProjectProfileFile(profilePath, fileSystem));
	}
	return {
		runtime,
		profiles: ProjectProfilesSchema.parse(profiles),
		profilePaths,
	};
}
