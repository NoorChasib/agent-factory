import type {
	AttemptStatus,
	ExecutionAttempt,
	ExecutionRecovery,
	NewProviderSession,
	ProcessMetadata,
	ProcessMetadataInput,
	ProviderSession,
} from "@/ledger/index.ts";
import { resumeWorkflowMatches } from "@/providers/runner-support.ts";
import {
	type ProviderRunOutcome,
	ProviderSessionContextSchema,
	type ResumeProviderSession,
	type ResumeWorkflowIdentity,
	ResumeWorkflowIdentitySchema,
} from "@/providers/types.ts";

export interface ProviderExecutionRepository {
	readExecutionRecovery(executionId: string): ExecutionRecovery;
	findCodexSessionForPullRequest(
		projectId: string,
		pullRequestNumber: number,
	): ProviderSession | null;
	startAttempt(executionId: string): ExecutionAttempt;
	updateAttempt(input: {
		readonly executionId: string;
		readonly attemptNumber: number;
		readonly status: AttemptStatus;
		readonly checkpoint: string | null;
		readonly outcome: string | null;
		readonly reasonCode: string | null;
	}): ExecutionAttempt;
	registerProviderSession(input: NewProviderSession): ProviderSession;
	markProviderSessionResumed(sessionKey: string): ProviderSession;
	saveProcessMetadata(input: ProcessMetadataInput): ProcessMetadata;
}

export interface PersistedProviderRun {
	readonly attempt: ExecutionAttempt;
	readonly session: ProviderSession | null;
	readonly process: ProcessMetadata | null;
	readonly outcome: ProviderRunOutcome;
}

export function resumeProviderSessionFromLedger(session: ProviderSession): ResumeProviderSession {
	return {
		sessionKey: session.sessionKey,
		executionId: session.executionId,
		provider: session.provider,
		id: session.providerSessionId,
		model: session.model,
		reasoningEffort: session.reasoningEffort,
		runtimeMetadata: ProviderSessionContextSchema.parse(session.runtimeMetadata),
	};
}

function attemptStatus(outcome: ProviderRunOutcome): AttemptStatus {
	switch (outcome.status) {
		case "blocked":
			return "blocked";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "operator_required":
			return "operator-required";
		case "provider_limit":
			return "provider-limit";
		case "stalled":
			return "stalled";
	}
}

export class ProviderExecutionRecorder {
	readonly #repository: ProviderExecutionRepository;

	public constructor(repository: ProviderExecutionRepository) {
		this.#repository = repository;
	}

	public async runInitial(
		executionId: string,
		launch: () => Promise<ProviderRunOutcome>,
	): Promise<PersistedProviderRun> {
		const recovery = this.#repository.readExecutionRecovery(executionId);
		if (recovery.sessions.length > 0) {
			throw new Error("execution already has a provider session; exact resume is required");
		}
		if (
			recovery.execution.provider === "codex" &&
			recovery.execution.pullRequestNumber !== null &&
			this.#repository.findCodexSessionForPullRequest(
				recovery.execution.projectId,
				recovery.execution.pullRequestNumber,
			) !== null
		) {
			throw new Error("pull request already has a Codex outer session; exact resume is required");
		}
		const started = this.#repository.startAttempt(executionId);
		const outcome = await launch();
		const session =
			outcome.session === null
				? null
				: this.#repository.registerProviderSession({
						executionId,
						attemptNumber: started.attemptNumber,
						provider: outcome.session.provider,
						providerSessionId: outcome.session.id,
						model: outcome.session.model,
						reasoningEffort: outcome.session.reasoningEffort,
						runtimeMetadata: outcome.session.runtimeMetadata,
					});
		return this.#finish(started, session, outcome);
	}

	public async runResume(
		executionId: string,
		recordedSession: ResumeProviderSession,
		workflowIdentity: ResumeWorkflowIdentity,
		resume: () => Promise<ProviderRunOutcome>,
	): Promise<PersistedProviderRun> {
		const target = this.#repository.readExecutionRecovery(executionId).execution;
		const parsedWorkflowIdentity = ResumeWorkflowIdentitySchema.parse(workflowIdentity);
		const sameClaudeExecution =
			recordedSession.provider === "claude" && recordedSession.executionId === executionId;
		const sameCodexPullRequest =
			recordedSession.provider === "codex" &&
			target.provider === "codex" &&
			target.pullRequestNumber !== null &&
			recordedSession.runtimeMetadata.projectId === target.projectId &&
			recordedSession.runtimeMetadata.issueNumber === target.issueNumber &&
			recordedSession.runtimeMetadata.pullRequestNumber === target.pullRequestNumber &&
			resumeWorkflowMatches(
				recordedSession.runtimeMetadata.workflow,
				target.workflow,
				parsedWorkflowIdentity,
			);
		if (!sameClaudeExecution && !sameCodexPullRequest) {
			throw new Error("resume-session-mismatch");
		}
		const started = this.#repository.startAttempt(executionId);
		const outcome = await resume();
		let session: ProviderSession | null = null;
		if (outcome.commandStarted) {
			if (
				outcome.session === null ||
				outcome.session.provider !== recordedSession.provider ||
				outcome.session.id !== recordedSession.id ||
				outcome.session.model !== recordedSession.model ||
				outcome.session.reasoningEffort !== recordedSession.reasoningEffort
			) {
				throw new Error("provider resume did not preserve the recorded session runtime");
			}
			session = this.#repository.markProviderSessionResumed(recordedSession.sessionKey);
		}
		return this.#finish(started, session, outcome);
	}

	#finish(
		started: ExecutionAttempt,
		session: ProviderSession | null,
		outcome: ProviderRunOutcome,
	): PersistedProviderRun {
		const process = outcome.commandStarted
			? this.#repository.saveProcessMetadata({
					executionId: started.executionId,
					attemptNumber: started.attemptNumber,
					paneId: null,
					processId: outcome.processId,
					processStartedAt: outcome.processStartedAt,
					hostIdentity: null,
					runtimeMetadata: {
						provider: outcome.provider,
						providerSessionId: outcome.session?.id ?? null,
						status: outcome.status,
						exitCode: outcome.exitCode,
						preserved: outcome.status !== "completed",
					},
				})
			: null;
		const attempt = this.#repository.updateAttempt({
			executionId: started.executionId,
			attemptNumber: started.attemptNumber,
			status: attemptStatus(outcome),
			checkpoint: outcome.workerResult?.checkpoint.code ?? null,
			outcome: outcome.status,
			reasonCode: outcome.reasonCode,
		});
		return { attempt, session, process, outcome };
	}
}
