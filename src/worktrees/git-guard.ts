import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import type {
  CommandAdapter,
  CommandExecutionResult,
  CommandRequest,
  GitCustodyAdapter,
  GitWorktreeObservation,
} from "../adapters/interfaces";
import { GitBranchSchema, parseGitWorktreePorcelain } from "../contracts/git-worktree-output";
import type { GitHubProjectTokenProvider } from "../github/mutations";

const projectId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);
const repository = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const issueNumber = z.number().int().positive();
const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .startsWith("/")
  .refine((value) => !/[\0\r\n]/u.test(value));
export const GitCustodyOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("inspect-mirror"),
    projectId,
  }),
  z.strictObject({
    kind: z.literal("clone-mirror"),
    projectId,
    repository,
  }),
  z.strictObject({
    kind: z.literal("fetch-mirror"),
    projectId,
  }),
  z.strictObject({
    kind: z.literal("list-worktrees"),
    projectId,
  }),
  z.strictObject({
    kind: z.literal("worktree-add-detached"),
    projectId,
    path: absolutePath,
    startPoint: GitBranchSchema,
  }),
  z.strictObject({
    kind: z.literal("branch-show-current"),
    projectId,
    path: absolutePath,
  }),
  z.strictObject({
    kind: z.literal("worktree-move"),
    projectId,
    sourcePath: absolutePath,
    destinationPath: absolutePath,
  }),
  z.strictObject({
    kind: z.literal("add-worktree"),
    projectId,
    issueNumber,
    branch: GitBranchSchema,
    startPoint: GitBranchSchema,
  }),
  z.strictObject({
    kind: z.literal("remove-worktree"),
    projectId,
    issueNumber,
  }),
]);

export type GitCustodyOperation = z.infer<typeof GitCustodyOperationSchema>;

export const FORBIDDEN_GIT_OPERATION_KINDS = [
  "amend",
  "commit",
  "force-push",
  "merge",
  "push",
  "rebase",
  "reset",
] as const;

export class ForbiddenGitOperationError extends Error {
  public constructor() {
    super("Git operation is not in the Agent Factory custody allowlist");
    this.name = "ForbiddenGitOperationError";
  }
}

export class GitCustodyCommandError extends Error {
  public constructor(operation: GitCustodyOperation["kind"]) {
    super(`allowlisted Git ${operation} command failed`);
    this.name = "GitCustodyCommandError";
  }
}

export function assertAllowedGitOperation(input: unknown): GitCustodyOperation {
  const parsed = GitCustodyOperationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ForbiddenGitOperationError();
  }
  return parsed.data;
}

function normalizedAbsolutePath(value: string, description: string): string {
  if (!isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new Error(`${description} must be an absolute path without controls`);
  }
  return resolve(value);
}

function within(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export interface FactoryCustodyPathsOptions {
  readonly mirrorBaseDirectory: string;
  readonly worktreeBaseDirectory: string;
  readonly protectedCheckoutDirectories: readonly string[];
}

export class FactoryCustodyPaths {
  public readonly mirrorBaseDirectory: string;
  public readonly worktreeBaseDirectory: string;

  public constructor(options: FactoryCustodyPathsOptions) {
    this.mirrorBaseDirectory = normalizedAbsolutePath(
      options.mirrorBaseDirectory,
      "mirror base directory",
    );
    this.worktreeBaseDirectory = normalizedAbsolutePath(
      options.worktreeBaseDirectory,
      "worktree base directory",
    );
    const protectedDirectories = options.protectedCheckoutDirectories.map((path) =>
      normalizedAbsolutePath(path, "protected checkout directory"),
    );
    for (const base of [this.mirrorBaseDirectory, this.worktreeBaseDirectory]) {
      if (
        protectedDirectories.some(
          (protectedDirectory) =>
            within(protectedDirectory, base) || within(base, protectedDirectory),
        )
      ) {
        throw new Error("factory custody bases must be outside factory and operator checkouts");
      }
    }
    if (
      within(this.mirrorBaseDirectory, this.worktreeBaseDirectory) ||
      within(this.worktreeBaseDirectory, this.mirrorBaseDirectory)
    ) {
      throw new Error("mirror and worktree custody bases must not overlap");
    }
  }

  public mirrorPath(projectIdValue: string): string {
    return join(this.mirrorBaseDirectory, `${projectId.parse(projectIdValue)}.git`);
  }

  public worktreePath(projectIdValue: string, issueNumberValue: number): string {
    return join(
      this.worktreeBaseDirectory,
      projectId.parse(projectIdValue),
      `issue-${issueNumber.parse(issueNumberValue)}`,
    );
  }
}

export interface GuardedGitCommandAdapterOptions extends FactoryCustodyPathsOptions {
  readonly commands: CommandAdapter;
  readonly tokens: GitHubProjectTokenProvider;
  readonly executable?: string;
}

function requireSuccess(
  result: CommandExecutionResult,
  operation: GitCustodyOperation["kind"],
): CommandExecutionResult & { readonly status: "exited" } {
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new GitCustodyCommandError(operation);
  }
  return result;
}

export class GuardedGitCommandAdapter implements GitCustodyAdapter {
  readonly #commands: CommandAdapter;
  readonly #tokens: GitHubProjectTokenProvider;
  readonly #paths: FactoryCustodyPaths;
  readonly #executable: string;

  public constructor(options: GuardedGitCommandAdapterOptions) {
    this.#commands = options.commands;
    this.#tokens = options.tokens;
    this.#paths = new FactoryCustodyPaths(options);
    this.#executable = z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .parse(options.executable ?? "git");
  }

  public mirrorPath(projectIdValue: string): string {
    return this.#paths.mirrorPath(projectIdValue);
  }

  public worktreePath(projectIdValue: string, issueNumberValue: number): string {
    return this.#paths.worktreePath(projectIdValue, issueNumberValue);
  }

  public async mirrorExists(projectIdValue: string): Promise<boolean> {
    const operation = assertAllowedGitOperation({
      kind: "inspect-mirror",
      projectId: projectIdValue,
    });
    const result = await this.#run(operation, [
      "--git-dir",
      this.mirrorPath(operation.projectId),
      "rev-parse",
      "--is-bare-repository",
    ]);
    if (result.status === "exited" && result.exitCode === 0 && result.stdout.trim() === "true") {
      return true;
    }
    if (result.status === "exited" && result.exitCode === 128) {
      return false;
    }
    throw new GitCustodyCommandError(operation.kind);
  }

  public async cloneMirror(projectIdValue: string, repositoryValue: string): Promise<void> {
    const operation = assertAllowedGitOperation({
      kind: "clone-mirror",
      projectId: projectIdValue,
      repository: repositoryValue,
    });
    if (operation.kind !== "clone-mirror") {
      throw new ForbiddenGitOperationError();
    }
    requireSuccess(
      await this.#run(operation, [
        "clone",
        "--mirror",
        `https://github.com/${operation.repository}.git`,
        this.mirrorPath(operation.projectId),
      ]),
      operation.kind,
    );
  }

  public async fetchMirror(projectIdValue: string): Promise<void> {
    const operation = assertAllowedGitOperation({
      kind: "fetch-mirror",
      projectId: projectIdValue,
    });
    requireSuccess(
      await this.#run(operation, [
        "--git-dir",
        this.mirrorPath(operation.projectId),
        "fetch",
        "--prune",
        "origin",
      ]),
      operation.kind,
    );
  }

  public async listWorktrees(projectIdValue: string): Promise<readonly GitWorktreeObservation[]> {
    const operation = assertAllowedGitOperation({
      kind: "list-worktrees",
      projectId: projectIdValue,
    });
    const result = requireSuccess(
      await this.#run(operation, [
        "--git-dir",
        this.mirrorPath(operation.projectId),
        "worktree",
        "list",
        "--porcelain",
      ]),
      operation.kind,
    );
    return parseGitWorktreePorcelain(result.stdout);
  }

  public async addDetachedWorktree(input: {
    readonly projectId: string;
    readonly path: string;
    readonly startPoint: string;
  }): Promise<void> {
    const operation = assertAllowedGitOperation({
      kind: "worktree-add-detached",
      ...input,
    });
    if (operation.kind !== "worktree-add-detached") {
      throw new ForbiddenGitOperationError();
    }
    const path = this.#localWorktreePath(operation.projectId, operation.path);
    requireSuccess(
      await this.#run(operation, [
        "--git-dir",
        this.mirrorPath(operation.projectId),
        "worktree",
        "add",
        "--detach",
        path,
        operation.startPoint,
      ]),
      operation.kind,
    );
  }

  public async branchShowCurrent(input: {
    readonly projectId: string;
    readonly path: string;
  }): Promise<string> {
    const operation = assertAllowedGitOperation({
      kind: "branch-show-current",
      ...input,
    });
    if (operation.kind !== "branch-show-current") {
      throw new ForbiddenGitOperationError();
    }
    const path = this.#localWorktreePath(operation.projectId, operation.path);
    const result = requireSuccess(
      await this.#run(operation, ["-C", path, "branch", "--show-current"]),
      operation.kind,
    );
    return result.stdout.trim();
  }

  public async moveWorktree(input: {
    readonly projectId: string;
    readonly sourcePath: string;
    readonly destinationPath: string;
  }): Promise<void> {
    const operation = assertAllowedGitOperation({
      kind: "worktree-move",
      ...input,
    });
    if (operation.kind !== "worktree-move") {
      throw new ForbiddenGitOperationError();
    }
    const sourcePath = this.#localWorktreePath(operation.projectId, operation.sourcePath);
    const destinationPath = this.#localWorktreePath(operation.projectId, operation.destinationPath);
    requireSuccess(
      await this.#run(operation, [
        "--git-dir",
        this.mirrorPath(operation.projectId),
        "worktree",
        "move",
        sourcePath,
        destinationPath,
      ]),
      operation.kind,
    );
  }

  public async addWorktree(input: {
    readonly projectId: string;
    readonly issueNumber: number;
    readonly branch: string;
    readonly startPoint: string;
  }): Promise<void> {
    const operation = assertAllowedGitOperation({
      kind: "add-worktree",
      ...input,
    });
    if (operation.kind !== "add-worktree") {
      throw new ForbiddenGitOperationError();
    }
    requireSuccess(
      await this.#run(operation, [
        "--git-dir",
        this.mirrorPath(operation.projectId),
        "worktree",
        "add",
        "-b",
        operation.branch,
        "--",
        this.worktreePath(operation.projectId, operation.issueNumber),
        operation.startPoint,
      ]),
      operation.kind,
    );
  }

  public async removeWorktree(projectIdValue: string, issueNumberValue: number): Promise<void> {
    const operation = assertAllowedGitOperation({
      kind: "remove-worktree",
      projectId: projectIdValue,
      issueNumber: issueNumberValue,
    });
    if (operation.kind !== "remove-worktree") {
      throw new ForbiddenGitOperationError();
    }
    requireSuccess(
      await this.#run(operation, [
        "--git-dir",
        this.mirrorPath(operation.projectId),
        "worktree",
        "remove",
        this.worktreePath(operation.projectId, operation.issueNumber),
      ]),
      operation.kind,
    );
  }

  #localWorktreePath(projectIdValue: string, value: string): string {
    const path = normalizedAbsolutePath(value, "local worktree path");
    const projectDirectory = join(
      this.#paths.worktreeBaseDirectory,
      projectId.parse(projectIdValue),
    );
    if (path === projectDirectory || !within(projectDirectory, path)) {
      throw new ForbiddenGitOperationError();
    }
    return path;
  }

  async #run(
    operation: GitCustodyOperation,
    argv: readonly string[],
  ): Promise<CommandExecutionResult> {
    const env =
      operation.kind === "clone-mirror" || operation.kind === "fetch-mirror"
        ? await this.#remoteCredentialEnvironment(operation.projectId)
        : {};
    const request: CommandRequest = {
      executable: this.#executable,
      argv,
      cwd: this.#paths.mirrorBaseDirectory,
      env,
      stdin: "",
      stdout: "capture-json-lines",
      stderr: "capture",
    };
    return this.#commands.execute(request);
  }

  async #remoteCredentialEnvironment(
    projectIdValue: string,
  ): Promise<Readonly<Record<string, string>>> {
    const token = z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .parse(await this.#tokens.tokenForProject(projectIdValue));
    const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
      GIT_TERMINAL_PROMPT: "0",
    };
  }
}
