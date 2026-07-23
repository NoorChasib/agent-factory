import type { GitHubAdapter, GitHubObserveOptions } from "../adapters/interfaces";
import type { ProjectProfile } from "../contracts/project-profile";
import type { GitHubProjectObservation } from "../controller/model";
import type { GitHubApiClient } from "./client";
import type { GitHubMutationExecutor, GitHubProjectTokenProvider } from "./mutations";
import {
  type GitHubObservationAssociations,
  readGitHubObservation,
  toControllerObservation,
} from "./observation";
import { type GitHubLifecycleReconciler, shouldFullyReconcile } from "./reconciliation";

export interface ProductionGitHubAdapterOptions {
  readonly profiles: readonly ProjectProfile[];
  readonly client: GitHubApiClient;
  readonly tokens: GitHubProjectTokenProvider;
  readonly mutationExecutors?: ReadonlyMap<string, GitHubMutationExecutor>;
  readonly lifecycle?: GitHubLifecycleReconciler;
  readonly associations?: GitHubObservationAssociations;
}

function emptyObservation(projectId: string): GitHubProjectObservation {
  return { projectId, issues: [], pullRequests: [] };
}

export class ProductionGitHubAdapter implements GitHubAdapter {
  readonly #profiles: ReadonlyMap<string, ProjectProfile>;
  readonly #client: GitHubApiClient;
  readonly #tokens: GitHubProjectTokenProvider;
  readonly #mutationExecutors: ReadonlyMap<string, GitHubMutationExecutor>;
  readonly #lifecycle: GitHubLifecycleReconciler | undefined;
  readonly #associations: GitHubObservationAssociations;

  public constructor(options: ProductionGitHubAdapterOptions) {
    this.#profiles = new Map(options.profiles.map((profile) => [profile.id, profile]));
    this.#client = options.client;
    this.#tokens = options.tokens;
    this.#mutationExecutors = options.mutationExecutors ?? new Map();
    this.#lifecycle = options.lifecycle;
    this.#associations = options.associations ?? {};
  }

  public async observe(
    projectIds: readonly string[],
    options?: GitHubObserveOptions,
  ): Promise<unknown> {
    const enabled = new Set(
      options?.enabledProjectIds ??
        [...this.#profiles.values()]
          .filter((profile) => profile.enabled)
          .map((profile) => profile.id),
    );
    const observations: GitHubProjectObservation[] = [];
    for (const projectId of [...projectIds].sort()) {
      const profile = this.#profiles.get(projectId);
      if (profile === undefined) {
        throw new Error(`GitHub observation requested unknown project '${projectId}'`);
      }
      if (!enabled.has(projectId)) {
        observations.push(emptyObservation(projectId));
        continue;
      }

      const token = await this.#tokens.tokenForProject(projectId);
      let read = await readGitHubObservation(
        this.#client,
        profile,
        token,
        true,
        this.#associations,
      );
      const full = options !== undefined && shouldFullyReconcile(options.reason, read.changed);
      if (options?.allowMutations === true && full) {
        const executor = this.#mutationExecutors.get(projectId);
        const recovered =
          executor === undefined ? [] : await executor.reconcileOutstanding(projectId);
        const activeFeedback = new Set(
          options.activeFeedbackPullRequests
            .filter((active) => active.projectId === projectId)
            .map((active) => active.pullRequestNumber),
        );
        const lifecycle =
          this.#lifecycle === undefined
            ? null
            : await this.#lifecycle.reconcileProject(read.value, activeFeedback);
        if (recovered.length > 0 || (lifecycle?.transitions.length ?? 0) > 0) {
          read = await readGitHubObservation(
            this.#client,
            profile,
            token,
            false,
            this.#associations,
          );
        }
      }
      observations.push(toControllerObservation(read.value));
    }
    return observations;
  }
}
