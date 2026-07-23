import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

import type {
  ClockAdapter,
  FileSystemAdapter,
  GitHubHttpResponse,
  GitHubHttpTransport,
} from "../adapters/interfaces";
import type { ProjectProfile } from "../contracts/project-profile";
import type { GitHubProjectTokenProvider } from "./mutations";

export const GITHUB_APP_ID_ENVIRONMENT = "AGENT_FACTORY_GITHUB_APP_ID";
export const GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT = "AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE";

const DEFAULT_API_URL = "https://api.github.com";
const TOKEN_REFRESH_SKEW_MS = 60_000;
const INSTALLATION_TOKEN_PERMISSIONS = {
  administration: "read",
  checks: "read",
  issues: "write",
  metadata: "read",
  pull_requests: "read",
  statuses: "read",
} as const;

const accountSchema = z.strictObject({
  login: z.string(),
  id: z.number().int(),
  node_id: z.string(),
  avatar_url: z.url(),
  gravatar_id: z.string().nullable(),
  url: z.url(),
  html_url: z.url(),
  followers_url: z.url(),
  following_url: z.string(),
  gists_url: z.string(),
  starred_url: z.string(),
  subscriptions_url: z.url(),
  organizations_url: z.url(),
  repos_url: z.url(),
  events_url: z.string(),
  received_events_url: z.url(),
  type: z.string(),
  site_admin: z.boolean(),
});

const installationSchema = z.strictObject({
  id: z.number().int().positive(),
  account: accountSchema,
  repository_selection: z.enum(["all", "selected"]),
  access_tokens_url: z.url(),
  repositories_url: z.url(),
  html_url: z.url(),
  app_id: z.number().int().positive(),
  client_id: z.string().optional(),
  target_id: z.number().int().positive(),
  target_type: z.string(),
  permissions: z.record(z.string(), z.string()),
  events: z.array(z.string()),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  single_file_name: z.string().nullable(),
  has_multiple_single_files: z.boolean().optional(),
  single_file_paths: z.array(z.string()).optional(),
  suspended_by: accountSchema.nullable(),
  suspended_at: z.iso.datetime({ offset: true }).nullable(),
});

const installationTokenSchema = z.strictObject({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()),
  repository_selection: z.enum(["all", "selected"]),
});

export interface GitHubAppEnvironment {
  readonly appId: string;
  readonly privateKeyFile: string;
}

export interface GitHubAppTokenBrokerOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly profiles: readonly ProjectProfile[];
  readonly fileSystem: FileSystemAdapter;
  readonly clock: ClockAdapter;
  readonly transport: GitHubHttpTransport;
  readonly apiUrl?: string;
  readonly refreshSkewMs?: number;
}

interface CachedInstallationToken {
  readonly token: string;
  readonly expiresAt: number;
}

export class GitHubAppTokenBrokerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitHubAppTokenBrokerError";
  }
}

function responseJson(response: GitHubHttpResponse, description: string): unknown {
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new GitHubAppTokenBrokerError(`GitHub App ${description} response was invalid`);
  }
}

function base64Url(input: string | Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function parseClock(clock: ClockAdapter): Date {
  const now = clock.now();
  if (Number.isNaN(now.getTime())) {
    throw new GitHubAppTokenBrokerError("GitHub App token clock returned an invalid date");
  }
  return now;
}

export function parseGitHubAppEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubAppEnvironment {
  const appId = environment[GITHUB_APP_ID_ENVIRONMENT];
  const privateKeyFile = environment[GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT];
  if (appId === undefined || !/^[1-9]\d*$/u.test(appId)) {
    throw new GitHubAppTokenBrokerError(`${GITHUB_APP_ID_ENVIRONMENT} must be a positive integer`);
  }
  if (
    privateKeyFile === undefined ||
    privateKeyFile.length > 4_096 ||
    !privateKeyFile.startsWith("/") ||
    /[\r\n]/u.test(privateKeyFile) ||
    privateKeyFile.includes("PRIVATE KEY")
  ) {
    throw new GitHubAppTokenBrokerError(
      `${GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT} must be an absolute credential-file path`,
    );
  }
  return { appId, privateKeyFile };
}

export class GitHubAppTokenBroker implements GitHubProjectTokenProvider {
  readonly #environment: GitHubAppEnvironment;
  readonly #profiles: ReadonlyMap<string, ProjectProfile>;
  readonly #fileSystem: FileSystemAdapter;
  readonly #clock: ClockAdapter;
  readonly #transport: GitHubHttpTransport;
  readonly #apiUrl: string;
  readonly #refreshSkewMs: number;
  readonly #installations = new Map<string, number>();
  readonly #tokens = new Map<string, CachedInstallationToken>();

  public constructor(options: GitHubAppTokenBrokerOptions) {
    this.#environment = parseGitHubAppEnvironment(options.environment);
    this.#profiles = new Map(
      options.profiles.filter((profile) => profile.enabled).map((profile) => [profile.id, profile]),
    );
    this.#fileSystem = options.fileSystem;
    this.#clock = options.clock;
    this.#transport = options.transport;
    this.#apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/$/u, "");
    this.#refreshSkewMs = options.refreshSkewMs ?? TOKEN_REFRESH_SKEW_MS;
    if (!Number.isInteger(this.#refreshSkewMs) || this.#refreshSkewMs < 0) {
      throw new GitHubAppTokenBrokerError("GitHub App token refresh skew must be non-negative");
    }
  }

  public async tokenForProject(projectId: string): Promise<string> {
    const profile = this.#profiles.get(projectId);
    if (profile === undefined) {
      throw new GitHubAppTokenBrokerError(
        `GitHub App token requested for target '${projectId}' that is not explicitly enabled`,
      );
    }
    const now = parseClock(this.#clock).getTime();
    const cached = this.#tokens.get(projectId);
    if (cached !== undefined && cached.expiresAt - this.#refreshSkewMs > now) {
      return cached.token;
    }

    const appJwt = await this.#createAppJwt();
    const installationId =
      this.#installations.get(projectId) ?? (await this.#resolveInstallation(profile, appJwt));
    this.#installations.set(projectId, installationId);
    const token = await this.#mintInstallationToken(profile, installationId, appJwt);
    this.#tokens.set(projectId, token);
    return token.token;
  }

  async #createAppJwt(): Promise<string> {
    const metadata = await this.#fileSystem.stat(this.#environment.privateKeyFile);
    if (metadata.kind !== "file") {
      throw new GitHubAppTokenBrokerError(
        "GitHub App private-key credential is not a regular file",
      );
    }
    let privateKeyPem = "";
    try {
      privateKeyPem = await this.#fileSystem.readText(this.#environment.privateKeyFile);
      const now = Math.floor(parseClock(this.#clock).getTime() / 1_000);
      const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const encodedPayload = base64Url(
        JSON.stringify({
          iat: now - 60,
          exp: now + 540,
          iss: this.#environment.appId,
        }),
      );
      const unsigned = `${encodedHeader}.${encodedPayload}`;
      const key = createPrivateKey(privateKeyPem);
      const signature = sign("RSA-SHA256", Buffer.from(unsigned), key);
      return `${unsigned}.${base64Url(signature)}`;
    } catch {
      throw new GitHubAppTokenBrokerError("GitHub App private-key credential is invalid");
    } finally {
      privateKeyPem = "";
    }
  }

  async #resolveInstallation(profile: ProjectProfile, appJwt: string): Promise<number> {
    const response = await this.#request({
      method: "GET",
      path: `/repos/${profile.repository}/installation`,
      appJwt,
    });
    if (response.status !== 200) {
      throw new GitHubAppTokenBrokerError(
        `GitHub App installation resolution failed for target '${profile.id}' (${response.status})`,
      );
    }
    return installationSchema.parse(responseJson(response, "installation")).id;
  }

  async #mintInstallationToken(
    profile: ProjectProfile,
    installationId: number,
    appJwt: string,
  ): Promise<CachedInstallationToken> {
    const repositoryName = profile.repository.split("/")[1];
    if (repositoryName === undefined) {
      throw new GitHubAppTokenBrokerError(`target '${profile.id}' has an invalid repository`);
    }
    const response = await this.#request({
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      appJwt,
      body: JSON.stringify({
        repositories: [repositoryName],
        permissions: INSTALLATION_TOKEN_PERMISSIONS,
      }),
    });
    if (response.status !== 201) {
      throw new GitHubAppTokenBrokerError(
        `GitHub App token minting failed for target '${profile.id}' (${response.status})`,
      );
    }
    let parsed: z.infer<typeof installationTokenSchema>;
    try {
      parsed = installationTokenSchema.parse(responseJson(response, "token"));
    } catch {
      throw new GitHubAppTokenBrokerError("GitHub App token response failed validation");
    }
    if (
      Object.keys(parsed.permissions).length !==
        Object.keys(INSTALLATION_TOKEN_PERMISSIONS).length ||
      parsed.permissions.administration !== INSTALLATION_TOKEN_PERMISSIONS.administration ||
      parsed.permissions.checks !== INSTALLATION_TOKEN_PERMISSIONS.checks ||
      parsed.permissions.issues !== INSTALLATION_TOKEN_PERMISSIONS.issues ||
      parsed.permissions.metadata !== INSTALLATION_TOKEN_PERMISSIONS.metadata ||
      parsed.permissions.pull_requests !== INSTALLATION_TOKEN_PERMISSIONS.pull_requests ||
      parsed.permissions.statuses !== INSTALLATION_TOKEN_PERMISSIONS.statuses
    ) {
      throw new GitHubAppTokenBrokerError(
        "GitHub App token response exceeded the requested permission set",
      );
    }
    const expiresAt = Date.parse(parsed.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= parseClock(this.#clock).getTime()) {
      throw new GitHubAppTokenBrokerError("GitHub App returned an already-expired token");
    }
    return { token: parsed.token, expiresAt };
  }

  #request(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly appJwt: string;
    readonly body?: string;
  }): Promise<GitHubHttpResponse> {
    return this.#transport.request({
      method: input.method,
      url: `${this.#apiUrl}${input.path}`,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.appJwt}`,
        "content-type": "application/json",
        "user-agent": "agent-factory",
        "x-github-api-version": "2022-11-28",
      },
      ...(input.body === undefined ? {} : { body: input.body }),
    });
  }
}
