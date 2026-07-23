import type {
	ClockAdapter,
	ControllerAdapters,
	FileMetadata,
	FileSystemAdapter,
	GitHubAdapter,
	LedgerAdapter,
	Notification,
	NotificationAdapter,
	RandomAdapter,
	WorkerProcessAdapter,
} from "@/adapters/interfaces.ts";
import type { ProjectProfile } from "@/contracts/project-profile.ts";
import {
	type ConflictRepairHandoffRequest,
	type ControllerLocalState,
	ControllerLocalStateSchema,
	type ExecutionRecord,
	ExecutionRecordSchema,
	type GitHubProjectObservation,
	GitHubProjectObservationSchema,
	type LaunchRequest,
	type LedgerSnapshot,
	type StopRequest,
} from "@/controller/model.ts";

function clone<T>(value: T): T {
	return structuredClone(value);
}

export class InMemoryGitHubAdapter implements GitHubAdapter {
	#observations: GitHubProjectObservation[];
	public readCount = 0;

	public constructor(observations: readonly GitHubProjectObservation[] = []) {
		this.#observations = GitHubProjectObservationSchema.array().parse(clone(observations));
	}

	public setObservations(observations: readonly GitHubProjectObservation[]): void {
		this.#observations = GitHubProjectObservationSchema.array().parse(clone(observations));
	}

	public async observe(projectIds: readonly string[]): Promise<unknown> {
		this.readCount += 1;
		const requested = new Set(projectIds);
		return clone(this.#observations.filter((observation) => requested.has(observation.projectId)));
	}
}

export class FixedClockAdapter implements ClockAdapter {
	#current: Date;

	public constructor(current = new Date("2026-07-23T00:00:00.000Z")) {
		this.#current = new Date(current);
	}

	public now(): Date {
		return new Date(this.#current);
	}

	public set(current: Date): void {
		this.#current = new Date(current);
	}

	public advance(milliseconds: number): void {
		this.#current = new Date(this.#current.getTime() + milliseconds);
	}
}

export class SequenceRandomAdapter implements RandomAdapter {
	readonly #values: readonly number[];
	#index = 0;
	public callCount = 0;

	public constructor(values: readonly number[] = [0.5]) {
		this.#values = values.length === 0 ? [0.5] : [...values];
	}

	public next(): number {
		const value = this.#values[this.#index % this.#values.length];
		this.#index += 1;
		this.callCount += 1;
		return value ?? 0.5;
	}
}

interface MemoryFile {
	readonly content: string;
	readonly metadata: FileMetadata;
}

export class InMemoryFileSystemAdapter implements FileSystemAdapter {
	readonly #files = new Map<string, MemoryFile>();
	public readCount = 0;
	public statCount = 0;

	public constructor(files: Readonly<Record<string, MemoryFile>> = {}) {
		for (const [path, file] of Object.entries(files)) {
			this.#files.set(path, clone(file));
		}
	}

	public put(path: string, content: string, metadata: FileMetadata): void {
		this.#files.set(path, { content, metadata: clone(metadata) });
	}

	public async stat(path: string): Promise<FileMetadata> {
		this.statCount += 1;
		const file = this.#files.get(path);
		if (file === undefined) {
			throw new Error(`no in-memory file '${path}'`);
		}
		return clone(file.metadata);
	}

	public async readText(path: string): Promise<string> {
		this.readCount += 1;
		const file = this.#files.get(path);
		if (file === undefined) {
			throw new Error(`no in-memory file '${path}'`);
		}
		return file.content;
	}
}

export class InMemoryWorkerProcessAdapter implements WorkerProcessAdapter {
	readonly starts: LaunchRequest[] = [];
	readonly activations: ExecutionRecord[] = [];
	readonly stops: StopRequest[] = [];
	readonly conflictRepairHandoffs: ConflictRepairHandoffRequest[] = [];
	readonly #queuedExecutions: unknown[] = [];
	#nextExecution = 1;

	public enqueueExecution(execution: unknown): void {
		this.#queuedExecutions.push(clone(execution));
	}

	public async start(request: LaunchRequest): Promise<unknown> {
		this.starts.push(clone(request));
		const queued = this.#queuedExecutions.shift();
		if (queued !== undefined) {
			return clone(queued);
		}

		const sequence = this.#nextExecution;
		this.#nextExecution += 1;
		return ExecutionRecordSchema.parse({
			executionId: `execution-${sequence}`,
			projectId: request.projectId,
			lane: request.lane,
			provider: request.provider,
			workflow: request.workflow,
			claimState: request.issueNumber === null ? "selecting" : "awaiting-verification",
			issueNumber: request.issueNumber,
			pullRequestNumber: request.pullRequestNumber,
			branch: request.branch,
			worktreeId: null,
			headSha: request.headSha,
			status: "active",
		});
	}

	public async stop(request: StopRequest): Promise<void> {
		this.stops.push(clone(request));
	}

	public async handoffConflictRepair(request: ConflictRepairHandoffRequest): Promise<void> {
		this.conflictRepairHandoffs.push(clone(request));
	}

	public async activate(execution: ExecutionRecord): Promise<void> {
		this.activations.push(ExecutionRecordSchema.parse(clone(execution)));
	}
}

export class InMemoryNotificationAdapter implements NotificationAdapter {
	readonly sent: Notification[] = [];

	public async send(notification: Notification): Promise<void> {
		this.sent.push(clone(notification));
	}
}

export class InMemoryLedgerAdapter implements LedgerAdapter {
	#revision: number;
	#state: ControllerLocalState;
	public readCount = 0;
	public commitCount = 0;

	public constructor(state: ControllerLocalState, revision = 0) {
		this.#state = ControllerLocalStateSchema.parse(clone(state));
		this.#revision = revision;
	}

	public async read(): Promise<LedgerSnapshot> {
		this.readCount += 1;
		return { revision: this.#revision, state: clone(this.#state) };
	}

	public async commit(
		expectedRevision: number,
		state: ControllerLocalState,
	): Promise<LedgerSnapshot> {
		if (expectedRevision !== this.#revision) {
			throw new Error(
				`ledger revision conflict: expected ${expectedRevision}, current ${this.#revision}`,
			);
		}
		this.#state = ControllerLocalStateSchema.parse(clone(state));
		this.#revision += 1;
		this.commitCount += 1;
		return { revision: this.#revision, state: clone(this.#state) };
	}
}

export function createInitialControllerState(
	profiles: readonly ProjectProfile[],
): ControllerLocalState {
	return ControllerLocalStateSchema.parse({
		mode: "observation",
		rolloutStage: "stage3",
		projectEnabled: Object.fromEntries(profiles.map((profile) => [profile.id, profile.enabled])),
		rotation: {
			implementation: null,
			feedback: null,
		},
		circuits: {
			claude: { status: "closed", reasonCode: null },
			codex: { status: "closed", reasonCode: null },
			github: { status: "closed", reasonCode: null },
			reviewer: { status: "closed", reasonCode: null },
		},
		executions: [],
	});
}

export interface InMemoryAdapterSet extends ControllerAdapters {
	readonly github: InMemoryGitHubAdapter;
	readonly clock: FixedClockAdapter;
	readonly random: SequenceRandomAdapter;
	readonly fileSystem: InMemoryFileSystemAdapter;
	readonly processes: InMemoryWorkerProcessAdapter;
	readonly notifications: InMemoryNotificationAdapter;
	readonly ledger: InMemoryLedgerAdapter;
}

export function createInMemoryAdapters(
	profiles: readonly ProjectProfile[],
	observations: readonly GitHubProjectObservation[],
	state: ControllerLocalState = createInitialControllerState(profiles),
): InMemoryAdapterSet {
	return {
		github: new InMemoryGitHubAdapter(observations),
		clock: new FixedClockAdapter(),
		random: new SequenceRandomAdapter(),
		fileSystem: new InMemoryFileSystemAdapter(),
		processes: new InMemoryWorkerProcessAdapter(),
		notifications: new InMemoryNotificationAdapter(),
		ledger: new InMemoryLedgerAdapter(state),
	};
}
