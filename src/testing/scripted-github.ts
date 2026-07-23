import type {
  DelayAdapter,
  GitHubHttpRequest,
  GitHubHttpResponse,
  GitHubHttpTransport,
} from "../adapters/interfaces";

export type ScriptedGitHubStep =
  | {
      readonly kind: "response";
      readonly response: GitHubHttpResponse;
    }
  | {
      readonly kind: "error";
      readonly error: "timeout" | "transport";
    };

export class ScriptedGitHubTransport implements GitHubHttpTransport {
  readonly #steps: ScriptedGitHubStep[] = [];
  public readonly requests: GitHubHttpRequest[] = [];

  public constructor(steps: readonly ScriptedGitHubStep[] = []) {
    this.#steps.push(...structuredClone(steps));
  }

  public async request(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(structuredClone(request));
    const step = this.#steps.shift();
    if (step === undefined) {
      throw new Error("scripted GitHub transport has no remaining response");
    }
    if (step.kind === "response") {
      return structuredClone(step.response);
    }
    if (step.error === "timeout") {
      const error = new Error("scripted timeout");
      error.name = "AbortError";
      throw error;
    }
    throw new Error("scripted transport failure");
  }

  public get remainingSteps(): number {
    return this.#steps.length;
  }
}

export class RecordingDelayAdapter implements DelayAdapter {
  public readonly waits: number[] = [];

  public async wait(milliseconds: number): Promise<void> {
    this.waits.push(milliseconds);
  }
}
