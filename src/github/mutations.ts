import { z } from "zod";

import type { GitHubHttpResponse, GitHubHttpTransport } from "../adapters/interfaces";
import type { ProjectProfile } from "../contracts/project-profile";
import type { MutationRecord, MutationState, NewMutation } from "../ledger";
import { DEFAULT_REDACTION_BOUNDARY, type RedactionBoundary } from "../redaction";
import type { GitHubApiClient, GitHubFailureClassification } from "./client";

const projectId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const labelName = z.string().min(1).max(50);
const labelColor = z.string().regex(/^[0-9a-f]{6}$/u);
const commentBody = z.string().min(1).max(65_536);
const subjectIdentity = {
  projectId,
  subjectType: z.enum(["issue", "pull-request"]),
  subjectNumber: z.number().int().positive(),
} as const;
const subjectMutation = {
  ...subjectIdentity,
  label: labelName,
} as const;

export const GitHubAllowedMutationSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("add-label"),
      ...subjectMutation,
    }),
    z.strictObject({
      kind: z.literal("remove-label"),
      ...subjectMutation,
    }),
    z.strictObject({
      kind: z.literal("create-label"),
      projectId,
      name: labelName,
      color: labelColor,
      description: z.string().max(100),
    }),
    z.strictObject({
      kind: z.literal("update-label"),
      projectId,
      currentName: labelName,
      name: labelName,
      color: labelColor,
      description: z.string().max(100),
    }),
    z.strictObject({
      kind: z.literal("create-comment"),
      ...subjectIdentity,
      body: commentBody,
    }),
    z.strictObject({
      kind: z.literal("update-comment"),
      ...subjectIdentity,
      commentId: z.number().int().positive(),
      body: commentBody,
    }),
  ])
  .superRefine((mutation, context) => {
    if (mutation.kind === "update-label" && mutation.currentName !== mutation.name) {
      context.addIssue({
        code: "custom",
        message: "label renaming is not allowlisted",
      });
    }
  });

export type GitHubAllowedMutation = z.infer<typeof GitHubAllowedMutationSchema>;

export const FORBIDDEN_GITHUB_MUTATION_KINDS = [
  "merge",
  "push",
  "force-push",
  "rebase",
  "amend",
  "dismiss-review",
  "bypass-branch-protection",
] as const;

export class ForbiddenGitHubMutationError extends Error {
  public constructor() {
    super("GitHub mutation is not in the Agent Factory label/comment-only allowlist");
    this.name = "ForbiddenGitHubMutationError";
  }
}

export function assertAllowedGitHubMutation(input: unknown): GitHubAllowedMutation {
  const parsed = GitHubAllowedMutationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ForbiddenGitHubMutationError();
  }
  return parsed.data;
}

export function sanitizeCommentMutation(
  mutation: GitHubAllowedMutation,
  redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
): GitHubAllowedMutation {
  if (mutation.kind !== "create-comment" && mutation.kind !== "update-comment") {
    return mutation;
  }
  return GitHubAllowedMutationSchema.parse({
    ...mutation,
    body: redaction.sanitizeText(mutation.body),
  });
}

export interface GitHubProjectTokenProvider {
  tokenForProject(projectId: string): Promise<string>;
}

export interface RepositoryLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

const repositoryLabelResponse = z.strictObject({
  id: z.number().int().nonnegative(),
  node_id: z.string(),
  url: z.url(),
  name: labelName,
  color: labelColor,
  default: z.boolean(),
  description: z.string().nullable(),
});

const repositoryLabelsResponse = z.array(repositoryLabelResponse);
const repositoryCommentResponse = z
  .looseObject({
    id: z.number().int().positive(),
    body: z.string().nullable(),
    issue_url: z.url(),
  })
  .transform((comment) => ({
    id: comment.id,
    body: comment.body,
    issueUrl: comment.issue_url,
  }));
const repositoryCommentsResponse = z.array(repositoryCommentResponse);

function apiHeaders(token: string): Readonly<Record<string, string>> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "agent-factory",
    "x-github-api-version": "2022-11-28",
  };
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

function classificationForWriteStatus(status: number): GitHubFailureClassification {
  if (status === 401) {
    return "authentication";
  }
  if (status === 403) {
    return "authorization";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status === 408) {
    return "timeout";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status >= 500) {
    return "server";
  }
  return "invalid-response";
}

export class GitHubMutationAmbiguousError extends Error {
  public readonly classification: "server" | "timeout" | "transport";

  public constructor(classification: "server" | "timeout" | "transport") {
    super(`GitHub mutation outcome is ambiguous: ${classification}`);
    this.name = "GitHubMutationAmbiguousError";
    this.classification = classification;
  }
}

export class GitHubMutationRejectedError extends Error {
  public readonly classification: GitHubFailureClassification;
  public readonly status: number;

  public constructor(classification: GitHubFailureClassification, status: number) {
    super(`GitHub rejected an allowlisted label/comment mutation: ${classification} (${status})`);
    this.name = "GitHubMutationRejectedError";
    this.classification = classification;
    this.status = status;
  }
}

export interface GitHubLabelGateway {
  apply(input: unknown): Promise<void>;
  verify(input: GitHubAllowedMutation): Promise<boolean>;
  readSubjectLabels(
    projectId: string,
    subjectType: "issue" | "pull-request",
    subjectNumber: number,
  ): Promise<readonly string[]>;
  listRepositoryLabels(
    projectId: string,
    conditional?: boolean,
  ): Promise<readonly RepositoryLabel[]>;
}

export interface GuardedGitHubLabelApiOptions {
  readonly profiles: readonly ProjectProfile[];
  readonly client: GitHubApiClient;
  readonly transport: GitHubHttpTransport;
  readonly tokens: GitHubProjectTokenProvider;
  readonly apiUrl?: string;
  readonly redaction?: RedactionBoundary;
}

export class GuardedGitHubLabelApi implements GitHubLabelGateway {
  readonly #profiles: ReadonlyMap<string, ProjectProfile>;
  readonly #client: GitHubApiClient;
  readonly #transport: GitHubHttpTransport;
  readonly #tokens: GitHubProjectTokenProvider;
  readonly #apiUrl: string;
  readonly #redaction: RedactionBoundary;

  public constructor(options: GuardedGitHubLabelApiOptions) {
    this.#profiles = new Map(options.profiles.map((profile) => [profile.id, profile]));
    this.#client = options.client;
    this.#transport = options.transport;
    this.#tokens = options.tokens;
    this.#apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/u, "");
    this.#redaction = options.redaction ?? DEFAULT_REDACTION_BOUNDARY;
  }

  public async apply(input: unknown): Promise<void> {
    const mutation = sanitizeCommentMutation(assertAllowedGitHubMutation(input), this.#redaction);
    const profile = this.#profile(mutation.projectId);
    const token = await this.#tokens.tokenForProject(profile.id);
    const [owner, repository] = profile.repository.split("/");
    if (owner === undefined || repository === undefined) {
      throw new Error(`invalid repository '${profile.repository}'`);
    }
    const repositoryPath = `/repos/${encodePath(owner)}/${encodePath(repository)}`;
    if (mutation.kind === "update-comment") {
      const existing = await this.#readComment(mutation.projectId, mutation.commentId);
      if (!new URL(existing.issueUrl).pathname.endsWith(`/issues/${mutation.subjectNumber}`)) {
        throw new ForbiddenGitHubMutationError();
      }
    }
    let request:
      | {
          readonly method: "POST" | "PATCH";
          readonly path: string;
          readonly body: string;
        }
      | {
          readonly method: "DELETE";
          readonly path: string;
        };
    switch (mutation.kind) {
      case "add-label":
        request = {
          method: "POST",
          path: `${repositoryPath}/issues/${mutation.subjectNumber}/labels`,
          body: JSON.stringify({ labels: [mutation.label] }),
        };
        break;
      case "create-comment":
        request = {
          method: "POST",
          path: `${repositoryPath}/issues/${mutation.subjectNumber}/comments`,
          body: JSON.stringify({ body: mutation.body }),
        };
        break;
      case "create-label":
        request = {
          method: "POST",
          path: `${repositoryPath}/labels`,
          body: JSON.stringify({
            name: mutation.name,
            color: mutation.color,
            description: mutation.description,
          }),
        };
        break;
      case "remove-label":
        request = {
          method: "DELETE",
          path: `${repositoryPath}/issues/${mutation.subjectNumber}/labels/${encodePath(mutation.label)}`,
        };
        break;
      case "update-comment":
        request = {
          method: "PATCH",
          path: `${repositoryPath}/issues/comments/${mutation.commentId}`,
          body: JSON.stringify({ body: mutation.body }),
        };
        break;
      case "update-label":
        request = {
          method: "PATCH",
          path: `${repositoryPath}/labels/${encodePath(mutation.currentName)}`,
          body: JSON.stringify({
            new_name: mutation.name,
            color: mutation.color,
            description: mutation.description,
          }),
        };
        break;
    }

    let response: GitHubHttpResponse;
    try {
      response = await this.#transport.request({
        method: request.method,
        url: `${this.#apiUrl}${request.path}`,
        headers: apiHeaders(token),
        ...("body" in request && request.body !== undefined ? { body: request.body } : {}),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || /(?:timed?\s*out|timeout)/iu.test(error.message))
      ) {
        throw new GitHubMutationAmbiguousError("timeout");
      }
      throw new GitHubMutationAmbiguousError("transport");
    }
    if (response.status >= 200 && response.status < 300) {
      return;
    }
    const classification = classificationForWriteStatus(response.status);
    if (classification === "server" || classification === "timeout") {
      throw new GitHubMutationAmbiguousError(classification);
    }
    throw new GitHubMutationRejectedError(classification, response.status);
  }

  public async verify(input: GitHubAllowedMutation): Promise<boolean> {
    const mutation = sanitizeCommentMutation(input, this.#redaction);
    switch (mutation.kind) {
      case "add-label":
      case "remove-label": {
        const labels = await this.readSubjectLabels(
          mutation.projectId,
          mutation.subjectType,
          mutation.subjectNumber,
        );
        const present = labels.includes(mutation.label);
        return mutation.kind === "add-label" ? present : !present;
      }
      case "create-comment":
        return (await this.#readSubjectComments(mutation.projectId, mutation.subjectNumber)).some(
          (comment) => comment.body === mutation.body,
        );
      case "create-label":
      case "update-label": {
        const labels = await this.listRepositoryLabels(mutation.projectId, false);
        return labels.some(
          (label) =>
            label.name === mutation.name &&
            label.color === mutation.color &&
            label.description === mutation.description,
        );
      }
      case "update-comment": {
        const comment = await this.#readComment(mutation.projectId, mutation.commentId);
        return (
          new URL(comment.issueUrl).pathname.endsWith(`/issues/${mutation.subjectNumber}`) &&
          comment.body === mutation.body
        );
      }
    }
  }

  public async readSubjectLabels(
    projectIdValue: string,
    _subjectType: "issue" | "pull-request",
    subjectNumber: number,
  ): Promise<readonly string[]> {
    const profile = this.#profile(projectIdValue);
    const token = await this.#tokens.tokenForProject(projectIdValue);
    const result = await this.#client.readRest({
      projectId: projectIdValue,
      cacheKey: `${projectIdValue}:subject-labels:${subjectNumber}`,
      token,
      path: `/repos/${profile.repository}/issues/${subjectNumber}/labels?per_page=100`,
      schema: repositoryLabelsResponse,
      conditional: false,
    });
    return result.value.map((label) => label.name).sort();
  }

  public async listRepositoryLabels(
    projectIdValue: string,
    conditional = true,
  ): Promise<readonly RepositoryLabel[]> {
    const profile = this.#profile(projectIdValue);
    const token = await this.#tokens.tokenForProject(projectIdValue);
    const all: z.infer<typeof repositoryLabelsResponse> = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.#client.readRest({
        projectId: projectIdValue,
        cacheKey: `${projectIdValue}:repository-labels:${page}`,
        token,
        path: `/repos/${profile.repository}/labels?per_page=100&page=${page}`,
        schema: repositoryLabelsResponse,
        conditional,
      });
      all.push(...result.value);
      if (result.value.length < 100) {
        return all
          .map((label) => ({
            name: label.name,
            color: label.color,
            description: label.description ?? "",
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
      }
    }
    throw new Error(`repository label listing for '${projectIdValue}' exceeded 100 pages`);
  }

  #profile(projectIdValue: string): ProjectProfile {
    const profile = this.#profiles.get(projectIdValue);
    if (profile === undefined) {
      throw new Error(`GitHub mutation targeted unknown project '${projectIdValue}'`);
    }
    return profile;
  }

  async #readComment(
    projectIdValue: string,
    commentId: number,
  ): Promise<z.output<typeof repositoryCommentResponse>> {
    const profile = this.#profile(projectIdValue);
    const token = await this.#tokens.tokenForProject(projectIdValue);
    const result = await this.#client.readRest({
      projectId: projectIdValue,
      cacheKey: `${projectIdValue}:comment:${commentId}`,
      token,
      path: `/repos/${profile.repository}/issues/comments/${commentId}`,
      schema: repositoryCommentResponse,
      conditional: false,
    });
    return result.value;
  }

  async #readSubjectComments(
    projectIdValue: string,
    subjectNumber: number,
  ): Promise<readonly z.output<typeof repositoryCommentResponse>[]> {
    const profile = this.#profile(projectIdValue);
    const token = await this.#tokens.tokenForProject(projectIdValue);
    const comments: z.output<typeof repositoryCommentResponse>[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.#client.readRest({
        projectId: projectIdValue,
        cacheKey: `${projectIdValue}:subject-comments:${subjectNumber}:${page}`,
        token,
        path: `/repos/${profile.repository}/issues/${subjectNumber}/comments?per_page=100&page=${page}`,
        schema: repositoryCommentsResponse,
        conditional: false,
      });
      comments.push(...result.value);
      if (result.value.length < 100) {
        return comments;
      }
    }
    throw new Error(
      `issue comment listing for '${projectIdValue}/${subjectNumber}' exceeded 100 pages`,
    );
  }
}

export interface GitHubMutationLedger {
  recordMutation(input: NewMutation): MutationRecord;
  transitionMutation(
    mutationId: string,
    nextState: MutationState,
    result?: unknown,
  ): MutationRecord;
  listMutations(states?: readonly MutationState[]): readonly MutationRecord[];
}

export type GitHubMutationExecutionStatus = "ambiguous" | "not-observed" | "verified";

export interface GitHubMutationExecutionResult {
  readonly mutationId: string;
  readonly status: GitHubMutationExecutionStatus;
  readonly attempts: number;
  readonly reconciledBeforeWrite: boolean;
}

interface IntendedMutation {
  readonly operationKey: string;
  readonly mutation: GitHubAllowedMutation;
}

function isIntendedMutation(input: unknown): input is IntendedMutation {
  if (input === null || typeof input !== "object") {
    return false;
  }
  const candidate = input as { operationKey?: unknown; mutation?: unknown };
  return (
    typeof candidate.operationKey === "string" &&
    GitHubAllowedMutationSchema.safeParse(candidate.mutation).success
  );
}

function observedResult(record: MutationRecord): boolean | null {
  if (record.result === null || typeof record.result !== "object") {
    return null;
  }
  const observed = (record.result as { observed?: unknown }).observed;
  return typeof observed === "boolean" ? observed : null;
}

export class GitHubMutationExecutor {
  readonly #ledger: GitHubMutationLedger;
  readonly #gateway: GitHubLabelGateway;
  readonly #redaction: RedactionBoundary;

  public constructor(
    ledger: GitHubMutationLedger,
    gateway: GitHubLabelGateway,
    redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
  ) {
    this.#ledger = ledger;
    this.#gateway = gateway;
    this.#redaction = redaction;
  }

  public get gateway(): GitHubLabelGateway {
    return this.#gateway;
  }

  public async execute(input: {
    readonly operationKey: string;
    readonly executionId: string | null;
    readonly mutation: unknown;
  }): Promise<GitHubMutationExecutionResult> {
    if (input.operationKey.length < 1 || input.operationKey.length > 400) {
      throw new Error("GitHub mutation operation key must contain 1 through 400 characters");
    }
    const mutation = sanitizeCommentMutation(
      assertAllowedGitHubMutation(input.mutation),
      this.#redaction,
    );
    const attempts = this.#attempts(mutation.projectId, input.operationKey);
    const latest = attempts.at(-1);
    let reconciledBeforeWrite = false;

    if (latest !== undefined) {
      if (latest.state === "reconciled" && observedResult(latest) === true) {
        return {
          mutationId: latest.mutationId,
          status: "verified",
          attempts: attempts.length,
          reconciledBeforeWrite,
        };
      }
      if (latest.state !== "reconciled") {
        const observed = await this.#gateway.verify(mutation);
        this.#ledger.transitionMutation(latest.mutationId, "reconciled", {
          observed,
          recovery: true,
        });
        reconciledBeforeWrite = true;
        if (observed) {
          return {
            mutationId: latest.mutationId,
            status: "verified",
            attempts: attempts.length,
            reconciledBeforeWrite,
          };
        }
      }
    }

    const attemptNumber = attempts.length + 1;
    const intendedMutation: IntendedMutation = {
      operationKey: input.operationKey,
      mutation,
    };
    const pending = this.#ledger.recordMutation({
      projectId: mutation.projectId,
      executionId: input.executionId,
      kind: mutation.kind,
      subjectType:
        mutation.kind === "add-label" ||
        mutation.kind === "remove-label" ||
        mutation.kind === "create-comment" ||
        mutation.kind === "update-comment"
          ? mutation.subjectType
          : "repository",
      subjectNumber:
        mutation.kind === "add-label" ||
        mutation.kind === "remove-label" ||
        mutation.kind === "create-comment" ||
        mutation.kind === "update-comment"
          ? mutation.subjectNumber
          : null,
      intendedMutation,
      idempotencyKey: `${mutation.projectId}:${input.operationKey}:attempt:${attemptNumber}`,
    });

    try {
      await this.#gateway.apply(mutation);
    } catch (error) {
      if (error instanceof GitHubMutationAmbiguousError) {
        this.#ledger.transitionMutation(pending.mutationId, "ambiguous", {
          classification: error.classification,
        });
        return {
          mutationId: pending.mutationId,
          status: "ambiguous",
          attempts: attemptNumber,
          reconciledBeforeWrite,
        };
      }
      this.#ledger.transitionMutation(pending.mutationId, "reconciled", {
        observed: false,
        rejected: error instanceof GitHubMutationRejectedError ? error.classification : "internal",
      });
      throw error;
    }

    this.#ledger.transitionMutation(pending.mutationId, "applied", { accepted: true });
    let observed: boolean;
    try {
      observed = await this.#gateway.verify(mutation);
    } catch {
      this.#ledger.transitionMutation(pending.mutationId, "ambiguous", {
        classification: "verification",
      });
      return {
        mutationId: pending.mutationId,
        status: "ambiguous",
        attempts: attemptNumber,
        reconciledBeforeWrite,
      };
    }
    this.#ledger.transitionMutation(pending.mutationId, "reconciled", { observed });
    return {
      mutationId: pending.mutationId,
      status: observed ? "verified" : "not-observed",
      attempts: attemptNumber,
      reconciledBeforeWrite,
    };
  }

  public async reconcileOutstanding(projectIdValue: string): Promise<readonly MutationRecord[]> {
    const outstanding = this.#ledger
      .listMutations(["pending", "applied", "ambiguous"])
      .filter((record) => record.projectId === projectIdValue);
    const reconciled: MutationRecord[] = [];
    for (const record of outstanding) {
      if (!isIntendedMutation(record.intendedMutation)) {
        throw new Error(`mutation '${record.mutationId}' has an invalid guarded intent`);
      }
      const observed = await this.#gateway.verify(record.intendedMutation.mutation);
      reconciled.push(
        this.#ledger.transitionMutation(record.mutationId, "reconciled", {
          observed,
          recovery: true,
        }),
      );
    }
    return reconciled;
  }

  #attempts(projectIdValue: string, operationKey: string): readonly MutationRecord[] {
    return this.#ledger
      .listMutations()
      .filter(
        (record) =>
          record.projectId === projectIdValue &&
          isIntendedMutation(record.intendedMutation) &&
          record.intendedMutation.operationKey === operationKey,
      )
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.mutationId.localeCompare(right.mutationId)
          : left.createdAt.localeCompare(right.createdAt),
      );
  }
}
