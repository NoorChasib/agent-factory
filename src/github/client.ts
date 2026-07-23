import type { z } from "zod";

import type {
	DelayAdapter,
	GitHubHttpRequest,
	GitHubHttpResponse,
	GitHubHttpTransport,
} from "../adapters/interfaces";

const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_MAX_READ_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5_000;

export type GitHubFailureClassification =
	| "authentication"
	| "authorization"
	| "invalid-response"
	| "not-found"
	| "rate-limit"
	| "server"
	| "timeout"
	| "transport"
	| "validation";

export interface GitHubCircuitFailureSignal {
	readonly provider: "github";
	readonly projectId: string;
	readonly classification: GitHubFailureClassification;
	readonly reasonCode: `github-${GitHubFailureClassification}`;
	readonly retryable: boolean;
	readonly attempts: number;
	readonly status: number | null;
}

export class GitHubReadError extends Error {
	public readonly signal: GitHubCircuitFailureSignal;

	public constructor(signal: GitHubCircuitFailureSignal) {
		super(
			`GitHub read failed for project '${signal.projectId}' after ${signal.attempts} attempt(s): ${signal.classification}`,
		);
		this.name = "GitHubReadError";
		this.signal = signal;
	}
}

export interface GitHubReadResult<T> {
	readonly value: T;
	readonly changed: boolean;
	readonly etag: string | null;
	readonly status: 200 | 304;
}

export interface GitHubApiClientOptions {
	readonly transport: GitHubHttpTransport;
	readonly delay: DelayAdapter;
	readonly apiUrl?: string;
	readonly maxReadAttempts?: number;
	readonly baseBackoffMs?: number;
	readonly maxBackoffMs?: number;
}

interface CacheEntry {
	readonly etag: string | null;
	readonly value: unknown;
}

interface ReadInput<T> {
	readonly projectId: string;
	readonly cacheKey: string;
	readonly token: string;
	readonly request: GitHubHttpRequest;
	readonly schema: z.ZodType<T>;
	readonly conditional: boolean;
}

function normalizeHeaders(
	headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
	);
}

function responseHeader(response: GitHubHttpResponse, name: string): string | undefined {
	return normalizeHeaders(response.headers)[name.toLowerCase()];
}

function retryAfterMilliseconds(response: GitHubHttpResponse): number | null {
	const raw = responseHeader(response, "retry-after");
	if (raw === undefined || !/^\d+$/u.test(raw)) {
		return null;
	}
	return Number(raw) * 1_000;
}

function classifyStatus(response: GitHubHttpResponse): {
	readonly classification: GitHubFailureClassification;
	readonly retryable: boolean;
} {
	if (
		response.status === 429 ||
		(response.status === 403 &&
			(responseHeader(response, "x-ratelimit-remaining") === "0" ||
				responseHeader(response, "retry-after") !== undefined))
	) {
		return { classification: "rate-limit", retryable: true };
	}
	if (response.status === 401) {
		return { classification: "authentication", retryable: false };
	}
	if (response.status === 403) {
		return { classification: "authorization", retryable: false };
	}
	if (response.status === 404) {
		return { classification: "not-found", retryable: false };
	}
	if (response.status === 408) {
		return { classification: "timeout", retryable: true };
	}
	if (response.status >= 500) {
		return { classification: "server", retryable: true };
	}
	return { classification: "invalid-response", retryable: false };
}

function classifyThrown(error: unknown): {
	readonly classification: GitHubFailureClassification;
	readonly retryable: boolean;
} {
	if (
		error instanceof Error &&
		(error.name === "AbortError" || /(?:timed?\s*out|timeout)/iu.test(error.message))
	) {
		return { classification: "timeout", retryable: true };
	}
	return { classification: "transport", retryable: true };
}

function apiUrl(base: string, path: string): string {
	if (!path.startsWith("/") || path.startsWith("//")) {
		throw new Error("GitHub API path must be absolute within the configured API origin");
	}
	return `${base}${path}`;
}

export function githubApiHeaders(token: string): Readonly<Record<string, string>> {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": "agent-factory",
		"x-github-api-version": "2022-11-28",
	};
}

function bearerHeaders(token: string): Readonly<Record<string, string>> {
	if (token.length === 0) {
		throw new Error("GitHub token must not be empty");
	}
	return githubApiHeaders(token);
}

export class FetchGitHubTransport implements GitHubHttpTransport {
	readonly #fetch: typeof fetch;

	public constructor(fetchImplementation: typeof fetch = fetch) {
		this.#fetch = fetchImplementation;
	}

	public async request(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
		const response = await this.#fetch(request.url, {
			method: request.method,
			headers: request.headers,
			...(request.body === undefined ? {} : { body: request.body }),
		});
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			body: await response.text(),
		};
	}
}

export class BunDelayAdapter implements DelayAdapter {
	public async wait(milliseconds: number): Promise<void> {
		await Bun.sleep(milliseconds);
	}
}

export class GitHubApiClient {
	readonly #transport: GitHubHttpTransport;
	readonly #delay: DelayAdapter;
	readonly #apiUrl: string;
	readonly #maxReadAttempts: number;
	readonly #baseBackoffMs: number;
	readonly #maxBackoffMs: number;
	readonly #cache = new Map<string, CacheEntry>();

	public constructor(options: GitHubApiClientOptions) {
		this.#transport = options.transport;
		this.#delay = options.delay;
		this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/u, "");
		this.#maxReadAttempts = options.maxReadAttempts ?? DEFAULT_MAX_READ_ATTEMPTS;
		this.#baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
		this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

		if (!Number.isInteger(this.#maxReadAttempts) || this.#maxReadAttempts < 1) {
			throw new Error("GitHub maxReadAttempts must be a positive integer");
		}
		if (
			!Number.isInteger(this.#baseBackoffMs) ||
			this.#baseBackoffMs < 0 ||
			!Number.isInteger(this.#maxBackoffMs) ||
			this.#maxBackoffMs < this.#baseBackoffMs
		) {
			throw new Error("GitHub read backoff bounds are invalid");
		}
	}

	public readRest<T>(input: {
		readonly projectId: string;
		readonly cacheKey: string;
		readonly token: string;
		readonly path: string;
		readonly schema: z.ZodType<T>;
		readonly conditional?: boolean;
	}): Promise<GitHubReadResult<T>> {
		return this.#read({
			projectId: input.projectId,
			cacheKey: input.cacheKey,
			token: input.token,
			schema: input.schema,
			conditional: input.conditional ?? true,
			request: {
				method: "GET",
				url: apiUrl(this.#apiUrl, input.path),
				headers: bearerHeaders(input.token),
			},
		});
	}

	public readGraphql<T>(input: {
		readonly projectId: string;
		readonly cacheKey: string;
		readonly token: string;
		readonly query: string;
		readonly variables: Readonly<Record<string, string | number | boolean | null>>;
		readonly schema: z.ZodType<T>;
		readonly conditional?: boolean;
	}): Promise<GitHubReadResult<T>> {
		if (!/^\s*query\b/u.test(input.query) || /\b(?:mutation|subscription)\b/u.test(input.query)) {
			throw new Error("GitHub GraphQL reads require exactly one query operation");
		}
		return this.#read({
			projectId: input.projectId,
			cacheKey: input.cacheKey,
			token: input.token,
			schema: input.schema,
			conditional: input.conditional ?? true,
			request: {
				method: "POST",
				url: apiUrl(this.#apiUrl, "/graphql"),
				headers: bearerHeaders(input.token),
				body: JSON.stringify({ query: input.query, variables: input.variables }),
			},
		});
	}

	async #read<T>(input: ReadInput<T>): Promise<GitHubReadResult<T>> {
		const cache = input.conditional ? this.#cache.get(input.cacheKey) : undefined;
		const headers =
			cache?.etag === null || cache?.etag === undefined
				? input.request.headers
				: { ...input.request.headers, "if-none-match": cache.etag };
		const request = { ...input.request, headers };

		for (let attempt = 1; attempt <= this.#maxReadAttempts; attempt += 1) {
			let response: GitHubHttpResponse;
			try {
				response = await this.#transport.request(request);
			} catch (error) {
				const failure = classifyThrown(error);
				if (failure.retryable && attempt < this.#maxReadAttempts) {
					await this.#delay.wait(this.#backoff(attempt, null));
					continue;
				}
				throw new GitHubReadError({
					provider: "github",
					projectId: input.projectId,
					classification: failure.classification,
					reasonCode: `github-${failure.classification}`,
					retryable: failure.retryable,
					attempts: attempt,
					status: null,
				});
			}

			if (response.status === 304) {
				if (cache === undefined) {
					throw new GitHubReadError({
						provider: "github",
						projectId: input.projectId,
						classification: "invalid-response",
						reasonCode: "github-invalid-response",
						retryable: false,
						attempts: attempt,
						status: response.status,
					});
				}
				return {
					value: input.schema.parse(structuredClone(cache.value)),
					changed: false,
					etag: cache.etag,
					status: 304,
				};
			}

			if (response.status === 200) {
				let json: unknown;
				try {
					json = JSON.parse(response.body) as unknown;
				} catch {
					throw new GitHubReadError({
						provider: "github",
						projectId: input.projectId,
						classification: "invalid-response",
						reasonCode: "github-invalid-response",
						retryable: false,
						attempts: attempt,
						status: response.status,
					});
				}
				let value: T;
				try {
					value = input.schema.parse(json);
				} catch {
					throw new GitHubReadError({
						provider: "github",
						projectId: input.projectId,
						classification: "validation",
						reasonCode: "github-validation",
						retryable: false,
						attempts: attempt,
						status: response.status,
					});
				}
				const etag = responseHeader(response, "etag") ?? null;
				this.#cache.set(input.cacheKey, { etag, value: structuredClone(value) });
				return { value, changed: true, etag, status: 200 };
			}

			const failure = classifyStatus(response);
			if (failure.retryable && attempt < this.#maxReadAttempts) {
				await this.#delay.wait(this.#backoff(attempt, retryAfterMilliseconds(response)));
				continue;
			}
			throw new GitHubReadError({
				provider: "github",
				projectId: input.projectId,
				classification: failure.classification,
				reasonCode: `github-${failure.classification}`,
				retryable: failure.retryable,
				attempts: attempt,
				status: response.status,
			});
		}

		throw new Error("GitHub read retry loop exhausted without a result");
	}

	#backoff(attempt: number, retryAfter: number | null): number {
		const exponential = Math.min(
			this.#maxBackoffMs,
			this.#baseBackoffMs * 2 ** Math.max(0, attempt - 1),
		);
		return Math.min(this.#maxBackoffMs, retryAfter ?? exponential);
	}
}
