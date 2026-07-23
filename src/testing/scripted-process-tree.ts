import type { ProcessIdentity, ProcessTreeAdapter } from "@/adapters/interfaces.ts";

export interface ScriptedProcessTreeStep {
	readonly rootProcessId: number;
	readonly tree: readonly ProcessIdentity[];
}

export class ScriptedProcessTreeAdapter implements ProcessTreeAdapter {
	readonly #steps: ScriptedProcessTreeStep[];
	public readonly inspections: number[] = [];

	public constructor(steps: readonly ScriptedProcessTreeStep[]) {
		this.#steps = structuredClone([...steps]);
	}

	public async inspectTree(rootProcessId: number): Promise<readonly ProcessIdentity[]> {
		this.inspections.push(rootProcessId);
		const step = this.#steps.shift();
		if (step === undefined) {
			throw new Error("scripted process-tree adapter has no remaining step");
		}
		if (step.rootProcessId !== rootProcessId) {
			throw new Error(
				`expected process-tree inspection for ${step.rootProcessId}, received ${rootProcessId}`,
			);
		}
		return structuredClone(step.tree);
	}

	public remaining(): number {
		return this.#steps.length;
	}
}
