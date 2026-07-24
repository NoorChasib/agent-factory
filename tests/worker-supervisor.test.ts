import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrCommandExecutionAdapter } from "@/adapters/herdr-command.ts";
import type { CommandExecutionResult } from "@/adapters/interfaces.ts";
import {
	ProviderWorkerSupervisor,
	SelectionCheckoutCustody,
} from "@/adapters/worker-supervisor.ts";
import { parseProjectProfileYaml } from "@/contracts/project-profile.ts";
import type { ControllerLocalState, ExecutionRecord, LaunchRequest } from "@/controller/model.ts";
import { parseClaudeRuntimeFromEnvironment } from "@/env.ts";
import {
	assertAllowedGitHubMutation,
	type GitHubAllowedMutation,
	type GitHubLabelGateway,
	GitHubMutationExecutor,
	type RepositoryLabel,
} from "@/github/index.ts";
import { type LedgerIdSource, openSqliteLedger, type SqliteLedger } from "@/ledger/index.ts";
import {
	type CapturedProviderSession,
	ClaudeCodeRunner,
	CodexFeedbackRunner,
	ProviderExecutionRecorder,
	type ProviderRunOutcome,
	type WorkerOutcomeVerification,
} from "@/providers/index.ts";
import {
	RecoveryCommentPublisher,
	RecoveryHandoffCoordinator,
	StallIncidentRecorder,
} from "@/recovery/index.ts";
import {
	createInitialControllerState,
	FixedClockAdapter,
	InMemoryGitCustodyAdapter,
	InMemoryGitHubMutationLedger,
	RecordingDelayAdapter,
	ScriptedCommandAdapter,
} from "@/testing/index.ts";
import { FactoryCustodyPaths, WorktreeCustody } from "@/worktrees/index.ts";

const headSha = "1".repeat(40);
const executionId = "execution-repair-1";
const codexThreadId = "thread-50";

const profile = parseProjectProfileYaml(
	await Bun.file(new URL("fixtures/profiles/hhc-aep.yaml", import.meta.url)).text(),
);
const repairWorkflow = (() => {
	const workflow = profile.workflow.conflictRepair;
	if (workflow === undefined) {
		throw new Error("conflict-repair fixture did not opt in");
	}
	return workflow;
})();

class LedgerIds implements LedgerIdSource {
	#next = 1;

	public nextId(
		kind: "audit-backup" | "maintenance-request" | "mutation" | "provider-session",
	): string {
		const id = `${kind}-supervisor-${this.#next}`;
		this.#next += 1;
		return id;
	}
}

class MutationIds {
	#next = 1;

	public nextMutationId(): string {
		const id = `mutation-supervisor-${this.#next}`;
		this.#next += 1;
		return id;
	}
}

class CommentGateway implements GitHubLabelGateway {
	readonly #comments = new Map<number, string>();
	#nextCommentId = 41;
	public readonly applied: GitHubAllowedMutation[] = [];

	public async apply(input: unknown): Promise<void> {
		const mutation = assertAllowedGitHubMutation(input);
		this.applied.push(mutation);
		if (mutation.kind === "create-comment") {
			this.#comments.set(this.#nextCommentId, mutation.body);
			this.#nextCommentId += 1;
		} else if (mutation.kind === "update-comment") {
			this.#comments.set(mutation.commentId, mutation.body);
		}
	}

	public async verify(input: GitHubAllowedMutation): Promise<boolean> {
		if (input.kind === "create-comment") {
			return [...this.#comments.values()].includes(input.body);
		}
		if (input.kind === "update-comment") {
			return this.#comments.get(input.commentId) === input.body;
		}
		return false;
	}

	public async findSubjectCommentId(): Promise<number | null> {
		return null;
	}

	public async readSubjectLabels(): Promise<readonly string[]> {
		return [];
	}

	public async listRepositoryLabels(): Promise<readonly RepositoryLabel[]> {
		return [];
	}
}

class RejectingCommentGateway extends CommentGateway {
	public override async apply(): Promise<void> {
		throw new Error("recovery comment rejected");
	}
}

function repairExecution(): ExecutionRecord {
	return {
		executionId,
		projectId: profile.id,
		lane: "feedback",
		provider: "codex",
		workflow: repairWorkflow,
		purpose: "conflict-repair",
		claimState: "verified",
		issueNumber: 50,
		pullRequestNumber: 50,
		branch: "factory/issue-50",
		worktreeId: null,
		headSha,
		status: "active",
	};
}

function repairState(): ControllerLocalState {
	const state = createInitialControllerState([profile]);
	state.executions.push(repairExecution());
	state.conflictRepair.invocations.push({
		projectId: profile.id,
		pullRequestNumber: 50,
		headSha,
		executionId,
		status: "active",
	});
	return state;
}

function repairLaunch(): LaunchRequest {
	return {
		projectId: profile.id,
		lane: "feedback",
		provider: "codex",
		workflow: repairWorkflow,
		issueNumber: 50,
		pullRequestNumber: 50,
		branch: "factory/issue-50",
		headSha,
		purpose: "conflict-repair",
	};
}

function exited(stdout: string): CommandExecutionResult {
	return {
		status: "exited",
		exitCode: 0,
		stdout,
		stderr: "",
		processId: 88,
	};
}

function threadOnlyOutput(): string {
	return JSON.stringify({ type: "thread.started", thread_id: codexThreadId });
}

interface Harness {
	readonly supervisor: ProviderWorkerSupervisor;
	readonly ledger: SqliteLedger;
	readonly recorder: ProviderExecutionRecorder;
}

function createHarness(
	directory: string,
	gateway: GitHubLabelGateway,
	codexSteps: readonly CommandExecutionResult[],
): Harness {
	const clock = new FixedClockAdapter();
	const ledger = openSqliteLedger({
		stateDirectory: directory,
		instanceId: "supervisor-test-controller",
		clock,
		ids: new LedgerIds(),
		initialState: repairState(),
	});
	const paths = new FactoryCustodyPaths({
		mirrorBaseDirectory: "/factory-data/mirrors",
		worktreeBaseDirectory: "/factory-data/worktrees",
		protectedCheckoutDirectories: ["/operator/agent-factory"],
	});
	const git = new InMemoryGitCustodyAdapter(paths);
	const tokens = { tokenForProject: async () => "ghs_supervisor-fixture-token" };
	const verifier = {
		verify: async (): Promise<WorkerOutcomeVerification> => ({ accepted: true, reasons: [] }),
	};
	const recorder = new ProviderExecutionRecorder(ledger);
	const recoveryHandoff = new RecoveryHandoffCoordinator({
		ledger,
		comments: new RecoveryCommentPublisher(
			new GitHubMutationExecutor(
				new InMemoryGitHubMutationLedger(clock, new MutationIds()),
				gateway,
			),
		),
		incidents: new StallIncidentRecorder(ledger),
	});
	const supervisor = new ProviderWorkerSupervisor({
		profiles: [profile],
		ledger,
		git,
		worktrees: new WorktreeCustody(git),
		selections: new SelectionCheckoutCustody({
			git,
			worktreeDirectory: join(directory, "worktrees"),
		}),
		claude: new ClaudeCodeRunner({
			commands: new ScriptedCommandAdapter([]),
			tokens,
			ids: { nextClaudeSessionId: () => "550e8400-e29b-41d4-a716-446655440000" },
			clock,
			verifier,
			runtime: parseClaudeRuntimeFromEnvironment({
				AGENT_FACTORY_CLAUDE_MODEL: "claude-fable-5",
				AGENT_FACTORY_CLAUDE_EFFORT: "high",
			}),
			controllerEnvironment: {},
		}),
		codex: new CodexFeedbackRunner({
			commands: new ScriptedCommandAdapter(codexSteps),
			tokens,
			clock,
			verifier,
			controllerEnvironment: {},
		}),
		commands: new HerdrCommandExecutionAdapter({
			herdr: {
				createPane: async () => ({ processId: null }),
				isExecutionAlive: async () => false,
			},
			ledger,
			delay: new RecordingDelayAdapter(),
			clock,
			stateDirectory: directory,
			workerExecutable: "/factory/bin/worker-command.ts",
		}),
		recorder,
		codexRuntime: { model: "gpt-5.6-codex", effort: "high" },
		nextExecutionId: () => executionId,
		stopExecution: async () => {},
		recoveryHandoff,
	});
	return { supervisor, ledger, recorder };
}

async function settle(until: () => boolean): Promise<void> {
	for (let i = 0; i < 1_000 && !until(); i += 1) {
		await Promise.resolve();
	}
	expect(until()).toBe(true);
}

async function temporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-factory-worker-supervisor-"));
	try {
		await run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("conflict-repair handoff custody in the worker supervisor", () => {
	test("does not record a per-head handoff when recovery publication fails", async () => {
		await temporaryDirectory(async (directory) => {
			const gateway = new RejectingCommentGateway();
			const harness = createHarness(directory, gateway, [exited(threadOnlyOutput())]);
			try {
				await harness.supervisor.start(repairLaunch());
				await harness.supervisor.activate(repairExecution());
				await settle(() =>
					harness.ledger.listAudit().some((event) => event.kind === "worker-supervision-completed"),
				);

				const { state } = await harness.ledger.read();
				expect(state.conflictRepair.handoffs).toEqual([]);
				expect(state.conflictRepair.invocations).toMatchObject([{ executionId, status: "failed" }]);
				expect(
					harness.ledger.listAudit().some((event) => event.kind === "recovery-handoff-failed"),
				).toBe(true);
			} finally {
				harness.ledger.close();
			}
		});
	});

	test("records the per-head handoff only after the recovery comment is published", async () => {
		await temporaryDirectory(async (directory) => {
			const gateway = new CommentGateway();
			const harness = createHarness(directory, gateway, [exited(threadOnlyOutput())]);
			try {
				await harness.supervisor.start(repairLaunch());
				await harness.supervisor.activate(repairExecution());
				await settle(() =>
					harness.ledger.listAudit().some((event) => event.kind === "worker-supervision-completed"),
				);

				const { state } = await harness.ledger.read();
				expect(state.conflictRepair.handoffs).toEqual([
					{
						projectId: profile.id,
						pullRequestNumber: 50,
						headSha,
						executionId,
						reason: "worker-failure",
					},
				]);
				expect(state.conflictRepair.invocations).toMatchObject([{ executionId, status: "failed" }]);
				expect(gateway.applied).toMatchObject([{ kind: "create-comment" }]);
			} finally {
				harness.ledger.close();
			}
		});
	});

	test("publishes the repair handoff for a resumed execution that fails supervision", async () => {
		await temporaryDirectory(async (directory) => {
			const gateway = new CommentGateway();
			const harness = createHarness(directory, gateway, []);
			try {
				const captured: CapturedProviderSession = {
					provider: "codex",
					id: codexThreadId,
					model: "gpt-5.6-codex",
					reasoningEffort: "high",
					// The issue number deliberately disagrees with the execution record so the
					// recorder raises a supervision exception after resumeExecution() starts.
					runtimeMetadata: {
						projectId: profile.id,
						repository: profile.repository,
						defaultBranch: profile.defaultBranch,
						workflow: repairWorkflow,
						issueNumber: 99,
						pullRequestNumber: 50,
					},
				};
				const outcome: ProviderRunOutcome = {
					provider: "codex",
					status: "failed",
					reasonCode: "worker-result-missing",
					session: captured,
					workerResult: null,
					verification: null,
					circuitSignal: null,
					commandStarted: true,
					processId: 77,
					processStartedAt: "2026-07-23T00:00:00.000Z",
					exitCode: 0,
				};
				await harness.recorder.runInitial(executionId, async () => outcome);

				await harness.supervisor.resumeExecution(executionId);
				await settle(() =>
					harness.ledger.listAudit().some((event) => event.kind === "worker-supervision-failed"),
				);

				const { state } = await harness.ledger.read();
				expect(gateway.applied).toMatchObject([{ kind: "create-comment" }]);
				expect(state.conflictRepair.handoffs).toEqual([
					{
						projectId: profile.id,
						pullRequestNumber: 50,
						headSha,
						executionId,
						reason: "worker-failure",
					},
				]);
				expect(state.conflictRepair.invocations).toMatchObject([{ executionId, status: "failed" }]);
			} finally {
				harness.ledger.close();
			}
		});
	});
});
