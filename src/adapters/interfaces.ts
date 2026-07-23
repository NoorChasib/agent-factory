import type {
  ControllerLocalState,
  ExecutionRecord,
  LaunchRequest,
  LedgerSnapshot,
  StopRequest,
} from "../controller/model";

export interface GitHubAdapter {
  observe(projectIds: readonly string[], options?: GitHubObserveOptions): Promise<unknown>;
}

export interface GitHubObserveOptions {
  readonly reason: "status" | "startup" | "poll" | "change" | "capacity" | "recovery" | "operator";
  readonly allowMutations: boolean;
  readonly enabledProjectIds: readonly string[];
  readonly activeFeedbackPullRequests: readonly {
    readonly projectId: string;
    readonly pullRequestNumber: number;
  }[];
}

export interface GitHubHttpRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface GitHubHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface GitHubHttpTransport {
  request(request: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

export interface DelayAdapter {
  wait(milliseconds: number): Promise<void>;
}

export interface ClockAdapter {
  now(): Date;
}

export interface RandomAdapter {
  next(): number;
}

export interface FileMetadata {
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly mode: number;
}

export interface FileSystemAdapter {
  stat(path: string): Promise<FileMetadata>;
  readText(path: string): Promise<string>;
}

export interface WorkerProcessAdapter {
  start(request: LaunchRequest): Promise<unknown>;
  stop(request: StopRequest): Promise<void>;
}

export interface Notification {
  readonly topic: string;
  readonly title: string;
  readonly body: string;
}

export interface NotificationAdapter {
  send(notification: Notification): Promise<void>;
}

export interface LedgerAdapter {
  read(): Promise<LedgerSnapshot>;
  commit(expectedRevision: number, state: ControllerLocalState): Promise<LedgerSnapshot>;
}

export interface ControllerAdapters {
  readonly github: GitHubAdapter;
  readonly clock: ClockAdapter;
  readonly random: RandomAdapter;
  readonly fileSystem: FileSystemAdapter;
  readonly processes: WorkerProcessAdapter;
  readonly notifications: NotificationAdapter;
  readonly ledger: LedgerAdapter;
}

export function assertExecutionMatchesLaunch(
  execution: ExecutionRecord,
  request: LaunchRequest,
): void {
  if (
    execution.projectId !== request.projectId ||
    execution.lane !== request.lane ||
    execution.provider !== request.provider ||
    execution.workflow !== request.workflow ||
    execution.status !== "active"
  ) {
    throw new Error("worker process adapter returned an execution that does not match its launch");
  }
  if (
    request.pullRequestNumber !== null &&
    execution.pullRequestNumber !== request.pullRequestNumber
  ) {
    throw new Error("feedback execution does not own the requested pull request");
  }
}
