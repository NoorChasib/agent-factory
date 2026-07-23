import type { ClockAdapter, CommandAdapter, CommandExecutionResult } from "../adapters/interfaces";
import { parseCommandExecutionResult } from "../contracts/command-result";
import {
  type CodexThreadStartedEvent,
  CodexThreadStartedEventSchema,
  ProviderOutputError,
} from "../contracts/provider-output";
import { circuitSignalForFailure } from "./circuits";
import { buildWorkerEnvironment } from "./environment";
import {
  clockTimestamp,
  completeProviderOutcome,
  failedProviderOutcome,
  parseCommonProviderEvents,
  workflowPrompt,
} from "./runner-support";
import {
  type CapturedProviderSession,
  type ProviderRunOutcome,
  type ProviderRunRequest,
  ProviderRunRequestSchema,
  type ProviderRuntime,
  ProviderRuntimeSchema,
  type ProviderSessionContext,
  type ResumeProviderSession,
  type WorkerOutcomeVerifier,
  type WorkerTokenBroker,
} from "./types";

export interface CodexRunnerOptions {
  readonly commands: CommandAdapter;
  readonly tokens: WorkerTokenBroker;
  readonly clock: ClockAdapter;
  readonly verifier: WorkerOutcomeVerifier;
  readonly controllerEnvironment: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
}

export interface CodexLaunchRequest {
  readonly request: ProviderRunRequest;
  readonly runtime: ProviderRuntime;
}

export interface CodexResumeRequest extends CodexLaunchRequest {
  readonly session: ResumeProviderSession;
}

function sessionMetadata(request: ProviderRunRequest): ProviderSessionContext {
  return {
    projectId: request.checkout.projectId,
    repository: request.checkout.repository,
    defaultBranch: request.checkout.defaultBranch,
    workflow: request.checkout.workflow,
    issueNumber: request.issueNumber,
    pullRequestNumber: request.pullRequestNumber,
  };
}

function resumeContextMatches(
  request: ProviderRunRequest,
  session: ResumeProviderSession,
): boolean {
  const metadata = session.runtimeMetadata;
  return (
    metadata.projectId === request.checkout.projectId &&
    metadata.repository === request.checkout.repository &&
    metadata.defaultBranch === request.checkout.defaultBranch &&
    metadata.workflow === request.checkout.workflow &&
    metadata.issueNumber === request.issueNumber &&
    metadata.pullRequestNumber === request.pullRequestNumber
  );
}

function bestEffortThread(stdout: string): string | null {
  const threadIds = stdout.split(/\r?\n/u).flatMap((line): string[] => {
    if (line.trim().length === 0) {
      return [];
    }
    try {
      const parsed = CodexThreadStartedEventSchema.safeParse(JSON.parse(line) as unknown);
      return parsed.success ? [parsed.data.thread_id] : [];
    } catch {
      return [];
    }
  });
  return threadIds.length === 1 ? (threadIds[0] ?? null) : null;
}

export class CodexFeedbackRunner {
  readonly #commands: CommandAdapter;
  readonly #tokens: WorkerTokenBroker;
  readonly #clock: ClockAdapter;
  readonly #verifier: WorkerOutcomeVerifier;
  readonly #controllerEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #executable: string;

  public constructor(options: CodexRunnerOptions) {
    this.#commands = options.commands;
    this.#tokens = options.tokens;
    this.#clock = options.clock;
    this.#verifier = options.verifier;
    this.#controllerEnvironment = options.controllerEnvironment;
    this.#executable = options.executable ?? "codex";
    if (this.#executable.length === 0 || /[\0\r\n]/u.test(this.#executable)) {
      throw new Error("Codex executable is invalid");
    }
  }

  public async launch(input: CodexLaunchRequest): Promise<ProviderRunOutcome> {
    const request = ProviderRunRequestSchema.parse(input.request);
    const runtime = ProviderRuntimeSchema.parse(input.runtime);
    this.#assertFeedbackRequest(request);
    return this.#execute(request, runtime, null, [
      "exec",
      "--json",
      "--model",
      runtime.model,
      "--config",
      `model_reasoning_effort="${runtime.effort}"`,
      "-",
    ]);
  }

  public async resume(input: CodexResumeRequest): Promise<ProviderRunOutcome> {
    const request = ProviderRunRequestSchema.parse(input.request);
    const runtime = ProviderRuntimeSchema.parse(input.runtime);
    const session = input.session;
    this.#assertFeedbackRequest(request);
    if (
      session.provider !== "codex" ||
      session.model !== runtime.model ||
      session.reasoningEffort !== runtime.effort
    ) {
      return failedProviderOutcome({
        provider: "codex",
        reasonCode: "resume-runtime-mismatch",
        session,
        commandStarted: false,
        processStartedAt: null,
      });
    }
    if (
      !CodexThreadStartedEventSchema.shape.thread_id.safeParse(session.id).success ||
      !resumeContextMatches(request, session)
    ) {
      return failedProviderOutcome({
        provider: "codex",
        reasonCode: "resume-session-mismatch",
        session,
        commandStarted: false,
        processStartedAt: null,
      });
    }
    return this.#execute(request, runtime, session, [
      "exec",
      "resume",
      session.id,
      "--json",
      "--model",
      session.model,
      "--config",
      `model_reasoning_effort="${session.reasoningEffort}"`,
      "-",
    ]);
  }

  #assertFeedbackRequest(request: ProviderRunRequest): void {
    if (request.issueNumber === null || request.pullRequestNumber === null) {
      throw new Error("Codex feedback execution must identify one issue and pull request");
    }
  }

  async #execute(
    request: ProviderRunRequest,
    runtime: ProviderRuntime,
    recordedSession: ResumeProviderSession | null,
    argv: readonly string[],
  ): Promise<ProviderRunOutcome> {
    let token: string;
    try {
      token = await this.#tokens.tokenForProject(request.checkout.projectId);
    } catch {
      return failedProviderOutcome({
        provider: "codex",
        reasonCode: "github-token-unavailable",
        session: recordedSession,
        commandStarted: false,
        processStartedAt: null,
        circuitSignal: circuitSignalForFailure(
          "github",
          "provider-unavailable",
          "github-token-unavailable",
        ),
      });
    }

    let environment: Readonly<Record<string, string>>;
    try {
      environment = buildWorkerEnvironment(this.#controllerEnvironment, token);
    } catch {
      return failedProviderOutcome({
        provider: "codex",
        reasonCode: "worker-environment-invalid",
        session: recordedSession,
        commandStarted: false,
        processStartedAt: null,
      });
    }

    const processStartedAt = clockTimestamp(this.#clock);
    let commandResult: CommandExecutionResult;
    try {
      commandResult = parseCommandExecutionResult(
        await this.#commands.execute({
          executable: this.#executable,
          argv,
          cwd: request.checkout.path,
          env: environment,
          stdin: workflowPrompt(request),
          stdout: "capture-json-lines",
          stderr: "capture",
        }),
      );
    } catch {
      return failedProviderOutcome({
        provider: "codex",
        reasonCode: "command-adapter-error",
        session: recordedSession,
        commandStarted: true,
        processStartedAt,
      });
    }

    let events: ReturnType<typeof parseCommonProviderEvents>;
    try {
      events = parseCommonProviderEvents(commandResult.stdout);
    } catch (error) {
      const capturedId = recordedSession?.id ?? bestEffortThread(commandResult.stdout);
      const capturedSession =
        capturedId === null
          ? recordedSession
          : {
              provider: "codex" as const,
              id: capturedId,
              model: runtime.model,
              reasoningEffort: runtime.effort,
              runtimeMetadata: sessionMetadata(request),
            };
      const reasonCode =
        error instanceof ProviderOutputError
          ? "structured-output-invalid"
          : "structured-output-error";
      const circuitSignal =
        commandResult.status === "failed" &&
        (commandResult.classification === "timeout" || commandResult.classification === "transport")
          ? circuitSignalForFailure("codex", commandResult.classification)
          : null;
      return failedProviderOutcome({
        provider: "codex",
        reasonCode,
        session: capturedSession,
        commandStarted: true,
        processStartedAt,
        commandResult,
        circuitSignal,
      });
    }

    const threadEvents = events.events.filter(
      (event): event is CodexThreadStartedEvent => event.type === "thread.started",
    );
    const thread = threadEvents[0];
    const expectedId = recordedSession?.id;
    if (
      threadEvents.length !== 1 ||
      thread === undefined ||
      (expectedId !== undefined && thread.thread_id !== expectedId)
    ) {
      const circuitSignal =
        events.providerFailure === null
          ? null
          : circuitSignalForFailure(
              "codex",
              events.providerFailure.classification,
              events.providerFailure.reasonCode,
            );
      return failedProviderOutcome({
        provider: "codex",
        reasonCode: "codex-thread-mismatch",
        session: recordedSession,
        commandStarted: true,
        processStartedAt,
        commandResult,
        circuitSignal,
      });
    }
    const session: CapturedProviderSession = recordedSession ?? {
      provider: "codex",
      id: thread.thread_id,
      model: runtime.model,
      reasoningEffort: runtime.effort,
      runtimeMetadata: sessionMetadata(request),
    };

    return completeProviderOutcome({
      provider: "codex",
      request,
      session,
      commandResult,
      processStartedAt,
      events,
      verifier: this.#verifier,
    });
  }
}
