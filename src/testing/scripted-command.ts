import type {
	CommandAdapter,
	CommandExecutionResult,
	CommandRequest,
} from "../adapters/interfaces";

export class ScriptedCommandAdapter implements CommandAdapter {
	readonly #steps: CommandExecutionResult[];
	public readonly requests: CommandRequest[] = [];

	public constructor(steps: readonly CommandExecutionResult[]) {
		this.#steps = structuredClone([...steps]);
	}

	public async execute(request: CommandRequest): Promise<CommandExecutionResult> {
		this.requests.push(structuredClone(request));
		const step = this.#steps.shift();
		if (step === undefined) {
			throw new Error("scripted command adapter has no remaining step");
		}
		return structuredClone(step);
	}

	public remaining(): number {
		return this.#steps.length;
	}
}
