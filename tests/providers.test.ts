import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectProfileYaml } from "@/contracts/project-profile.ts";
import type { WorkerResult } from "@/contracts/worker-result.ts";
import type { ControllerLocalState } from "@/controller/model.ts";
import { parseClaudeRuntimeFromEnvironment } from "@/env.ts";
import { mapGitHubObservation, toControllerObservation } from "@/github/index.ts";
import type { LedgerIdSource } from "@/ledger/index.ts";
import { openSqliteLedger } from "@/ledger/index.ts";
import {
	type CapturedProviderSession,
	ClaudeCodeRunner,
	CodexFeedbackRunner,
	circuitSignalForFailure,
	circuitSignalFromGitHubFailure,
	openCircuitCommand,
	ProviderCircuitRecovery,
	type ProviderCircuitSignal,
	ProviderExecutionRecorder,
	type ProviderRunOutcome,
	type ProviderRunRequest,
	type ProviderRuntime,
	type ResumeProviderSession,
	verifyWorkerResultAgainstObservation,
	type WorkerOutcomeVerification,
	type WorkerOutcomeVerifier,
} from "@/providers/index.ts";
import {
	createInitialControllerState,
	FixedClockAdapter,
	ScriptedCommandAdapter,
} from "@/testing/index.ts";

const claudeSessionId = "550e8400-e29b-41d4-a716-446655440000";
const claudeModel = "claude-fable-5";
const claudeEffort = "high";
const claudeRuntimeEnvironment = {
	AGENT_FACTORY_CLAUDE_MODEL: claudeModel,
	AGENT_FACTORY_CLAUDE_EFFORT: claudeEffort,
};
const codexThreadId = "thread-101";
const headSha = "1111111111111111111111111111111111111111";

const profile = parseProjectProfileYaml(
	await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);
const snapshot = mapGitHubObservation(
	profile,
	await Bun.file(new URL("fixtures/github/lumen-observation.json", import.meta.url)).json(),
);

const feedbackRequest: ProviderRunRequest = {
	executionId: "execution-101",
	checkout: {
		path: "/factory/worktrees/pr-101",
		projectId: profile.id,
		repository: profile.repository,
		defaultBranch: profile.defaultBranch,
		workflow: profile.workflow.feedback,
	},
	issueNumber: 11,
	pullRequestNumber: 101,
};

const implementationRequest: ProviderRunRequest = {
	...feedbackRequest,
	checkout: {
		...feedbackRequest.checkout,
		path: "/factory/worktrees/implementation-selector",
		workflow: profile.workflow.implement,
	},
	issueNumber: null,
	pullRequestNumber: null,
};

class Tokens {
	public readonly projects: string[] = [];

	public async tokenForProject(projectId: string): Promise<string> {
		this.projects.push(projectId);
		return "short-lived-installation-token";
	}
}

class ClaudeIds {
	public calls = 0;

	public nextClaudeSessionId(): string {
		this.calls += 1;
		return claudeSessionId;
	}
}

class AcceptingVerifier implements WorkerOutcomeVerifier {
	public calls = 0;

	public async verify(): Promise<WorkerOutcomeVerification> {
		this.calls += 1;
		return { accepted: true, reasons: [] };
	}
}

function workerResult(
	provider: "claude" | "codex",
	sessionId: string,
	overrides: Partial<WorkerResult> = {},
): WorkerResult {
	return {
		schemaVersion: 1,
		executionId: feedbackRequest.executionId,
		target: {
			projectId: profile.id,
			repository: profile.repository,
		},
		issue: { number: 11 },
		pullRequest: { number: 101 },
		branch: {
			name: "factory/issue-11",
			base: profile.defaultBranch,
			headSha,
			pushed: true,
		},
		providerSession: {
			provider,
			id: sessionId,
		},
		checkpoint: {
			phase: "verification",
			sequence: 4,
			code: "current-head-verified",
		},
		terminalStatus: "completed",
		...overrides,
	};
}

function lines(...records: readonly unknown[]): string {
	return records.map((record) => JSON.stringify(record)).join("\n");
}

function exited(stdout: string, processId = 42) {
	return {
		status: "exited" as const,
		exitCode: 0,
		stdout,
		stderr: "",
		processId,
	};
}

function claudeInitialization(
	values: Partial<{
		session_id: string;
		model: string;
		effort: "low" | "medium" | "high" | "max";
	}> = {},
) {
	return {
		type: "system",
		subtype: "init",
		session_id: claudeSessionId,
		model: claudeModel,
		effort: claudeEffort,
		providerMayAddFields: true,
		...values,
	};
}

function resultEvent(result: WorkerResult) {
	return { type: "agent_factory.worker_result", result };
}

describe("provider runtime configuration and Claude launch", () => {
	test("requires Claude runtime values and rejects unsafe or unknown values", () => {
		expect(parseClaudeRuntimeFromEnvironment(claudeRuntimeEnvironment)).toEqual({
			model: claudeModel,
			effort: claudeEffort,
		});
		expect(() => parseClaudeRuntimeFromEnvironment({})).toThrow("must be set");
		expect(
			parseClaudeRuntimeFromEnvironment({
				AGENT_FACTORY_CLAUDE_MODEL: "claude-custom-1",
				AGENT_FACTORY_CLAUDE_EFFORT: "max",
			}),
		).toEqual({ model: "claude-custom-1", effort: "max" });
		expect(() =>
			parseClaudeRuntimeFromEnvironment({
				...claudeRuntimeEnvironment,
				AGENT_FACTORY_CLAUDE_MODEL: "--fallback-model",
			}),
		).toThrow("safe model");
		expect(() =>
			parseClaudeRuntimeFromEnvironment({
				...claudeRuntimeEnvironment,
				AGENT_FACTORY_CLAUDE_EFFORT: "turbo",
			}),
		).toThrow("effort");
	});

	test("pre-generates the session, verifies structured initialization, and passes no fallback", async () => {
		const ids = new ClaudeIds();
		const verifier = new AcceptingVerifier();
		const commands = new ScriptedCommandAdapter([
			exited(
				lines(
					claudeInitialization(),
					{ type: "assistant", message: "ignored provider event" },
					resultEvent(workerResult("claude", claudeSessionId)),
				),
			),
		]);
		const runner = new ClaudeCodeRunner({
			commands,
			tokens: new Tokens(),
			ids,
			clock: new FixedClockAdapter(),
			verifier,
			runtime: parseClaudeRuntimeFromEnvironment(claudeRuntimeEnvironment),
			controllerEnvironment: {
				HOME: "/srv/agent-factory",
				PATH: "/usr/bin",
				AGENT_FACTORY_GITHUB_APP_ID: "999",
				AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: "/run/credentials/private-key.pem",
				PRIVATE_KEY_CONTENT: "-----BEGIN PRIVATE KEY-----",
				UNRELATED: "must-not-pass",
			},
		});

		const outcome = await runner.launch(implementationRequest);

		expect(outcome).toMatchObject({
			status: "completed",
			reasonCode: null,
			session: {
				provider: "claude",
				id: claudeSessionId,
				model: claudeModel,
				reasoningEffort: claudeEffort,
			},
		});
		expect(ids.calls).toBe(1);
		expect(verifier.calls).toBe(1);
		const command = commands.requests[0];
		expect(command?.argv).toContain(claudeSessionId);
		expect(command?.argv).toContain(claudeModel);
		expect(command?.argv).toContain(claudeEffort);
		expect(command?.argv.join(" ")).not.toContain("fallback");
		expect(command?.cwd).toBe(implementationRequest.checkout.path);
		expect(command?.env).toEqual({
			HOME: "/srv/agent-factory",
			PATH: "/usr/bin",
			GH_PROMPT_DISABLED: "1",
			GH_TOKEN: "short-lived-installation-token",
			GITHUB_TOKEN: "short-lived-installation-token",
			GIT_TERMINAL_PROMPT: "0",
		});
		expect(JSON.stringify(command?.env)).not.toContain("PRIVATE KEY");
		expect(JSON.stringify(command?.env)).not.toContain("AGENT_FACTORY_GITHUB_APP");
		expect(JSON.stringify(command?.env)).not.toContain("UNRELATED");
	});

	test("treats model, effort, or session substitution as launch failure", async () => {
		const commands = new ScriptedCommandAdapter([
			exited(
				lines(
					claudeInitialization({ model: "silent-fallback-model" }),
					resultEvent(workerResult("claude", claudeSessionId)),
				),
			),
		]);
		const runner = new ClaudeCodeRunner({
			commands,
			tokens: new Tokens(),
			ids: new ClaudeIds(),
			clock: new FixedClockAdapter(),
			verifier: new AcceptingVerifier(),
			runtime: parseClaudeRuntimeFromEnvironment(claudeRuntimeEnvironment),
			controllerEnvironment: {},
		});

		const outcome = await runner.launch(implementationRequest);

		expect(outcome).toMatchObject({
			status: "failed",
			reasonCode: "claude-initialization-mismatch",
			session: { id: claudeSessionId, model: claudeModel },
			commandStarted: true,
		});
	});

	test("turns malformed worker results into failed handoffs while preserving the session", async () => {
		const commands = new ScriptedCommandAdapter([
			exited(
				lines(claudeInitialization(), {
					type: "agent_factory.worker_result",
					result: { schemaVersion: 1, malformed: true },
				}),
			),
		]);
		const runner = new ClaudeCodeRunner({
			commands,
			tokens: new Tokens(),
			ids: new ClaudeIds(),
			clock: new FixedClockAdapter(),
			verifier: new AcceptingVerifier(),
			runtime: parseClaudeRuntimeFromEnvironment(claudeRuntimeEnvironment),
			controllerEnvironment: {},
		});

		expect(await runner.launch(implementationRequest)).toMatchObject({
			status: "failed",
			reasonCode: "structured-output-invalid",
			session: { id: claudeSessionId },
			commandStarted: true,
		});
	});

	test("preserves the session in a classified wrapper-death handoff", async () => {
		const commands = new ScriptedCommandAdapter([
			{
				status: "failed",
				classification: "wrapper-death",
				stdout: "",
				stderr: "",
				processId: 77,
			},
		]);
		const runner = new ClaudeCodeRunner({
			commands,
			tokens: new Tokens(),
			ids: new ClaudeIds(),
			clock: new FixedClockAdapter(),
			verifier: new AcceptingVerifier(),
			runtime: parseClaudeRuntimeFromEnvironment(claudeRuntimeEnvironment),
			controllerEnvironment: {},
		});

		expect(await runner.launch(implementationRequest)).toMatchObject({
			status: "failed",
			reasonCode: "command-wrapper-death",
			session: { id: claudeSessionId },
			commandStarted: true,
			processId: 77,
			circuitSignal: null,
		});
	});

	test("turns a structured provider limit into a lane-specific circuit signal", async () => {
		const commands = new ScriptedCommandAdapter([
			exited(
				lines(claudeInitialization(), {
					type: "agent_factory.provider_failure",
					classification: "usage-limit",
					reasonCode: "claude-account-usage-limit",
				}),
			),
		]);
		const runner = new ClaudeCodeRunner({
			commands,
			tokens: new Tokens(),
			ids: new ClaudeIds(),
			clock: new FixedClockAdapter(),
			verifier: new AcceptingVerifier(),
			runtime: parseClaudeRuntimeFromEnvironment(claudeRuntimeEnvironment),
			controllerEnvironment: {},
		});

		expect(await runner.launch(implementationRequest)).toMatchObject({
			status: "failed",
			reasonCode: "claude-account-usage-limit",
			session: { id: claudeSessionId },
			circuitSignal: {
				provider: "claude",
				classification: "usage-limit",
				preserveExecution: true,
			},
		});
	});

	test("preserves the recorded Claude runtime after an environment retune", async () => {
		const runtime = parseClaudeRuntimeFromEnvironment(claudeRuntimeEnvironment);
		const commands = new ScriptedCommandAdapter([
			exited(lines(claudeInitialization(), resultEvent(workerResult("claude", claudeSessionId)))),
		]);
		const runner = new ClaudeCodeRunner({
			commands,
			tokens: new Tokens(),
			ids: new ClaudeIds(),
			clock: new FixedClockAdapter(),
			verifier: new AcceptingVerifier(),
			runtime,
			controllerEnvironment: {},
		});
		const initial = await runner.launch(implementationRequest);
		const captured = initial.session;
		if (captured === null) {
			throw new Error("test expected a captured Claude session");
		}
		const recorded: ResumeProviderSession = {
			...captured,
			sessionKey: "claude-session-key",
			executionId: implementationRequest.executionId,
		};

		const changedCommands = new ScriptedCommandAdapter([
			exited(
				lines(claudeInitialization(), resultEvent(workerResult("claude", claudeSessionId))),
				43,
			),
			exited(
				lines(
					claudeInitialization({ model: "claude-retuned", effort: "max" }),
					resultEvent(workerResult("claude", claudeSessionId)),
				),
			),
		]);
		const changedRunner = new ClaudeCodeRunner({
			commands: changedCommands,
			tokens: new Tokens(),
			ids: new ClaudeIds(),
			clock: new FixedClockAdapter(),
			verifier: new AcceptingVerifier(),
			runtime: { model: "claude-retuned", effort: "max" },
			controllerEnvironment: {},
		});

		const resumed = await changedRunner.resume({
			request: implementationRequest,
			session: recorded,
		});
		const mismatchedInitialization = await changedRunner.resume({
			request: implementationRequest,
			session: recorded,
		});

		expect(resumed.status).toBe("completed");
		expect(changedCommands.requests[0]?.argv).toEqual([
			"--print",
			"--verbose",
			"--input-format",
			"text",
			"--output-format",
			"stream-json",
			"--resume",
			claudeSessionId,
			"--model",
			claudeModel,
			"--effort",
			claudeEffort,
		]);
		expect(mismatchedInitialization).toMatchObject({
			status: "failed",
			reasonCode: "claude-initialization-mismatch",
			commandStarted: true,
		});
		expect(changedCommands.requests[1]?.argv).toEqual(changedCommands.requests[0]?.argv);
	});
});

describe("persistent Codex feedback sessions", () => {
	test("captures the thread before a malformed result and preserves its runtime on resume", async () => {
		const runtime: ProviderRuntime = { model: "gpt-5.6-codex", effort: "high" };
		const commands = new ScriptedCommandAdapter([
			exited(
				lines(
					{ type: "thread.started", thread_id: codexThreadId },
					{
						type: "agent_factory.worker_result",
						result: { schemaVersion: 1, malformed: true },
					},
				),
			),
			exited(
				lines(
					{ type: "thread.started", thread_id: codexThreadId },
					resultEvent(workerResult("codex", codexThreadId)),
				),
			),
			exited(
				lines(
					{ type: "thread.started", thread_id: "retuned-thread" },
					resultEvent(workerResult("codex", codexThreadId)),
				),
			),
		]);
		const runner = new CodexFeedbackRunner({
			commands,
			tokens: new Tokens(),
			clock: new FixedClockAdapter(),
			verifier: new AcceptingVerifier(),
			controllerEnvironment: {},
		});

		const initial = await runner.launch({ request: feedbackRequest, runtime });
		const captured = initial.session;
		if (captured === null) {
			throw new Error("test expected a captured Codex thread");
		}
		const recorded: ResumeProviderSession = {
			...captured,
			sessionKey: "session-key-101",
			executionId: feedbackRequest.executionId,
		};
		const resumed = await runner.resume({
			request: feedbackRequest,
			runtime: { model: "gpt-retuned", effort: "max" },
			session: recorded,
		});
		const mismatchedInitialization = await runner.resume({
			request: feedbackRequest,
			runtime: { model: "gpt-retuned", effort: "max" },
			session: recorded,
		});

		expect(initial).toMatchObject({
			status: "failed",
			reasonCode: "structured-output-invalid",
			session: {
				provider: "codex",
				id: codexThreadId,
				model: runtime.model,
				reasoningEffort: runtime.effort,
			},
		});
		expect(resumed.status).toBe("completed");
		expect(commands.requests[1]?.argv).toEqual([
			"exec",
			"resume",
			codexThreadId,
			"--json",
			"--model",
			runtime.model,
			"--config",
			`model_reasoning_effort="${runtime.effort}"`,
			"-",
		]);
		expect(mismatchedInitialization).toMatchObject({
			status: "failed",
			reasonCode: "codex-thread-mismatch",
			commandStarted: true,
			session: { id: codexThreadId },
		});
		expect(commands.requests).toHaveLength(3);
	});

	test("resumes the exact recorded thread, model, effort, PR, and workflow", async () => {
		const runtime: ProviderRuntime = { model: "gpt-5.6-codex", effort: "high" };
		const verifier = new AcceptingVerifier();
		const commands = new ScriptedCommandAdapter([
			exited(
				lines(
					{ type: "thread.started", thread_id: codexThreadId },
					resultEvent(workerResult("codex", codexThreadId)),
				),
			),
			exited(
				lines(
					{ type: "thread.started", thread_id: codexThreadId },
					resultEvent(workerResult("codex", codexThreadId)),
				),
				43,
			),
		]);
		const runner = new CodexFeedbackRunner({
			commands,
			tokens: new Tokens(),
			clock: new FixedClockAdapter(),
			verifier,
			controllerEnvironment: {},
		});

		const initial = await runner.launch({ request: feedbackRequest, runtime });
		const captured = initial.session;
		if (captured === null) {
			throw new Error("test expected a captured Codex thread");
		}
		const resumed = await runner.resume({
			request: feedbackRequest,
			runtime,
			session: {
				...captured,
				sessionKey: "session-key-101",
				executionId: "earlier-feedback-execution",
			},
		});

		expect(resumed.status).toBe("completed");
		expect(commands.requests).toHaveLength(2);
		expect(commands.requests[1]?.argv).toEqual([
			"exec",
			"resume",
			codexThreadId,
			"--json",
			"--model",
			runtime.model,
			"--config",
			`model_reasoning_effort="${runtime.effort}"`,
			"-",
		]);
		expect(commands.requests[1]?.stdin).toContain(profile.workflow.feedback);
		expect(commands.requests[1]?.stdin).toContain("pull request #101");
	});

	test("reuses the PR thread and recorded runtime for the narrow conflict-repair workflow", async () => {
		const runtime: ProviderRuntime = { model: "gpt-5.6-codex", effort: "high" };
		const commands = new ScriptedCommandAdapter([
			exited(
				lines(
					{ type: "thread.started", thread_id: codexThreadId },
					resultEvent(workerResult("codex", codexThreadId)),
				),
			),
			exited(
				lines(
					{ type: "thread.started", thread_id: codexThreadId },
					resultEvent(workerResult("codex", codexThreadId)),
				),
				43,
			),
		]);
		const runner = new CodexFeedbackRunner({
			commands,
			tokens: new Tokens(),
			clock: new FixedClockAdapter(),
			verifier: new AcceptingVerifier(),
			controllerEnvironment: {},
		});
		const initial = await runner.launch({ request: feedbackRequest, runtime });
		const captured = initial.session;
		if (captured === null) {
			throw new Error("test expected a captured Codex thread");
		}
		const recorded: ResumeProviderSession = {
			...captured,
			sessionKey: "session-key-conflict-repair",
			executionId: feedbackRequest.executionId,
		};
		const repairRequest: ProviderRunRequest = {
			...feedbackRequest,
			executionId: "execution-conflict-repair",
			checkout: {
				...feedbackRequest.checkout,
				workflow: "notes/repair-conflict",
			},
			purpose: "conflict-repair",
			branch: "factory/issue-11",
			initialHeadSha: headSha,
		};

		const resumed = await runner.resume({
			request: repairRequest,
			runtime: { model: "gpt-retuned", effort: "max" },
			session: recorded,
		});
		const unrelatedWorkflow = await runner.resume({
			request: {
				...feedbackRequest,
				checkout: {
					...feedbackRequest.checkout,
					workflow: "notes/unrelated-workflow",
				},
			},
			runtime,
			session: recorded,
		});

		expect(resumed).toMatchObject({
			status: "completed",
			session: {
				id: codexThreadId,
				model: runtime.model,
				reasoningEffort: runtime.effort,
			},
		});
		expect(commands.requests[1]?.argv).toContain(runtime.model);
		expect(commands.requests[1]?.argv).toContain(`model_reasoning_effort="${runtime.effort}"`);
		expect(commands.requests[1]?.stdin).toContain("Forward-merge");
		expect(commands.requests[1]?.stdin).toContain(profile.defaultBranch);
		expect(commands.requests[1]?.stdin).toContain("Resolve merge conflicts only");
		expect(commands.requests[1]?.stdin).toContain("push only the pull-request branch");
		for (const forbidden of [
			"rebase",
			"force-push",
			"amend",
			"merge the pull request",
			"default branch",
		]) {
			expect(commands.requests[1]?.stdin).toContain(forbidden);
		}
		expect(unrelatedWorkflow).toMatchObject({
			status: "failed",
			reasonCode: "resume-session-mismatch",
			commandStarted: false,
		});
		expect(commands.requests).toHaveLength(2);
	});
});

describe("outcome verification, persistence, and circuits", () => {
	test("accepts only identities, branches, PRs, and heads independently observed on GitHub", () => {
		const result = workerResult("codex", codexThreadId);
		const accepted = verifyWorkerResultAgainstObservation({
			request: feedbackRequest,
			provider: "codex",
			providerSessionId: codexThreadId,
			result,
			observation: toControllerObservation(snapshot),
		});
		const rejected = verifyWorkerResultAgainstObservation({
			request: feedbackRequest,
			provider: "codex",
			providerSessionId: codexThreadId,
			result: {
				...result,
				branch: {
					...result.branch,
					headSha: "2222222222222222222222222222222222222222",
				},
			},
			observation: toControllerObservation(snapshot),
		});

		expect(accepted).toEqual({ accepted: true, reasons: [] });
		expect(rejected).toEqual({
			accepted: false,
			reasons: ["head-not-observed"],
		});
	});

	test("records failed handoffs, captured sessions, attempts, and process metadata in SQLite", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-factory-provider-test-"));
		try {
			const state = createInitialControllerState([]);
			state.executions.push({
				executionId: feedbackRequest.executionId,
				projectId: profile.id,
				lane: "feedback",
				provider: "codex",
				workflow: profile.workflow.feedback,
				claimState: "verified",
				issueNumber: 11,
				pullRequestNumber: 101,
				branch: "factory/issue-11",
				worktreeId: "worktree-101",
				headSha,
				status: "active",
			});
			const ids: LedgerIdSource = {
				nextId: (kind) => `${kind}-provider-test`,
			};
			const ledger = openSqliteLedger({
				stateDirectory: directory,
				instanceId: "provider-test-controller",
				clock: new FixedClockAdapter(),
				ids,
				initialState: state,
			});
			try {
				const captured: CapturedProviderSession = {
					provider: "codex",
					id: codexThreadId,
					model: "gpt-5.6-codex",
					reasoningEffort: "high",
					runtimeMetadata: {
						projectId: profile.id,
						repository: profile.repository,
						defaultBranch: profile.defaultBranch,
						workflow: profile.workflow.feedback,
						issueNumber: 11,
						pullRequestNumber: 101,
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

				const recorder = new ProviderExecutionRecorder(ledger);
				await recorder.runInitial(feedbackRequest.executionId, async () => outcome);
				const recovery = ledger.readExecutionRecovery(feedbackRequest.executionId);

				expect(recovery.attempts).toMatchObject([
					{
						status: "failed",
						reasonCode: "worker-result-missing",
					},
				]);
				expect(recovery.sessions).toMatchObject([
					{
						provider: "codex",
						providerSessionId: codexThreadId,
						model: "gpt-5.6-codex",
						reasoningEffort: "high",
					},
				]);
				expect(recovery.process).toMatchObject({
					processId: 77,
					attemptNumber: 1,
					runtimeMetadata: {
						provider: "codex",
						status: "failed",
						preserved: true,
					},
				});

				const session = ledger.findCodexSessionForPullRequest(profile.id, 101);
				if (session === null) {
					throw new Error("test expected the PR-scoped Codex session");
				}
				const ledgerSnapshot = await ledger.read();
				const nextState = structuredClone(ledgerSnapshot.state);
				const previous = nextState.executions[0];
				if (previous === undefined) {
					throw new Error("test expected the prior feedback execution");
				}
				nextState.executions[0] = { ...previous, status: "completed" };
				nextState.executions.push({
					...previous,
					executionId: "execution-102",
					workflow: "notes/repair-conflict",
					status: "active",
				});
				await ledger.commit(ledgerSnapshot.revision, nextState);

				await expect(recorder.runInitial("execution-102", async () => outcome)).rejects.toThrow(
					"pull request already has a Codex outer session",
				);
				const resumedOutcome: ProviderRunOutcome = {
					...outcome,
					session: captured,
					processId: 78,
				};
				await recorder.runResume(
					"execution-102",
					{
						sessionKey: session.sessionKey,
						executionId: session.executionId,
						provider: "codex",
						id: session.providerSessionId,
						model: session.model,
						reasoningEffort: session.reasoningEffort,
						runtimeMetadata: captured.runtimeMetadata,
					},
					async () => resumedOutcome,
				);
				expect(ledger.readExecutionRecovery("execution-102")).toMatchObject({
					attempts: [{ status: "failed", reasonCode: "worker-result-missing" }],
					process: {
						processId: 78,
						runtimeMetadata: {
							provider: "codex",
							providerSessionId: codexThreadId,
							preserved: true,
						},
					},
				});
				expect(
					ledger.findCodexSessionForPullRequest(profile.id, 101)?.lastResumedAt,
				).not.toBeNull();
			} finally {
				ledger.close();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("maps every provider independently to a persisted controller circuit command", () => {
		const signals: ProviderCircuitSignal[] = [
			circuitSignalForFailure("claude", "usage-limit"),
			circuitSignalForFailure("codex", "account-limit"),
			circuitSignalFromGitHubFailure({
				provider: "github",
				projectId: profile.id,
				classification: "server",
				reasonCode: "github-server",
				retryable: true,
				attempts: 3,
				status: 503,
			}),
			circuitSignalForFailure("reviewer", "provider-unavailable"),
		].flatMap((signal) => (signal === null ? [] : [signal]));

		expect(signals.map((signal) => signal.provider)).toEqual([
			"claude",
			"codex",
			"github",
			"reviewer",
		]);
		expect(signals.map(openCircuitCommand)).toEqual([
			{
				type: "set-provider-circuit",
				provider: "claude",
				status: "open",
				reasonCode: "claude-usage-limit",
			},
			{
				type: "set-provider-circuit",
				provider: "codex",
				status: "open",
				reasonCode: "codex-account-limit",
			},
			{
				type: "set-provider-circuit",
				provider: "github",
				status: "open",
				reasonCode: "github-server",
			},
			{
				type: "set-provider-circuit",
				provider: "reviewer",
				status: "open",
				reasonCode: "reviewer-provider-unavailable",
			},
		]);
		expect(circuitSignalForFailure("github", "not-found")).toBeNull();
	});

	test("allows resume only after a matching verified recovery probe", async () => {
		const state: ControllerLocalState["circuits"]["claude"] = {
			status: "open",
			reasonCode: "claude-usage-limit",
		};
		const unverified = new ProviderCircuitRecovery({
			probe: async () => ({ provider: "claude", recovered: true, verified: false }),
		});
		const unhealthy = new ProviderCircuitRecovery({
			probe: async () => ({ provider: "claude", recovered: false, verified: true }),
		});
		const recovered = new ProviderCircuitRecovery({
			probe: async () => ({ provider: "claude", recovered: true, verified: true }),
		});

		expect(await unverified.assessResume("claude", state)).toMatchObject({
			allowed: false,
			reason: "probe-unverified",
		});
		expect(await unhealthy.assessResume("claude", state)).toMatchObject({
			allowed: false,
			reason: "circuit-open",
		});
		expect(await recovered.assessResume("claude", state)).toEqual({
			allowed: true,
			command: {
				type: "set-provider-circuit",
				provider: "claude",
				status: "closed",
				reasonCode: null,
			},
		});
	});
});
