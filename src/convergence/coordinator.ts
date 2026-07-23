import type { ClockAdapter } from "@/adapters/interfaces.ts";
import type { ProjectProfile } from "@/contracts/project-profile.ts";
import type {
	ReadyEmissionResult,
	ReadyToMergeEmitter,
	ReviewConvergenceEngine,
} from "@/convergence/engine.ts";
import { resolveCanonicalLabels } from "@/domain/stages.ts";
import type { GitHubProjectSnapshot } from "@/github/index.ts";

export interface ProjectConvergenceResult {
	readonly projectId: string;
	readonly mutated: boolean;
	readonly conflictRepairPullRequestNumbers: readonly number[];
	readonly evaluations: readonly {
		readonly pullRequestNumber: number;
		readonly emission: ReadyEmissionResult;
	}[];
}

export class ReviewConvergenceCoordinator {
	readonly #profiles: ReadonlyMap<string, ProjectProfile>;
	readonly #engine: ReviewConvergenceEngine;
	readonly #emitters: ReadonlyMap<string, ReadyToMergeEmitter>;
	readonly #clock: ClockAdapter;
	readonly #headFirstObserved = new Map<
		string,
		{ readonly headSha: string; readonly at: string }
	>();

	public constructor(input: {
		readonly profiles: readonly ProjectProfile[];
		readonly engine: ReviewConvergenceEngine;
		readonly emitters: ReadonlyMap<string, ReadyToMergeEmitter>;
		readonly clock: ClockAdapter;
	}) {
		this.#profiles = new Map(input.profiles.map((profile) => [profile.id, profile]));
		this.#engine = input.engine;
		this.#emitters = input.emitters;
		this.#clock = input.clock;
	}

	public async reconcileProject(
		snapshot: GitHubProjectSnapshot,
	): Promise<ProjectConvergenceResult> {
		const profile = this.#profiles.get(snapshot.projectId);
		const emitter = this.#emitters.get(snapshot.projectId);
		if (profile === undefined || emitter === undefined) {
			throw new Error(`convergence targeted unknown project '${snapshot.projectId}'`);
		}
		const now = this.#clock.now();
		if (!Number.isFinite(now.getTime())) {
			throw new Error("convergence coordinator clock returned an invalid date");
		}
		const observedKeys = new Set<string>();
		const evaluations: ProjectConvergenceResult["evaluations"][number][] = [];
		for (const pullRequest of snapshot.pullRequests) {
			if (pullRequest.state !== "open") {
				continue;
			}
			const key = `${snapshot.projectId}:${pullRequest.number}`;
			observedKeys.add(key);
			const prior = this.#headFirstObserved.get(key);
			const headObservedAt = prior?.headSha === pullRequest.headSha ? prior.at : now.toISOString();
			this.#headFirstObserved.set(key, { headSha: pullRequest.headSha, at: headObservedAt });

			const resolved = resolveCanonicalLabels(profile.labels, pullRequest.labels);
			if (resolved.stage !== "in-progress" || resolved.conflictingStages.length > 0) {
				continue;
			}
			const decision = this.#engine.evaluate({
				profile,
				snapshot,
				pullRequestNumber: pullRequest.number,
				headObservedAt,
			});
			evaluations.push({
				pullRequestNumber: pullRequest.number,
				emission: await emitter.apply(profile, pullRequest, decision),
			});
		}
		for (const key of this.#headFirstObserved.keys()) {
			if (key.startsWith(`${snapshot.projectId}:`) && !observedKeys.has(key)) {
				this.#headFirstObserved.delete(key);
			}
		}
		return {
			projectId: snapshot.projectId,
			mutated: evaluations.some(
				({ emission }) => (emission.transition?.mutationResults.length ?? 0) > 0,
			),
			conflictRepairPullRequestNumbers: evaluations.flatMap(({ pullRequestNumber, emission }) =>
				emission.decision.action === "repair-conflict" ? [pullRequestNumber] : [],
			),
			evaluations,
		};
	}
}
