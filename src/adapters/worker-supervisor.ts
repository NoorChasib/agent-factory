import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HerdrCommandExecutionAdapter } from "@/adapters/herdr-command.ts";
import type { GitCustodyAdapter, WorkerProcessAdapter } from "@/adapters/interfaces.ts";
import { safeId } from "@/contracts/primitives.ts";
import type { ProjectProfile } from "@/contracts/project-profile.ts";
import type { WorkerTerminalStatus } from "@/contracts/worker-result.ts";
import {
	type ConflictRepairHandoffRequest,
	type ControllerLocalState,
	type ExecutionRecord,
	ExecutionRecordSchema,
	type LaunchRequest,
	type StopRequest,
} from "@/controller/model.ts";
import { LedgerRevisionConflictError, type SqliteLedger } from "@/ledger/index.ts";
import { within } from "@/path-guard.ts";
import {
	type ClaudeCodeRunner,
	type CodexFeedbackRunner,
	type ProviderExecutionRecorder,
	type ProviderRuntime,
	type ResumeWorkflowIdentity,
	resumeProviderSessionFromLedger,
} from "@/providers/index.ts";
import type { RecoveryHandoffCoordinator } from "@/recovery/index.ts";
import type { WorktreeCustody } from "@/worktrees/index.ts";

function resumeWorkflowIdentity(profile: ProjectProfile): ResumeWorkflowIdentity {
	return {
		feedback: profile.workflow.feedback,
		...(profile.workflow.conflictRepair === undefined
			? {}
			: { conflictRepair: profile.workflow.conflictRepair }),
	};
}

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
	readonly #releaseRequested = new Set<string>();

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
			...(request.purpose === undefined ? {} : { purpose: request.purpose }),
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
			throw new Error(`execution '${execution.executionId}' has no pending worker launch`);
		}
		void this.#run(execution).catch((error: unknown) =>
			this.#recordSupervisionFailure(execution.executionId, error),
		);
	}

	public async stop(request: StopRequest): Promise<void> {
		this.#releaseRequested.add(request.executionId);
		try {
			await this.#stopExecution(request.executionId);
		} catch (error) {
			this.#releaseRequested.delete(request.executionId);
			throw error;
		}
	}

	public async handoffConflictRepair(request: ConflictRepairHandoffRequest): Promise<void> {
		const profile = this.#profiles.get(request.projectId);
		if (profile === undefined) {
			throw new Error(`conflict-repair handoff targeted unknown project '${request.projectId}'`);
		}
		const snapshot = await this.#ledger.read();
		const execution = snapshot.state.executions.find(
			(candidate) => candidate.executionId === request.executionId,
		);
		if (execution === undefined) {
			throw new Error(
				`conflict-repair handoff targeted unknown execution '${request.executionId}'`,
			);
		}
		await this.#handoff({
			profile,
			execution,
			terminalStatus: "operator_required",
			branch: request.branch,
			headSha: request.headSha,
			checkpoint: `conflict-repair-${request.reason}`,
		});
	}

	public async resumeExecution(executionId: string): Promise<unknown> {
		const recovery = this.#ledger.readExecutionRecovery(executionId);
		const recorded =
			recovery.sessions.at(-1) ??
			(recovery.execution.provider === "codex" && recovery.execution.pullRequestNumber !== null
				? this.#ledger.findCodexSessionForPullRequest(
						recovery.execution.projectId,
						recovery.execution.pullRequestNumber,
					)
				: null);
		if (recorded === undefined || recorded === null) {
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
		const invocation = state.conflictRepair.invocations.find(
			(candidate) => candidate.executionId === executionId,
		);
		const purpose = invocation === undefined ? undefined : ("conflict-repair" as const);
		const workflowIdentity = resumeWorkflowIdentity(profile);
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
						workflow: execution.workflow,
					},
					issueNumber: execution.issueNumber,
					pullRequestNumber: execution.pullRequestNumber,
					...(purpose === undefined ? {} : { purpose }),
					...(execution.branch === null ? {} : { branch: execution.branch }),
					...(invocation === undefined ? {} : { initialHeadSha: invocation.headSha }),
				};
				return this.#recorder.runResume(executionId, session, workflowIdentity, () =>
					session.provider === "claude"
						? this.#claude.resume({ request, session })
						: this.#codex.resume({
								request,
								runtime: this.#codexRuntime,
								session,
								workflowIdentity,
							}),
				);
			})
			.then(async (persisted) => {
				const result = persisted.outcome.workerResult;
				if (persisted.outcome.status !== "completed") {
					try {
						await this.#handoff({
							profile,
							execution,
							terminalStatus: persisted.outcome.status,
							branch: result?.branch.name ?? execution.branch,
							headSha: result?.branch.headSha ?? execution.headSha,
							checkpoint:
								result?.checkpoint.code ?? persisted.outcome.reasonCode ?? "execution-failed",
						});
					} catch (error) {
						this.#ledger.appendAudit("recovery-handoff-failed", {
							executionId,
							message: error instanceof Error ? error.message : "recovery handoff failed",
						});
					}
				}
				return this.#finish(executionId, {
					issueNumber: persisted.outcome.workerResult?.issue.number ?? execution.issueNumber,
					pullRequestNumber:
						persisted.outcome.workerResult?.pullRequest?.number ?? execution.pullRequestNumber,
					branch: persisted.outcome.workerResult?.branch.name ?? execution.branch,
					headSha: persisted.outcome.workerResult?.branch.headSha ?? execution.headSha,
					worktreeId: execution.worktreeId,
					circuitSignal: persisted.outcome.circuitSignal,
					status: persisted.outcome.status,
					conflictRepair:
						purpose === "conflict-repair"
							? {
									initialHeadSha: invocation?.headSha ?? execution.headSha,
									handoff: persisted.outcome.status !== "completed",
								}
							: null,
				});
			})
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
			...(launch.purpose === undefined ? {} : { purpose: launch.purpose }),
			...(launch.branch === null ? {} : { branch: launch.branch }),
			...(launch.purpose === "conflict-repair" && launch.headSha !== null
				? { initialHeadSha: launch.headSha }
				: {}),
		};
		const existingCodexSession =
			launch.lane === "feedback" && launch.pullRequestNumber !== null
				? this.#ledger.findCodexSessionForPullRequest(profile.id, launch.pullRequestNumber)
				: null;
		const workflowIdentity = resumeWorkflowIdentity(profile);
		const persisted = await this.#commands.runForExecution(execution.executionId, () => {
			if (launch.lane === "implementation") {
				return this.#recorder.runInitial(execution.executionId, () => this.#claude.launch(request));
			}
			if (existingCodexSession === null) {
				return this.#recorder.runInitial(execution.executionId, () =>
					this.#codex.launch({ request, runtime: this.#codexRuntime }),
				);
			}
			const session = resumeProviderSessionFromLedger(existingCodexSession);
			return this.#recorder.runResume(execution.executionId, session, workflowIdentity, () =>
				this.#codex.resume({
					request,
					runtime: this.#codexRuntime,
					session,
					workflowIdentity,
				}),
			);
		});
		const result = persisted.outcome.workerResult;
		if (persisted.outcome.status !== "completed") {
			try {
				await this.#handoff({
					profile,
					execution,
					terminalStatus: persisted.outcome.status,
					branch: result?.branch.name ?? launch.branch,
					headSha: result?.branch.headSha ?? launch.headSha,
					checkpoint: result?.checkpoint.code ?? persisted.outcome.reasonCode ?? "execution-failed",
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
			conflictRepair:
				launch.purpose === "conflict-repair"
					? {
							initialHeadSha: launch.headSha,
							handoff: persisted.outcome.status !== "completed",
						}
					: null,
		});
		this.#launches.delete(execution.executionId);
	}

	#recordConflictRepairOutcome(
		state: ControllerLocalState,
		executionId: string,
		status: "completed" | "failed" | "released",
		handoff: boolean,
	): void {
		const invocationIndex = state.conflictRepair.invocations.findIndex(
			(candidate) => candidate.executionId === executionId,
		);
		const invocation = state.conflictRepair.invocations[invocationIndex];
		if (invocation === undefined) {
			return;
		}
		const effectiveStatus =
			invocation.status === "released" || status === "released" ? "released" : status;
		state.conflictRepair.invocations[invocationIndex] = {
			...invocation,
			status: effectiveStatus,
		};
		if (
			effectiveStatus !== "released" &&
			handoff &&
			!state.conflictRepair.handoffs.some(
				(existing) =>
					existing.projectId === invocation.projectId &&
					existing.pullRequestNumber === invocation.pullRequestNumber &&
					existing.headSha === invocation.headSha,
			)
		) {
			state.conflictRepair.handoffs.push({
				projectId: invocation.projectId,
				pullRequestNumber: invocation.pullRequestNumber,
				headSha: invocation.headSha,
				executionId,
				reason: "worker-failure",
			});
		}
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
			readonly conflictRepair: {
				readonly initialHeadSha: string | null;
				readonly handoff: boolean;
			} | null;
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
			const released = current.status === "released" || this.#releaseRequested.has(executionId);
			state.executions[index] = ExecutionRecordSchema.parse({
				...current,
				issueNumber: input.issueNumber,
				pullRequestNumber: input.pullRequestNumber,
				branch: input.branch,
				headSha: input.headSha,
				worktreeId: input.worktreeId,
				claimState: input.issueNumber === null ? "selecting" : "awaiting-verification",
				status: released ? "released" : "completed",
			});
			if (input.conflictRepair !== null) {
				let invocationStatus: "completed" | "failed" | "released" =
					input.status === "completed" ? "completed" : "failed";
				if (released) {
					invocationStatus = "released";
				}
				this.#recordConflictRepairOutcome(
					state,
					executionId,
					invocationStatus,
					input.conflictRepair.handoff,
				);
			}
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
				this.#releaseRequested.delete(executionId);
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
			const launch = this.#launches.get(executionId);
			const profile = this.#profiles.get(recovery.execution.projectId);
			const released = this.#releaseRequested.has(executionId);
			if (!released && launch?.purpose === "conflict-repair" && profile !== undefined) {
				try {
					await this.#handoff({
						profile,
						execution: recovery.execution,
						terminalStatus: "failed",
						branch: launch.branch,
						headSha: launch.headSha,
						checkpoint: "worker-supervision-failed",
					});
				} catch {
					// The audit below records the supervision failure even if handoff publication fails.
				}
			}
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
				if (current === undefined) {
					break;
				}
				if (released) {
					state.executions[index] = { ...current, status: "released" };
				} else if (current.status === "active") {
					state.executions[index] = { ...current, status: "completed" };
				}
				this.#recordConflictRepairOutcome(
					state,
					executionId,
					released || current.status === "released" ? "released" : "failed",
					!released && current.status !== "released",
				);
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
			this.#releaseRequested.delete(executionId);
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

	async #handoff(input: {
		readonly profile: ProjectProfile;
		readonly execution: ExecutionRecord;
		readonly terminalStatus: Exclude<WorkerTerminalStatus, "completed">;
		readonly branch: string | null;
		readonly headSha: string | null;
		readonly checkpoint: string;
	}): Promise<void> {
		if (this.#recoveryHandoff === undefined) {
			return;
		}
		const recovery = this.#ledger.readExecutionRecovery(input.execution.executionId);
		const session =
			recovery.sessions.at(-1) ??
			(input.execution.pullRequestNumber === null
				? null
				: this.#ledger.findCodexSessionForPullRequest(
						input.profile.id,
						input.execution.pullRequestNumber,
					));
		const sessionRecovery =
			session === null || session === undefined
				? null
				: this.#ledger.readExecutionRecovery(session.executionId);
		const subject =
			input.execution.pullRequestNumber === null
				? {
						kind: "issue" as const,
						number: input.execution.issueNumber,
					}
				: {
						kind: "pull-request" as const,
						number: input.execution.pullRequestNumber,
					};
		if (subject.number === null) {
			throw new Error("recovery handoff execution has no subject");
		}
		await this.#recoveryHandoff.handoff({
			terminalStatus: input.terminalStatus,
			record: {
				projectAlias: input.profile.id,
				executionId: input.execution.executionId,
				subject: { ...subject, number: subject.number },
				branch: input.branch,
				commit: input.headSha,
				pane: recovery.process?.paneId ?? sessionRecovery?.process?.paneId ?? null,
				providerSessionId: session?.providerSessionId ?? null,
				checkpoint: input.checkpoint,
				reasonCode: "execution-failed",
			},
			existingCommentId: null,
		});
	}
}
