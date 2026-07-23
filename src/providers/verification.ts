import type { WorkerResult } from "@/contracts/worker-result.ts";
import {
	type GitHubProjectObservation,
	GitHubProjectObservationSchema,
} from "@/controller/model.ts";
import type {
	ProviderRunRequest,
	WorkerOutcomeVerification,
	WorkerOutcomeVerifier,
} from "@/providers/types.ts";

export interface WorkerOutcomeObservationReader {
	observeProject(projectId: string): Promise<unknown>;
}

function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort();
}

export function verifyWorkerResultAgainstObservation(input: {
	readonly request: ProviderRunRequest;
	readonly provider: "claude" | "codex";
	readonly providerSessionId: string;
	readonly result: WorkerResult;
	readonly observation: GitHubProjectObservation;
}): WorkerOutcomeVerification {
	const { observation, provider, providerSessionId, request, result } = input;
	const reasons: string[] = [];

	if (result.executionId !== request.executionId) {
		reasons.push("execution-id-mismatch");
	}
	if (result.target.projectId !== request.checkout.projectId) {
		reasons.push("project-id-mismatch");
	}
	if (result.target.repository !== request.checkout.repository) {
		reasons.push("repository-mismatch");
	}
	if (result.branch.base !== request.checkout.defaultBranch) {
		reasons.push("base-branch-mismatch");
	}
	if (
		result.providerSession.provider !== provider ||
		result.providerSession.id !== providerSessionId
	) {
		reasons.push("provider-session-mismatch");
	}
	if (request.issueNumber !== null && result.issue.number !== request.issueNumber) {
		reasons.push("issue-number-mismatch");
	}
	if (request.pullRequestNumber !== null) {
		if (result.pullRequest?.number !== request.pullRequestNumber) {
			reasons.push("pull-request-number-mismatch");
		}
	}
	if (observation.projectId !== request.checkout.projectId) {
		reasons.push("observation-project-mismatch");
	}

	const issue = observation.issues.find((candidate) => candidate.number === result.issue.number);
	if (issue === undefined) {
		reasons.push("issue-not-observed");
	}

	if (result.terminalStatus === "completed" && result.pullRequest === null) {
		reasons.push("completed-without-pull-request");
	}
	if (result.pullRequest !== null) {
		const pullRequest = observation.pullRequests.find(
			(candidate) => candidate.number === result.pullRequest?.number,
		);
		if (pullRequest === undefined) {
			reasons.push("pull-request-not-observed");
		} else {
			if (pullRequest.linkedIssueNumber !== result.issue.number) {
				reasons.push("pull-request-issue-mismatch");
			}
			if (pullRequest.branch !== result.branch.name) {
				reasons.push("branch-not-observed");
			}
			if (pullRequest.headSha !== result.branch.headSha) {
				reasons.push("head-not-observed");
			}
			if (request.purpose === "conflict-repair" && result.terminalStatus === "completed") {
				if (request.initialHeadSha === undefined) {
					reasons.push("repair-initial-head-missing");
				} else if (pullRequest.headSha === request.initialHeadSha) {
					reasons.push("repair-head-unchanged");
				}
				if (request.branch === undefined || pullRequest.branch !== request.branch) {
					reasons.push("repair-branch-mismatch");
				}
				if (pullRequest.mergeability === undefined) {
					reasons.push("repair-mergeability-unavailable");
				} else if (pullRequest.mergeability === "conflicting") {
					reasons.push("repair-still-conflicting");
				}
			}
		}
		if (issue !== undefined && issue.pullRequestNumber !== result.pullRequest.number) {
			reasons.push("issue-pull-request-association-mismatch");
		}
	} else if (result.branch.pushed) {
		reasons.push("pushed-head-not-observed");
	}

	const normalized = unique(reasons);
	return normalized.length === 0
		? { accepted: true, reasons: [] }
		: { accepted: false, reasons: normalized };
}

export class ObservedWorkerOutcomeVerifier implements WorkerOutcomeVerifier {
	readonly #observations: WorkerOutcomeObservationReader;

	public constructor(observations: WorkerOutcomeObservationReader) {
		this.#observations = observations;
	}

	public async verify(
		input: Omit<Parameters<WorkerOutcomeVerifier["verify"]>[0], never>,
	): Promise<WorkerOutcomeVerification> {
		const observation = GitHubProjectObservationSchema.parse(
			await this.#observations.observeProject(input.request.checkout.projectId),
		);
		return verifyWorkerResultAgainstObservation({ ...input, observation });
	}
}
