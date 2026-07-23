import type { GitHubMutationExecutionResult, GitHubMutationExecutor } from "../github";
import { DEFAULT_REDACTION_BOUNDARY, type RedactionBoundary } from "../redaction";
import { type RecoveryRecord, RecoveryRecordSchema, renderRecoveryComment } from "./records";

export interface RecoveryCommentPublication {
	readonly body: string;
	readonly kind: "create-comment" | "update-comment";
	readonly result: GitHubMutationExecutionResult;
}

function bodyFingerprint(body: string): string {
	let hash = 2_166_136_261;
	for (const character of body) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export class RecoveryCommentPublisher {
	readonly #mutations: GitHubMutationExecutor;
	readonly #redaction: RedactionBoundary;

	public constructor(
		mutations: GitHubMutationExecutor,
		redaction: RedactionBoundary = DEFAULT_REDACTION_BOUNDARY,
	) {
		this.#mutations = mutations;
		this.#redaction = redaction;
	}

	public async publish(input: {
		readonly record: unknown;
		readonly existingCommentId: number | null;
	}): Promise<RecoveryCommentPublication> {
		const record: RecoveryRecord = RecoveryRecordSchema.parse(input.record);
		const body = renderRecoveryComment(record, this.#redaction);
		const kind = input.existingCommentId === null ? "create-comment" : "update-comment";
		const result = await this.#mutations.execute({
			operationKey: [
				"recovery-comment",
				record.executionId,
				input.existingCommentId ?? "create",
				bodyFingerprint(body),
			].join(":"),
			executionId: record.executionId,
			mutation:
				input.existingCommentId === null
					? {
							kind,
							projectId: record.projectAlias,
							subjectType: record.subject.kind,
							subjectNumber: record.subject.number,
							body,
						}
					: {
							kind,
							projectId: record.projectAlias,
							subjectType: record.subject.kind,
							subjectNumber: record.subject.number,
							commentId: input.existingCommentId,
							body,
						},
		});
		return { body, kind, result };
	}
}
