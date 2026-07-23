import type { GitCustodyAdapter, GitWorktreeObservation } from "../adapters/interfaces";
import type { FactoryCustodyPaths } from "../worktrees";

export class InMemoryGitCustodyAdapter implements GitCustodyAdapter {
  readonly #paths: FactoryCustodyPaths;
  readonly #mirrors = new Set<string>();
  readonly #worktrees = new Map<string, GitWorktreeObservation[]>();
  public readonly operations: string[] = [];

  public constructor(paths: FactoryCustodyPaths) {
    this.#paths = paths;
  }

  public mirrorPath(projectId: string): string {
    return this.#paths.mirrorPath(projectId);
  }

  public worktreePath(projectId: string, issueNumber: number): string {
    return this.#paths.worktreePath(projectId, issueNumber);
  }

  public async mirrorExists(projectId: string): Promise<boolean> {
    this.operations.push(`inspect:${projectId}`);
    return this.#mirrors.has(projectId);
  }

  public async cloneMirror(projectId: string, repository: string): Promise<void> {
    this.operations.push(`clone:${projectId}:${repository}`);
    this.#mirrors.add(projectId);
  }

  public async fetchMirror(projectId: string): Promise<void> {
    this.operations.push(`fetch:${projectId}`);
    if (!this.#mirrors.has(projectId)) {
      throw new Error(`no in-memory mirror for '${projectId}'`);
    }
  }

  public async listWorktrees(projectId: string): Promise<readonly GitWorktreeObservation[]> {
    this.operations.push(`list:${projectId}`);
    return structuredClone(this.#worktrees.get(projectId) ?? []);
  }

  public async addDetachedWorktree(input: {
    readonly projectId: string;
    readonly path: string;
    readonly startPoint: string;
  }): Promise<void> {
    this.operations.push(`add-detached:${input.projectId}:${input.path}:${input.startPoint}`);
  }

  public async branchShowCurrent(input: {
    readonly projectId: string;
    readonly path: string;
  }): Promise<string> {
    this.operations.push(`branch-show-current:${input.projectId}:${input.path}`);
    return (
      (this.#worktrees.get(input.projectId) ?? []).find((worktree) => worktree.path === input.path)
        ?.branch ?? ""
    );
  }

  public async moveWorktree(input: {
    readonly projectId: string;
    readonly sourcePath: string;
    readonly destinationPath: string;
  }): Promise<void> {
    this.operations.push(`move:${input.projectId}:${input.sourcePath}:${input.destinationPath}`);
    const existing = this.#worktrees.get(input.projectId) ?? [];
    this.#worktrees.set(
      input.projectId,
      existing.map((worktree) =>
        worktree.path === input.sourcePath
          ? { ...worktree, path: input.destinationPath }
          : worktree,
      ),
    );
  }

  public async addWorktree(input: {
    readonly projectId: string;
    readonly issueNumber: number;
    readonly branch: string;
    readonly startPoint: string;
  }): Promise<void> {
    this.operations.push(
      `add:${input.projectId}:${input.issueNumber}:${input.branch}:${input.startPoint}`,
    );
    const existing = this.#worktrees.get(input.projectId) ?? [];
    existing.push({
      path: this.worktreePath(input.projectId, input.issueNumber),
      branch: input.branch,
      headSha: "0".repeat(40),
    });
    this.#worktrees.set(input.projectId, existing);
  }

  public async removeWorktree(projectId: string, issueNumber: number): Promise<void> {
    this.operations.push(`remove:${projectId}:${issueNumber}`);
    const path = this.worktreePath(projectId, issueNumber);
    this.#worktrees.set(
      projectId,
      (this.#worktrees.get(projectId) ?? []).filter((worktree) => worktree.path !== path),
    );
  }
}
