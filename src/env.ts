import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import {
	type ClaudeRuntimeConfig,
	ClaudeRuntimeConfigSchema,
	type GlobalLimits,
	GlobalLimitsSchema,
} from "@/controller/config.ts";

/**
 * Single home for every configuration value the factory reads from the
 * environment (see `.env.example`); values are never hardcoded in source.
 * Modules that pass through or scan the raw environment record — worker
 * allowlists, secret redaction — take it as an explicit input instead.
 * Parsers take an explicit environment record so tests stay deterministic;
 * production entry points pass `Bun.env`.
 */
export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

export const CLAUDE_MODEL_ENVIRONMENT = "AGENT_FACTORY_CLAUDE_MODEL";
export const CLAUDE_EFFORT_ENVIRONMENT = "AGENT_FACTORY_CLAUDE_EFFORT";
export const LIMIT_ENVIRONMENT = "AGENT_FACTORY_LIMIT";
export const GITHUB_APP_ID_ENVIRONMENT = "AGENT_FACTORY_GITHUB_APP_ID";
export const GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT = "AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE";
export const SOURCE_REPOSITORY_ENVIRONMENT = "AGENT_FACTORY_SOURCE_REPOSITORY";

const nonNegativeIntegerText = z
	.string()
	.regex(/^(?:0|[1-9]\d*)$/u)
	.transform(Number);

const absolutePathText = z
	.string()
	.min(1)
	.refine((value) => isAbsolute(value) && !/[\0\r\n]/u.test(value));

const githubAppIdText = z.string().regex(/^[1-9]\d*$/u);

const credentialFileText = z
	.string()
	.max(4_096)
	.refine(
		(value) => value.startsWith("/") && !/[\r\n]/u.test(value) && !value.includes("PRIVATE KEY"),
	);

export function parseGlobalLimitsFromEnvironment(environment: EnvironmentRecord): GlobalLimits {
	const parsed = nonNegativeIntegerText.safeParse(environment[LIMIT_ENVIRONMENT]);
	if (!parsed.success) {
		throw new Error(
			`${LIMIT_ENVIRONMENT} must be set to a non-negative integer; see .env.example`,
			{
				cause: parsed.error,
			},
		);
	}
	const limit = parsed.data;
	return GlobalLimitsSchema.parse({
		implementation: limit,
		feedback: limit,
		readyToMerge: limit,
	});
}

export function parseClaudeRuntimeFromEnvironment(
	environment: EnvironmentRecord,
): ClaudeRuntimeConfig {
	const model = environment[CLAUDE_MODEL_ENVIRONMENT];
	const effort = environment[CLAUDE_EFFORT_ENVIRONMENT];
	if (model === undefined || effort === undefined) {
		throw new Error(
			`${CLAUDE_MODEL_ENVIRONMENT} and ${CLAUDE_EFFORT_ENVIRONMENT} must be set; see .env.example`,
		);
	}
	const parsed = ClaudeRuntimeConfigSchema.safeParse({ model, effort });
	if (!parsed.success) {
		throw new Error(
			`${CLAUDE_MODEL_ENVIRONMENT} and ${CLAUDE_EFFORT_ENVIRONMENT} must select a safe model and effort (low, medium, high, or max)`,
			{ cause: parsed.error },
		);
	}
	return parsed.data;
}

export interface GitHubAppEnvironment {
	readonly appId: string;
	readonly privateKeyFile: string;
}

export function parseGitHubAppEnvironment(environment: EnvironmentRecord): GitHubAppEnvironment {
	const appId = githubAppIdText.safeParse(environment[GITHUB_APP_ID_ENVIRONMENT]);
	if (!appId.success) {
		throw new Error(`${GITHUB_APP_ID_ENVIRONMENT} must be a positive integer`, {
			cause: appId.error,
		});
	}
	const privateKeyFile = credentialFileText.safeParse(
		environment[GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT],
	);
	if (!privateKeyFile.success) {
		throw new Error(
			`${GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT} must be an absolute credential-file path`,
			{ cause: privateKeyFile.error },
		);
	}
	return { appId: appId.data, privateKeyFile: privateKeyFile.data };
}

export function resolveSourceRepository(environment: EnvironmentRecord, fallback: string): string {
	const configured = environment[SOURCE_REPOSITORY_ENVIRONMENT];
	if (configured === undefined) {
		return fallback;
	}
	const parsed = absolutePathText.safeParse(configured);
	if (!parsed.success) {
		throw new Error(
			`${SOURCE_REPOSITORY_ENVIRONMENT} must be an absolute path without control characters`,
			{ cause: parsed.error },
		);
	}
	return parsed.data;
}

export interface XdgBaseDirectories {
	readonly configBase: string;
	readonly stateBase: string;
	readonly dataBase: string;
}

function xdgBase(environment: EnvironmentRecord, variable: string, fallback: () => string): string {
	const configured = environment[variable];
	const value = configured === undefined || configured === "" ? fallback() : configured;
	const parsed = absolutePathText.safeParse(value);
	if (!parsed.success) {
		throw new Error(`${variable} must resolve to an absolute path without controls`, {
			cause: parsed.error,
		});
	}
	return resolve(parsed.data);
}

export function parseXdgBaseDirectories(environment: EnvironmentRecord): XdgBaseDirectories {
	const homeFallback = (...segments: readonly string[]): string => {
		const home = absolutePathText.safeParse(environment.HOME);
		if (!home.success) {
			throw new Error("HOME must be an absolute path for XDG fallback resolution", {
				cause: home.error,
			});
		}
		return join(resolve(home.data), ...segments);
	};
	return {
		configBase: xdgBase(environment, "XDG_CONFIG_HOME", () => homeFallback(".config")),
		stateBase: xdgBase(environment, "XDG_STATE_HOME", () => homeFallback(".local", "state")),
		dataBase: xdgBase(environment, "XDG_DATA_HOME", () => homeFallback(".local", "share")),
	};
}
