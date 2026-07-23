import type { FactoryReleaseBuildAdapter } from "../adapters/release-interfaces";
import { GitCommitShaSchema, type ReleaseManifest } from "../contracts/release-manifest";
import type { ReleaseStore } from "./store";

export class ReleaseCandidateBuildError extends Error {
  public readonly commitSha: string;

  public constructor(commitSha: string, cause: unknown) {
    super(`candidate release '${commitSha}' failed build validation`, { cause });
    this.name = "ReleaseCandidateBuildError";
    this.commitSha = commitSha;
  }
}

export class ReleaseBuilder {
  readonly #builds: FactoryReleaseBuildAdapter;
  readonly #store: ReleaseStore;

  public constructor(input: {
    readonly builds: FactoryReleaseBuildAdapter;
    readonly store: ReleaseStore;
  }) {
    this.#builds = input.builds;
    this.#store = input.store;
  }

  public async build(commitShaInput: string): Promise<ReleaseManifest> {
    const commitSha = GitCommitShaSchema.parse(commitShaInput);
    if (await this.#store.hasRelease(commitSha)) {
      return this.#store.validate(commitSha);
    }
    const buildId = this.#store.nextBuildId();
    const stagingPath = this.#store.stagingPath(commitSha, buildId);
    try {
      const built = await this.#builds.build({ commitSha, buildId, stagingPath });
      return await this.#store.install({
        commitSha,
        stagingPath,
        requiredLedgerSchemaVersion: built.requiredLedgerSchemaVersion,
      });
    } catch (error) {
      await this.#store.removeStaging(stagingPath);
      throw new ReleaseCandidateBuildError(commitSha, error);
    }
  }
}
