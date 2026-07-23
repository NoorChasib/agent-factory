import { z } from "zod";
import {
	looseBranch,
	projectId,
	repository,
	safeId,
	workflowEntryPoint,
} from "@/contracts/primitives.ts";
import type { ProviderFailureClassification } from "@/contracts/provider-output.ts";
import type { WorkerResult, WorkerTerminalStatus } from "@/contracts/worker-result.ts";
import type { Provider } from "@/controller/model.ts";

export const ProviderRuntimeSchema = z.strictObject({
	model: safeId,
	effort: z.enum(["low", "medium", "high", "max"]),
});
export type ProviderRuntime = z.infer<typeof ProviderRuntimeSchema>;

export const PreparedCheckoutSchema = z.strictObject({
	path: z
		.string()
		.min(2)
		.max(4_096)
		.startsWith("/")
		.refine((value) => !/[\0\r\n]/u.test(value), "checkout path contains a control character"),
	projectId,
	repository,
	defaultBranch: looseBranch,
	workflow: workflowEntryPoint,
});
export type PreparedCheckout = z.infer<typeof PreparedCheckoutSchema>;

export const ProviderRunRequestSchema = z.strictObject({
	executionId: safeId,
	checkout: PreparedCheckoutSchema,
	issueNumber: z.number().int().positive().nullable(),
	pullRequestNumber: z.number().int().positive().nullable(),
});
export type ProviderRunRequest = z.infer<typeof ProviderRunRequestSchema>;

export const ProviderSessionContextSchema = z.strictObject({
	projectId,
	repository,
	defaultBranch: looseBranch,
	workflow: workflowEntryPoint,
	issueNumber: z.number().int().positive().nullable(),
	pullRequestNumber: z.number().int().positive().nullable(),
});
export type ProviderSessionContext = z.infer<typeof ProviderSessionContextSchema>;

export interface WorkerTokenBroker {
	tokenForProject(projectId: string): Promise<string>;
}

export interface ClaudeSessionIdSource {
	nextClaudeSessionId(): string;
}

export interface CapturedProviderSession {
	readonly provider: "claude" | "codex";
	readonly id: string;
	readonly model: string;
	readonly reasoningEffort: string;
	readonly runtimeMetadata: ProviderSessionContext;
}

export interface ResumeProviderSession extends CapturedProviderSession {
	readonly sessionKey: string;
	readonly executionId: string;
}

export interface ProviderCircuitSignal {
	readonly provider: Provider;
	readonly classification: ProviderFailureClassification;
	readonly reasonCode: string;
	readonly preserveExecution: true;
}

export type WorkerOutcomeVerification =
	| {
			readonly accepted: true;
			readonly reasons: readonly [];
	  }
	| {
			readonly accepted: false;
			readonly reasons: readonly string[];
	  };

export interface WorkerOutcomeVerifier {
	verify(input: {
		readonly request: ProviderRunRequest;
		readonly provider: "claude" | "codex";
		readonly providerSessionId: string;
		readonly result: WorkerResult;
	}): Promise<WorkerOutcomeVerification>;
}

export interface ProviderRunOutcome {
	readonly provider: "claude" | "codex";
	readonly status: WorkerTerminalStatus;
	readonly reasonCode: string | null;
	readonly session: CapturedProviderSession | null;
	readonly workerResult: WorkerResult | null;
	readonly verification: WorkerOutcomeVerification | null;
	readonly circuitSignal: ProviderCircuitSignal | null;
	readonly commandStarted: boolean;
	readonly processId: number | null;
	readonly processStartedAt: string | null;
	readonly exitCode: number | null;
}
