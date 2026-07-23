import type { ProviderFailureClassification } from "@/contracts/provider-output.ts";
import type { ControllerLocalState, Provider } from "@/controller/model.ts";
import type { GitHubCircuitFailureSignal } from "@/github/index.ts";
import type { ProviderCircuitSignal } from "@/providers/types.ts";

const CIRCUIT_OPENING_FAILURES: ReadonlySet<ProviderFailureClassification> = new Set([
	"account-limit",
	"authentication",
	"authorization",
	"invalid-response",
	"provider-unavailable",
	"rate-limit",
	"server",
	"timeout",
	"transport",
	"usage-limit",
	"validation",
]);

export interface ProviderCircuitCommand {
	readonly type: "set-provider-circuit";
	readonly provider: Provider;
	readonly status: "closed" | "open";
	readonly reasonCode: string | null;
}

export interface ProviderRecoveryProbeResult {
	readonly provider: Provider;
	readonly recovered: boolean;
	readonly verified: boolean;
}

export interface ProviderRecoveryProbe {
	probe(provider: Provider): Promise<ProviderRecoveryProbeResult>;
}

export type CircuitResumeDecision =
	| {
			readonly allowed: true;
			readonly command: ProviderCircuitCommand | null;
	  }
	| {
			readonly allowed: false;
			readonly command: null;
			readonly reason: "circuit-open" | "probe-failed" | "probe-unverified";
	  };

export function circuitSignalForFailure(
	provider: Provider,
	classification: ProviderFailureClassification,
	reasonCode = `${provider}-${classification}`,
): ProviderCircuitSignal | null {
	if (!CIRCUIT_OPENING_FAILURES.has(classification)) {
		return null;
	}
	return {
		provider,
		classification,
		reasonCode,
		preserveExecution: true,
	};
}

export function circuitSignalFromGitHubFailure(
	failure: GitHubCircuitFailureSignal,
): ProviderCircuitSignal | null {
	return circuitSignalForFailure("github", failure.classification, failure.reasonCode);
}

export function openCircuitCommand(signal: ProviderCircuitSignal): ProviderCircuitCommand {
	return {
		type: "set-provider-circuit",
		provider: signal.provider,
		status: "open",
		reasonCode: signal.reasonCode,
	};
}

export class ProviderCircuitRecovery {
	readonly #probe: ProviderRecoveryProbe;

	public constructor(probe: ProviderRecoveryProbe) {
		this.#probe = probe;
	}

	public async assessResume(
		provider: Provider,
		state: ControllerLocalState["circuits"][Provider],
	): Promise<CircuitResumeDecision> {
		if (state.status === "closed") {
			return { allowed: true, command: null };
		}

		let result: ProviderRecoveryProbeResult;
		try {
			result = await this.#probe.probe(provider);
		} catch {
			return { allowed: false, command: null, reason: "probe-failed" };
		}
		if (result.provider !== provider || !result.verified) {
			return { allowed: false, command: null, reason: "probe-unverified" };
		}
		if (!result.recovered) {
			return { allowed: false, command: null, reason: "circuit-open" };
		}
		return {
			allowed: true,
			command: {
				type: "set-provider-circuit",
				provider,
				status: "closed",
				reasonCode: null,
			},
		};
	}
}
