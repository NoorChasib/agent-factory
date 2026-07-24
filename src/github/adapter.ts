import type { GitHubAdapter, GitHubObserveOptions } from "@/adapters/interfaces.ts";
import type { ProjectProfile } from "@/contracts/project-profile.ts";
import type { GitHubProjectObservation } from "@/controller/model.ts";
import type { GitHubApiClient } from "@/github/client.ts";
import type { GitHubMutationExecutor, GitHubProjectTokenProvider } from "@/github/mutations.ts";
import {
	type GitHubObservationAssociations,
	type GitHubProjectSnapshot,
	readGitHubObservation,
	toControllerObservation,
} from "@/github/observation.ts";
import { type GitHubLifecycleReconciler, shouldFullyReconcile } from "@/github/reconciliation.ts";

export interface ProductionGitHubAdapterOptions {
	readonly profiles: readonly ProjectProfile[];
	readonly client: GitHubApiClient;
	readonly tokens: GitHubProjectTokenProvider;
	readonly mutations?: GitHubMutationExecutor;
	readonly lifecycle?: GitHubLifecycleReconciler;
	readonly convergence?: {
		reconcileProject(snapshot: GitHubProjectSnapshot): Promise<{
			readonly mutated: boolean;
			readonly conflictRepairPullRequestNumbers?: readonly number[];
		}>;
	};
	readonly associations?: GitHubObservationAssociations;
}

function emptyObservation(projectId: string): GitHubProjectObservation {
	return { projectId, issues: [], pullRequests: [] };
}

export class ProductionGitHubAdapter implements GitHubAdapter {
	readonly #profiles: ReadonlyMap<string, ProjectProfile>;
	readonly #client: GitHubApiClient;
	readonly #tokens: GitHubProjectTokenProvider;
	readonly #mutations: GitHubMutationExecutor | undefined;
	readonly #lifecycle: GitHubLifecycleReconciler | undefined;
	readonly #convergence: ProductionGitHubAdapterOptions["convergence"];
	readonly #associations: GitHubObservationAssociations;
	readonly #lastObservations = new Map<string, GitHubProjectObservation>();

	public constructor(options: ProductionGitHubAdapterOptions) {
		this.#profiles = new Map(options.profiles.map((profile) => [profile.id, profile]));
		this.#client = options.client;
		this.#tokens = options.tokens;
		this.#mutations = options.mutations;
		this.#lifecycle = options.lifecycle;
		this.#convergence = options.convergence;
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
			const conflictRepairPullRequestNumbers = new Set<number>();
			if (options?.allowMutations === true) {
				let recovered = 0;
				let lifecycleTransitions = 0;
				if (full) {
					recovered =
						this.#mutations === undefined
							? 0
							: (await this.#mutations.reconcileOutstanding(projectId)).length;
					const activeFeedback = new Set(
						options.activeFeedbackPullRequests
							.filter((active) => active.projectId === projectId)
							.map((active) => active.pullRequestNumber),
					);
					const lifecycle =
						this.#lifecycle === undefined
							? null
							: await this.#lifecycle.reconcileProject(read.value, activeFeedback);
					lifecycleTransitions = lifecycle?.transitions.length ?? 0;
					for (const pullRequestNumber of lifecycle?.conflictRepairPullRequestNumbers ?? []) {
						conflictRepairPullRequestNumbers.add(pullRequestNumber);
					}
				}
				if (recovered > 0 || lifecycleTransitions > 0) {
					read = await readGitHubObservation(
						this.#client,
						profile,
						token,
						false,
						this.#associations,
					);
				}
				const convergence = await this.#convergence?.reconcileProject(read.value);
				for (const pullRequestNumber of convergence?.conflictRepairPullRequestNumbers ?? []) {
					conflictRepairPullRequestNumbers.add(pullRequestNumber);
				}
				if (convergence?.mutated === true) {
					read = await readGitHubObservation(
						this.#client,
						profile,
						token,
						false,
						this.#associations,
					);
				}
			}
			const observation = toControllerObservation(read.value, conflictRepairPullRequestNumbers);
			this.#lastObservations.set(projectId, observation);
			observations.push(observation);
		}
		return observations;
	}

	public mergedAt(projectId: string, pullRequestNumber: number): string | null {
		return (
			this.#lastObservations
				.get(projectId)
				?.pullRequests.find((pullRequest) => pullRequest.number === pullRequestNumber)?.mergedAt ??
			null
		);
	}
}
