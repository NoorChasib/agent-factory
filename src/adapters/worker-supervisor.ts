import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { safeId } from "../contracts/primitives";
import type { ProjectProfile } from "../contracts/project-profile";
import {
	type ExecutionRecord,
	ExecutionRecordSchema,
	type LaunchRequest,
	type StopRequest,
} from "../controller/model";
import { LedgerRevisionConflictError, type SqliteLedger } from "../ledger";
import { within } from "../path-guard";
import {
	type ClaudeCodeRunner,
	type CodexFeedbackRunner,
	type ProviderExecutionRecorder,
	type ProviderRuntime,
	resumeProviderSessionFromLedger,
} from "../providers";
import type { RecoveryHandoffCoordinator } from "../recovery";
import type { WorktreeCustody } from "../worktrees";
import type { HerdrCommandExecutionAdapter } from "./herdr-command";
import type { GitCustodyAdapter, WorkerProcessAdapter } from "./interfaces";

export class SelectionCheckoutCustody {
	readonly #git: GitCustodyAdapter;
	readonly #worktreeDirectory: string;

	public constructor(input: {
		readonly git: GitCustodyAdapter;
		readonly worktreeDirectory: string;
	}) {
		this.#git = input.git;
		this.#worktreeDirectory = resolve(input.worktreeDirectory);
	}

	public async prepare(profile: ProjectProfile, executionId: string): Promise<string> {
		const path = join(this.#worktreeDirectory, profile.id, `.selection-${executionId}`);
		if (!within(this.#worktreeDirectory, path)) {
			throw new Error("selection checkout escaped factory custody");
		}
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		if (existsSync(path)) {
			return path;
		}
		await this.#git.addDetachedWorktree({
			projectId: profile.id,
			path,
			startPoint: profile.defaultBranch,
		});
		return path;
	}

	public async finalize(input: {
		readonly profile: ProjectProfile;
		readonly executionId: string;
		readonly issueNumber: number;
		readonly branch: string;
	}): Promise<string> {
		const source = join(
			this.#worktreeDirectory,
			input.profile.id,
			`.selection-${input.executionId}`,
		);
		const destination = this.#git.worktreePath(input.profile.id, input.issueNumber);
		if (!within(this.#worktreeDirectory, source) || !within(this.#worktreeDirectory, destination)) {
			throw new Error("selection finalization escaped factory custody");
		}
		if (existsSync(destination)) {
			throw new Error("claimed issue already has a factory worktree");
		}
		const branch = await this.#git.branchShowCurrent({
			projectId: input.profile.id,
			path: source,
		});
		if (branch !== input.branch) {
			throw new Error("selection checkout branch does not match the worker result");
		}
		mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
		await this.#git.moveWorktree({
			projectId: input.profile.id,
			sourcePath: source,
			destinationPath: destination,
		});
		return `${input.profile.id}-issue-${input.issueNumber}`;
	}
}

export class ProviderWorkerSupervisor implements WorkerProcessAdapter {
	readonly #profiles: ReadonlyMap<string, ProjectProfile>;
	readonly #ledger: SqliteLedger;
	readonly #git: GitCustodyAdapter;
	readonly #worktrees: WorktreeCustody;
	readonly #selections: SelectionCheckoutCustody;
	readonly #claude: ClaudeCodeRunner;
	readonly #codex: CodexFeedbackRunner;
	readonly #commands: HerdrCommandExecutionAdapter;
	readonly #recorder: ProviderExecutionRecorder;
	readonly #codexRuntime: ProviderRuntime;
	readonly #nextExecutionId: () => string;
	readonly #stopExecution: (executionId: string) => Promise<void>;
	readonly #recoveryHandoff: RecoveryHandoffCoordinator | undefined;
	readonly #launches = new Map<string, LaunchRequest>();

	public constructor(input: {
		readonly profiles: readonly ProjectProfile[];
		readonly ledger: SqliteLedger;
		readonly git: GitCustodyAdapter;
		readonly worktrees: WorktreeCustody;
		readonly selections: SelectionCheckoutCustody;
		readonly claude: ClaudeCodeRunner;
		readonly codex: CodexFeedbackRunner;
		readonly commands: HerdrCommandExecutionAdapter;
		readonly recorder: ProviderExecutionRecorder;
		readonly codexRuntime: ProviderRuntime;
		readonly nextExecutionId: () => string;
		readonly stopExecution: (executionId: string) => Promise<void>;
		readonly recoveryHandoff?: RecoveryHandoffCoordinator;
	}) {
		this.#profiles = new Map(input.profiles.map((profile) => [profile.id, profile]));
		this.#ledger = input.ledger;
		this.#git = input.git;
		this.#worktrees = input.worktrees;
		this.#selections = input.selections;
		this.#claude = input.claude;
		this.#codex = input.codex;
		this.#commands = input.commands;
		this.#recorder = input.recorder;
		this.#codexRuntime = input.codexRuntime;
		this.#nextExecutionId = input.nextExecutionId;
		this.#stopExecution = input.stopExecution;
		this.#recoveryHandoff = input.recoveryHandoff;
	}

	public async start(request: LaunchRequest): Promise<unknown> {
		const executionId = safeId.parse(this.#nextExecutionId());
		this.#launches.set(executionId, structuredClone(request));
		return ExecutionRecordSchema.parse({
			executionId,
			projectId: request.projectId,
			lane: request.lane,
			provider: request.provider,
			workflow: request.workflow,
			claimState: request.issueNumber === null ? "selecting" : "awaiting-verification",
			issueNumber: request.issueNumber,
			pullRequestNumber: request.pullRequestNumber,
			branch: request.branch,
			worktreeId: null,
			headSha: request.headSha,
			status: "active",
		});
	}

	public async activate(execution: ExecutionRecord): Promise<void> {
		if (!this.#launches.has(execution.executionId)) {
			throw new Error(`execution '${execution.executionId}' has no prepared launch`);
		}
		void this.#run(execution).catch((error: unknown) =>
			this.#recordSupervisionFailure(execution.executionId, error),
		);
	}

	public async stop(request: StopRequest): Promise<void> {
		await this.#stopExecution(request.executionId);
	}

	public async resumeExecution(executionId: string): Promise<unknown> {
		const recovery = this.#ledger.readExecutionRecovery(executionId);
		const recorded = recovery.sessions.at(-1);
		if (recorded === undefined) {
			throw new Error(`execution '${executionId}' has no provider session to resume`);
		}
		const session = resumeProviderSessionFromLedger(recorded);
		const profile = this.#profiles.get(recovery.execution.projectId);
		if (profile === undefined) {
			throw new Error(`execution '${executionId}' belongs to an unknown project`);
		}
		const snapshot = await this.#ledger.read();
		const state = structuredClone(snapshot.state);
		const index = state.executions.findIndex((candidate) => candidate.executionId === executionId);
		const execution = state.executions[index];
		if (execution === undefined) {
			throw new Error(`unknown execution '${executionId}'`);
		}
		state.executions[index] = { ...execution, status: "active" };
		await this.#ledger.commit(snapshot.revision, state);
		void this.#commands
			.runForExecution(executionId, async () => {
				const path =
					execution.issueNumber === null
						? await this.#selections.prepare(profile, executionId)
						: this.#git.worktreePath(profile.id, execution.issueNumber);
				const request = {
					executionId,
					checkout: {
						path,
						projectId: profile.id,
						repository: profile.repository,
						defaultBranch: profile.defaultBranch,
						workflow: session.runtimeMetadata.workflow,
					},
					issueNumber: session.runtimeMetadata.issueNumber,
					pullRequestNumber: session.runtimeMetadata.pullRequestNumber,
				};
				return this.#recorder.runResume(executionId, session, () =>
					session.provider === "claude"
						? this.#claude.resume({ request, session })
						: this.#codex.resume({ request, runtime: this.#codexRuntime, session }),
				);
			})
			.then((persisted) =>
				this.#finish(executionId, {
					issueNumber: persisted.outcome.workerResult?.issue.number ?? execution.issueNumber,
					pullRequestNumber:
						persisted.outcome.workerResult?.pullRequest?.number ?? execution.pullRequestNumber,
					branch: persisted.outcome.workerResult?.branch.name ?? execution.branch,
					headSha: persisted.outcome.workerResult?.branch.headSha ?? execution.headSha,
					worktreeId: execution.worktreeId,
					circuitSignal: persisted.outcome.circuitSignal,
					status: persisted.outcome.status,
				}),
			)
			.catch((error: unknown) => this.#recordSupervisionFailure(executionId, error));
		return { executionId, resumeStarted: true };
	}

	async #run(execution: ExecutionRecord): Promise<void> {
		const launch = this.#launches.get(execution.executionId);
		const profile = this.#profiles.get(execution.projectId);
		if (launch === undefined || profile === undefined) {
			throw new Error("worker launch lost its profile or launch request");
		}
		await this.#worktrees.ensureMirror(profile.id, profile.repository);
		const checkout =
			launch.lane === "implementation"
				? await this.#selections.prepare(profile, execution.executionId)
				: (
						await this.#worktrees.createIssueWorktree({
							projectId: profile.id,
							repository: profile.repository,
							issueNumber: launch.issueNumber,
							branch: launch.branch,
							startPoint: launch.headSha,
						})
					).path;
		const request = {
			executionId: execution.executionId,
			checkout: {
				path: checkout,
				projectId: profile.id,
				repository: profile.repository,
				defaultBranch: profile.defaultBranch,
				workflow: launch.workflow,
			},
			issueNumber: launch.issueNumber,
			pullRequestNumber: launch.pullRequestNumber,
		};
		const persisted = await this.#commands.runForExecution(execution.executionId, () =>
			this.#recorder.runInitial(execution.executionId, () =>
				launch.lane === "implementation"
					? this.#claude.launch(request)
					: this.#codex.launch({ request, runtime: this.#codexRuntime }),
			),
		);
		const result = persisted.outcome.workerResult;
		if (
			persisted.outcome.status !== "completed" &&
			result !== null &&
			this.#recoveryHandoff !== undefined
		) {
			const recovery = this.#ledger.readExecutionRecovery(execution.executionId);
			try {
				await this.#recoveryHandoff.handoff({
					terminalStatus: persisted.outcome.status,
					record: {
						projectAlias: profile.id,
						executionId: execution.executionId,
						subject:
							result.pullRequest === null
								? { kind: "issue", number: result.issue.number }
								: { kind: "pull-request", number: result.pullRequest.number },
						branch: result.branch.name,
						commit: result.branch.headSha,
						pane: recovery.process?.paneId ?? null,
						providerSessionId: recovery.sessions.at(-1)?.providerSessionId ?? null,
						checkpoint: result.checkpoint.code,
						reasonCode: "execution-failed",
					},
					existingCommentId: null,
				});
			} catch (error) {
				this.#ledger.appendAudit("recovery-handoff-failed", {
					executionId: execution.executionId,
					message: error instanceof Error ? error.message : "recovery handoff failed",
				});
			}
		}
		let worktreeId = execution.worktreeId;
		if (launch.lane === "implementation" && result !== null) {
			worktreeId = await this.#selections.finalize({
				profile,
				executionId: execution.executionId,
				issueNumber: result.issue.number,
				branch: result.branch.name,
			});
		}
		await this.#finish(execution.executionId, {
			issueNumber: result?.issue.number ?? execution.issueNumber,
			pullRequestNumber: result?.pullRequest?.number ?? execution.pullRequestNumber,
			branch: result?.branch.name ?? execution.branch,
			headSha: result?.branch.headSha ?? execution.headSha,
			worktreeId,
			circuitSignal: persisted.outcome.circuitSignal,
			status: persisted.outcome.status,
		});
		this.#launches.delete(execution.executionId);
	}

	async #finish(
		executionId: string,
		input: {
			readonly issueNumber: number | null;
			readonly pullRequestNumber: number | null;
			readonly branch: string | null;
			readonly headSha: string | null;
			readonly worktreeId: string | null;
			readonly circuitSignal: Awaited<ReturnType<ClaudeCodeRunner["launch"]>>["circuitSignal"];
			readonly status: string;
		},
	): Promise<void> {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			const snapshot = await this.#ledger.read();
			const state = structuredClone(snapshot.state);
			const index = state.executions.findIndex(
				(candidate) => candidate.executionId === executionId,
			);
			const current = state.executions[index];
			if (current === undefined) {
				throw new Error(`completed worker '${executionId}' is absent from the ledger`);
			}
			state.executions[index] = ExecutionRecordSchema.parse({
				...current,
				issueNumber: input.issueNumber,
				pullRequestNumber: input.pullRequestNumber,
				branch: input.branch,
				headSha: input.headSha,
				worktreeId: input.worktreeId,
				claimState: input.issueNumber === null ? "selecting" : "awaiting-verification",
				status: current.status === "released" ? "released" : "completed",
			});
			if (input.circuitSignal !== null) {
				state.circuits[input.circuitSignal.provider] = {
					status: "open",
					reasonCode: input.circuitSignal.reasonCode,
				};
			}
			try {
				await this.#ledger.commit(snapshot.revision, state);
				this.#ledger.appendAudit("worker-supervision-completed", {
					executionId,
					status: input.status,
				});
				return;
			} catch (error) {
				if (!(error instanceof LedgerRevisionConflictError) || attempt === 3) {
					throw error;
				}
			}
		}
	}

	async #recordSupervisionFailure(executionId: string, error: unknown): Promise<void> {
		try {
			const recovery = this.#ledger.readExecutionRecovery(executionId);
			const latest = recovery.attempts.at(-1);
			if (latest?.status === "active") {
				this.#ledger.updateAttempt({
					executionId,
					attemptNumber: latest.attemptNumber,
					status: "failed",
					checkpoint: latest.checkpoint,
					outcome: "failed",
					reasonCode: "worker-supervision-failed",
				});
			}
			for (let attempt = 1; attempt <= 3; attempt += 1) {
				const snapshot = await this.#ledger.read();
				const state = structuredClone(snapshot.state);
				const index = state.executions.findIndex(
					(candidate) => candidate.executionId === executionId,
				);
				const current = state.executions[index];
				if (current === undefined || current.status !== "active") {
					break;
				}
				state.executions[index] = { ...current, status: "completed" };
				try {
					await this.#ledger.commit(snapshot.revision, state);
					break;
				} catch (commitError) {
					if (!(commitError instanceof LedgerRevisionConflictError) || attempt === 3) {
						throw commitError;
					}
				}
			}
			this.#launches.delete(executionId);
			this.#ledger.appendAudit("worker-supervision-failed", {
				executionId,
				message: error instanceof Error ? error.message : "worker supervision failed",
			});
		} catch (persistenceError) {
			try {
				this.#ledger.appendAudit("worker-supervision-failure-persistence-failed", {
					executionId,
					message:
						persistenceError instanceof Error
							? persistenceError.message
							: "worker supervision failure persistence failed",
				});
			} catch {
				// The ledger may already be closed during daemon shutdown.
			}
		}
	}
}
