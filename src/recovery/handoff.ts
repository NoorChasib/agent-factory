import type { LedgerAdapter } from "../adapters/interfaces";
import { type WorkerTerminalStatus, WorkerTerminalStatusSchema } from "../contracts/worker-result";
import type { GitHubMutationExecutionResult } from "../github";
import type { RecoveryCommentPublisher } from "./comments";
import { recoveryReasonForWorkerStatus } from "./reason-codes";
import { RecoveryRecordSchema, type StallIncidentRecorder } from "./records";

export interface RecoveryHandoffResult {
	readonly executionId: string;
	readonly capacityFreed: boolean;
	readonly comment: GitHubMutationExecutionResult;
	readonly incidentSequence: number;
}

export interface RecoveryHandoffCoordinatorOptions {
	readonly ledger: LedgerAdapter;
	readonly comments: RecoveryCommentPublisher;
	readonly incidents: StallIncidentRecorder;
	readonly onHandoff?: (input: {
		readonly terminalStatus: WorkerTerminalStatus;
		readonly record: unknown;
	}) => Promise<void>;
}

export class RecoveryHandoffCoordinator {
	readonly #ledger: LedgerAdapter;
	readonly #comments: RecoveryCommentPublisher;
	readonly #incidents: StallIncidentRecorder;
	readonly #onHandoff:
		| ((input: {
				readonly terminalStatus: WorkerTerminalStatus;
				readonly record: unknown;
		  }) => Promise<void>)
		| undefined;

	public constructor(options: RecoveryHandoffCoordinatorOptions) {
		this.#ledger = options.ledger;
		this.#comments = options.comments;
		this.#incidents = options.incidents;
		this.#onHandoff = options.onHandoff;
	}

	public async handoff(input: {
		readonly terminalStatus: WorkerTerminalStatus;
		readonly record: unknown;
		readonly existingCommentId: number | null;
	}): Promise<RecoveryHandoffResult> {
		const terminalStatus = WorkerTerminalStatusSchema.parse(input.terminalStatus);
		const reasonCode = recoveryReasonForWorkerStatus(terminalStatus);
		if (reasonCode === null) {
			throw new Error("completed executions do not require a recovery handoff");
		}
		const record = RecoveryRecordSchema.parse({
			...RecoveryRecordSchema.parse(input.record),
			reasonCode,
		});
		const snapshot = await this.#ledger.read();
		const nextState = structuredClone(snapshot.state);
		const index = nextState.executions.findIndex(
			(candidate) => candidate.executionId === record.executionId,
		);
		const execution = nextState.executions[index];
		if (execution === undefined) {
			throw new Error(`unknown recovery execution '${record.executionId}'`);
		}
		const subjectMatches =
			record.subject.kind === "issue"
				? execution.issueNumber === record.subject.number
				: execution.pullRequestNumber === record.subject.number;
		if (execution.projectId !== record.projectAlias || !subjectMatches) {
			throw new Error("recovery record does not match its execution project and subject");
		}
		const capacityFreed = execution.status === "active";
		const incident = this.#incidents.append(record);
		let comment: GitHubMutationExecutionResult | undefined;
		let commentFailure: unknown;
		try {
			comment = (
				await this.#comments.publish({
					record,
					existingCommentId: input.existingCommentId,
				})
			).result;
		} catch (error) {
			commentFailure = error;
		}
		if (capacityFreed) {
			nextState.executions[index] = { ...execution, status: "completed" };
			await this.#ledger.commit(snapshot.revision, nextState);
		}
		if (commentFailure !== undefined) {
			throw commentFailure;
		}
		if (comment === undefined) {
			throw new Error("recovery comment publication returned no result");
		}
		await this.#onHandoff?.({ terminalStatus, record });
		return {
			executionId: record.executionId,
			capacityFreed,
			comment,
			incidentSequence: incident.auditEvent.sequence,
		};
	}
}
