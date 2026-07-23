import type { ClockAdapter, CommandAdapter } from "../adapters/interfaces";
import {
  type ClaudeInitializationEvent,
  ClaudeInitializationEventSchema,
  ProviderOutputError,
} from "../contracts/provider-output";
import type { ClaudeRuntimeConfig } from "../controller/config";
import {
  completeProviderOutcome,
  executeProviderCommand,
  failedProviderOutcome,
  parseCommonProviderEvents,
  resumeContextMatches,
  sessionMetadata,
} from "./runner-support";
import {
  type CapturedProviderSession,
  type ClaudeSessionIdSource,
  type ProviderRunOutcome,
  type ProviderRunRequest,
  ProviderRunRequestSchema,
  type ResumeProviderSession,
  type WorkerOutcomeVerifier,
  type WorkerTokenBroker,
} from "./types";

export interface ClaudeRunnerOptions {
  readonly commands: CommandAdapter;
  readonly tokens: WorkerTokenBroker;
  readonly ids: ClaudeSessionIdSource;
  readonly clock: ClockAdapter;
  readonly verifier: WorkerOutcomeVerifier;
  readonly runtime: ClaudeRuntimeConfig;
  readonly controllerEnvironment: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
}

export interface ClaudeResumeRequest {
  readonly request: ProviderRunRequest;
  readonly session: ResumeProviderSession;
}

export class ClaudeCodeRunner {
  readonly #commands: CommandAdapter;
  readonly #tokens: WorkerTokenBroker;
  readonly #ids: ClaudeSessionIdSource;
  readonly #clock: ClockAdapter;
  readonly #verifier: WorkerOutcomeVerifier;
  readonly #runtime: ClaudeRuntimeConfig;
  readonly #controllerEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #executable: string;

  public constructor(options: ClaudeRunnerOptions) {
    this.#commands = options.commands;
    this.#tokens = options.tokens;
    this.#ids = options.ids;
    this.#clock = options.clock;
    this.#verifier = options.verifier;
    this.#runtime = options.runtime;
    this.#controllerEnvironment = options.controllerEnvironment;
    this.#executable = options.executable ?? "claude";
    if (this.#executable.length === 0 || /[\0\r\n]/u.test(this.#executable)) {
      throw new Error("Claude executable is invalid");
    }
  }

  public async launch(input: unknown): Promise<ProviderRunOutcome> {
    const request = ProviderRunRequestSchema.parse(input);
    this.#assertImplementationRequest(request);
    const sessionId = ClaudeInitializationEventSchema.shape.session_id.parse(
      this.#ids.nextClaudeSessionId(),
    );
    const session: CapturedProviderSession = {
      provider: "claude",
      id: sessionId,
      model: this.#runtime.model,
      reasoningEffort: this.#runtime.effort,
      runtimeMetadata: sessionMetadata(request),
    };
    return this.#execute(request, session, [
      "--print",
      "--verbose",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--session-id",
      session.id,
      "--model",
      session.model,
      "--effort",
      session.reasoningEffort,
    ]);
  }

  public async resume(input: ClaudeResumeRequest): Promise<ProviderRunOutcome> {
    const request = ProviderRunRequestSchema.parse(input.request);
    this.#assertImplementationRequest(request);
    const session = input.session;
    if (
      session.provider !== "claude" ||
      session.executionId !== request.executionId ||
      session.model !== this.#runtime.model ||
      session.reasoningEffort !== this.#runtime.effort
    ) {
      return failedProviderOutcome({
        provider: "claude",
        reasonCode: "resume-runtime-mismatch",
        session,
        commandStarted: false,
        processStartedAt: null,
      });
    }
    if (
      !ClaudeInitializationEventSchema.shape.session_id.safeParse(session.id).success ||
      !resumeContextMatches(request, session)
    ) {
      return failedProviderOutcome({
        provider: "claude",
        reasonCode: "resume-session-mismatch",
        session,
        commandStarted: false,
        processStartedAt: null,
      });
    }
    return this.#execute(request, session, [
      "--print",
      "--verbose",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--resume",
      session.id,
      "--model",
      session.model,
      "--effort",
      session.reasoningEffort,
    ]);
  }

  #assertImplementationRequest(request: ProviderRunRequest): void {
    if (request.issueNumber !== null || request.pullRequestNumber !== null) {
      throw new Error("Claude implementation execution must not receive a preselected issue or PR");
    }
  }

  async #execute(
    request: ProviderRunRequest,
    session: CapturedProviderSession,
    argv: readonly string[],
  ): Promise<ProviderRunOutcome> {
    const command = await executeProviderCommand({
      provider: "claude",
      request,
      session,
      commands: this.#commands,
      tokens: this.#tokens,
      clock: this.#clock,
      controllerEnvironment: this.#controllerEnvironment,
      executable: this.#executable,
      argv,
    });
    if (!command.ok) {
      return command.outcome;
    }
    const { commandResult, processStartedAt } = command;

    let events: ReturnType<typeof parseCommonProviderEvents>;
    try {
      events = parseCommonProviderEvents(commandResult.stdout);
    } catch (error) {
      const reasonCode =
        error instanceof ProviderOutputError
          ? "structured-output-invalid"
          : "structured-output-error";
      return failedProviderOutcome({
        provider: "claude",
        reasonCode,
        session,
        commandStarted: true,
        processStartedAt,
        commandResult,
      });
    }

    const initializations = events.events.filter(
      (event): event is ClaudeInitializationEvent =>
        event.type === "system" && event.subtype === "init",
    );
    const initialization = initializations[0];
    if (
      initializations.length !== 1 ||
      initialization === undefined ||
      initialization.session_id !== session.id ||
      initialization.model !== session.model ||
      initialization.effort !== session.reasoningEffort
    ) {
      return failedProviderOutcome({
        provider: "claude",
        reasonCode: "claude-initialization-mismatch",
        session,
        commandStarted: true,
        processStartedAt,
        commandResult,
      });
    }

    return completeProviderOutcome({
      provider: "claude",
      request,
      session,
      commandResult,
      processStartedAt,
      events,
      verifier: this.#verifier,
    });
  }
}
