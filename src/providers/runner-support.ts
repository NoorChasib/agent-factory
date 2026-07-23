import type { ClockAdapter, CommandAdapter, CommandExecutionResult } from "../adapters/interfaces";
import { parseCommandExecutionResult } from "../contracts/command-result";
import {
  type ProviderFailureEvent,
  ProviderOutputError,
  parseProviderStructuredOutput,
  type WorkerResultEvent,
} from "../contracts/provider-output";
import type { WorkerResult } from "../contracts/worker-result";
import { circuitSignalForFailure } from "./circuits";
import { buildWorkerEnvironment } from "./environment";
import type {
  CapturedProviderSession,
  ProviderRunOutcome,
  ProviderRunRequest,
  ProviderSessionContext,
  ResumeProviderSession,
  WorkerOutcomeVerification,
  WorkerOutcomeVerifier,
  WorkerTokenBroker,
} from "./types";

export interface CommonProviderEvents {
  readonly workerResult: WorkerResult | null;
  readonly providerFailure: ProviderFailureEvent | null;
  readonly events: ReturnType<typeof parseProviderStructuredOutput>["events"];
}

export function clockTimestamp(clock: ClockAdapter): string {
  const now = clock.now();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("provider runner clock returned an invalid date");
  }
  return now.toISOString();
}

export function workflowPrompt(request: ProviderRunRequest): string {
  const subject =
    request.pullRequestNumber === null
      ? "Select and claim work according to the project workflow; no issue was preselected."
      : `Converge pull request #${request.pullRequestNumber} for issue #${request.issueNumber}.`;
  return [
    `Run the target-owned workflow entry point '${request.checkout.workflow}' autonomously.`,
    `Factory execution: ${request.executionId}. ${subject}`,
    "Do not merge, rewrite history, bypass branch protection, or ask an interactive question.",
    "Finish by emitting one JSON-lines record with type 'agent_factory.worker_result' and a v1 WorkerResult in its 'result' field.",
  ].join("\n");
}

export function sessionMetadata(request: ProviderRunRequest): ProviderSessionContext {
  return {
    projectId: request.checkout.projectId,
    repository: request.checkout.repository,
    defaultBranch: request.checkout.defaultBranch,
    workflow: request.checkout.workflow,
    issueNumber: request.issueNumber,
    pullRequestNumber: request.pullRequestNumber,
  };
}

export function resumeContextMatches(
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

export type ProviderCommandPreamble =
  | {
      readonly ok: true;
      readonly commandResult: CommandExecutionResult & { readonly status: "exited" };
      readonly processStartedAt: string;
    }
  | {
      readonly ok: false;
      readonly outcome: ProviderRunOutcome;
    };

export async function executeProviderCommand(input: {
  readonly provider: "claude" | "codex";
  readonly request: ProviderRunRequest;
  readonly session: CapturedProviderSession | null;
  readonly commands: CommandAdapter;
  readonly tokens: WorkerTokenBroker;
  readonly clock: ClockAdapter;
  readonly controllerEnvironment: Readonly<Record<string, string | undefined>>;
  readonly executable: string;
  readonly argv: readonly string[];
}): Promise<ProviderCommandPreamble> {
  let token: string;
  try {
    token = await input.tokens.tokenForProject(input.request.checkout.projectId);
  } catch {
    return {
      ok: false,
      outcome: failedProviderOutcome({
        provider: input.provider,
        reasonCode: "github-token-unavailable",
        session: input.session,
        commandStarted: false,
        processStartedAt: null,
        circuitSignal: circuitSignalForFailure(
          "github",
          "provider-unavailable",
          "github-token-unavailable",
        ),
      }),
    };
  }

  let environment: Readonly<Record<string, string>>;
  try {
    environment = buildWorkerEnvironment(input.controllerEnvironment, token);
  } catch {
    return {
      ok: false,
      outcome: failedProviderOutcome({
        provider: input.provider,
        reasonCode: "worker-environment-invalid",
        session: input.session,
        commandStarted: false,
        processStartedAt: null,
      }),
    };
  }

  const processStartedAt = clockTimestamp(input.clock);
  let commandResult: CommandExecutionResult;
  try {
    commandResult = parseCommandExecutionResult(
      await input.commands.execute({
        executable: input.executable,
        argv: input.argv,
        cwd: input.request.checkout.path,
        env: environment,
        stdin: workflowPrompt(input.request),
        stdout: "capture-json-lines",
        stderr: "capture",
      }),
    );
  } catch {
    return {
      ok: false,
      outcome: failedProviderOutcome({
        provider: input.provider,
        reasonCode: "command-adapter-error",
        session: input.session,
        commandStarted: true,
        processStartedAt,
      }),
    };
  }
  if (commandResult.status === "failed") {
    const circuitSignal =
      commandResult.classification === "timeout" || commandResult.classification === "transport"
        ? circuitSignalForFailure(input.provider, commandResult.classification)
        : null;
    return {
      ok: false,
      outcome: failedProviderOutcome({
        provider: input.provider,
        reasonCode: `command-${commandResult.classification}`,
        session: input.session,
        commandStarted: true,
        processStartedAt,
        commandResult,
        circuitSignal,
      }),
    };
  }
  return { ok: true, commandResult, processStartedAt };
}

export function parseCommonProviderEvents(stdout: string): CommonProviderEvents {
  const output = parseProviderStructuredOutput(stdout);
  const workerResults = output.events.filter(
    (event): event is WorkerResultEvent => event.type === "agent_factory.worker_result",
  );
  if (workerResults.length > 1) {
    throw new ProviderOutputError("structured provider output contains multiple worker results");
  }
  const providerFailures = output.events.filter(
    (event): event is ProviderFailureEvent => event.type === "agent_factory.provider_failure",
  );
  if (providerFailures.length > 1) {
    throw new ProviderOutputError("structured provider output contains multiple provider failures");
  }
  return {
    workerResult: workerResults[0]?.result ?? null,
    providerFailure: providerFailures[0] ?? null,
    events: output.events,
  };
}

export function failedProviderOutcome(input: {
  readonly provider: "claude" | "codex";
  readonly reasonCode: string;
  readonly session: CapturedProviderSession | null;
  readonly commandStarted: boolean;
  readonly processStartedAt: string | null;
  readonly commandResult?: CommandExecutionResult;
  readonly circuitSignal?: ProviderRunOutcome["circuitSignal"];
}): ProviderRunOutcome {
  return {
    provider: input.provider,
    status: "failed",
    reasonCode: input.reasonCode,
    session: input.session,
    workerResult: null,
    verification: null,
    circuitSignal: input.circuitSignal ?? null,
    commandStarted: input.commandStarted,
    processId: input.commandResult?.processId ?? null,
    processStartedAt: input.processStartedAt,
    exitCode: input.commandResult?.status === "exited" ? input.commandResult.exitCode : null,
  };
}

export async function completeProviderOutcome(input: {
  readonly provider: "claude" | "codex";
  readonly request: ProviderRunRequest;
  readonly session: CapturedProviderSession;
  readonly commandResult: CommandExecutionResult & { readonly status: "exited" };
  readonly processStartedAt: string;
  readonly events: CommonProviderEvents;
  readonly verifier: WorkerOutcomeVerifier;
}): Promise<ProviderRunOutcome> {
  const { commandResult, events, provider, request, session } = input;
  if (events.providerFailure !== null) {
    return failedProviderOutcome({
      provider,
      reasonCode: events.providerFailure.reasonCode,
      session,
      commandStarted: true,
      processStartedAt: input.processStartedAt,
      commandResult,
      circuitSignal: circuitSignalForFailure(
        provider,
        events.providerFailure.classification,
        events.providerFailure.reasonCode,
      ),
    });
  }
  if (commandResult.exitCode !== 0) {
    return failedProviderOutcome({
      provider,
      reasonCode: "worker-process-exit",
      session,
      commandStarted: true,
      processStartedAt: input.processStartedAt,
      commandResult,
    });
  }
  if (events.workerResult === null) {
    return failedProviderOutcome({
      provider,
      reasonCode: "worker-result-missing",
      session,
      commandStarted: true,
      processStartedAt: input.processStartedAt,
      commandResult,
    });
  }

  let verification: WorkerOutcomeVerification;
  try {
    verification = await input.verifier.verify({
      request,
      provider,
      providerSessionId: session.id,
      result: events.workerResult,
    });
  } catch {
    return failedProviderOutcome({
      provider,
      reasonCode: "outcome-verification-unavailable",
      session,
      commandStarted: true,
      processStartedAt: input.processStartedAt,
      commandResult,
      circuitSignal: circuitSignalForFailure(
        "github",
        "provider-unavailable",
        "outcome-verification-unavailable",
      ),
    });
  }
  if (!verification.accepted) {
    return {
      ...failedProviderOutcome({
        provider,
        reasonCode: "outcome-verification-failed",
        session,
        commandStarted: true,
        processStartedAt: input.processStartedAt,
        commandResult,
      }),
      workerResult: events.workerResult,
      verification,
    };
  }

  const circuitSignal =
    events.workerResult.terminalStatus === "provider_limit"
      ? circuitSignalForFailure(provider, "usage-limit", `${provider}-provider-limit`)
      : null;
  return {
    provider,
    status: events.workerResult.terminalStatus,
    reasonCode:
      events.workerResult.terminalStatus === "completed"
        ? null
        : events.workerResult.checkpoint.code,
    session,
    workerResult: events.workerResult,
    verification,
    circuitSignal,
    commandStarted: true,
    processId: commandResult.processId,
    processStartedAt: input.processStartedAt,
    exitCode: commandResult.exitCode,
  };
}
