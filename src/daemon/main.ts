#!/usr/bin/env bun

import { dirname, join, resolve } from "node:path";
import type { ControllerLocalState } from "../controller/model";
import { ControllerLocalStateSchema } from "../controller/model";
import {
  BunCommandAdapter,
  BunDelayAdapter,
  CanonicalStageManager,
  ClaudeCodeRunner,
  CodexFeedbackRunner,
  CryptoIdSource,
  composeDaemon,
  FactoryNotifications,
  FetchGitHubTransport,
  FetchNtfyTransport,
  GitHubApiClient,
  GitHubAppTokenBroker,
  GitHubLabelOperator,
  GitHubLifecycleReconciler,
  GitHubMutationExecutor,
  GuardedGitCommandAdapter,
  GuardedGitHubLabelApi,
  GuardedHerdrCommandAdapter,
  HerdrCommandExecutionAdapter,
  HerdrProviderExecutionRepository,
  HerdrSessionManager,
  HerdrWorkerOperator,
  LedgerOwnedProcessStopper,
  LedgerRecoveryVerifier,
  LedgerRetentionArtifacts,
  LinuxProcessTreeAdapter,
  LocalDiskUsageAdapter,
  LocalDoctorSystemAdapter,
  LocalFactoryReleaseBuildAdapter,
  LocalReleaseFileSystemAdapter,
  LocalReleaseMigrationSourceAdapter,
  LocalRuntimeFileSystemAdapter,
  loadFactoryConfiguration,
  NtfyNotificationAdapter,
  ObservedWorkerOutcomeVerifier,
  openSqliteLedger,
  ProductionGitHubAdapter,
  ProviderExecutionRecorder,
  ProviderWorkerSupervisor,
  parseClaudeRuntimeFromEnvironment,
  prepareXdgDirectories,
  ReadyToMergeEmitter,
  RecoveryCommentPublisher,
  RecoveryHandoffCoordinator,
  RedactingNotificationAdapter,
  ReleaseBuilder,
  ReleaseStore,
  ReviewConvergenceCoordinator,
  ReviewConvergenceEngine,
  resolveXdgPaths,
  SelectionCheckoutCustody,
  SqliteReleaseLedgerAdapter,
  StallIncidentRecorder,
  StructuredRedactionBoundary,
  SystemClockAdapter,
  SystemdReleaseServiceAdapter,
  SystemRandomAdapter,
  WorktreeCustody,
} from "../index";

function secretEnvironmentValues(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return Object.entries(environment).flatMap(([name, value]) =>
    /(?:API_KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE|SECRET|TOKEN)/iu.test(name) &&
    value !== undefined &&
    value.length >= 4
      ? [value]
      : [],
  );
}

function initialState(
  profiles: Awaited<ReturnType<typeof loadFactoryConfiguration>>["profiles"],
): ControllerLocalState {
  return ControllerLocalStateSchema.parse({
    mode: "observation",
    rolloutStage: "observation",
    projectEnabled: Object.fromEntries(profiles.map((profile) => [profile.id, profile.enabled])),
    rotation: { implementation: null, feedback: null },
    circuits: {
      claude: { status: "closed", reasonCode: null },
      codex: { status: "closed", reasonCode: null },
      github: { status: "closed", reasonCode: null },
      reviewer: { status: "closed", reasonCode: null },
    },
    executions: [],
  });
}

export async function productionDaemonMain(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<void> {
  const paths = resolveXdgPaths(environment);
  const fileSystem = new LocalRuntimeFileSystemAdapter();
  await prepareXdgDirectories(paths, fileSystem);
  const configuration = await loadFactoryConfiguration(paths, fileSystem);
  const clock = new SystemClockAdapter();
  const random = new SystemRandomAdapter();
  const delay = new BunDelayAdapter();
  const ids = new CryptoIdSource();
  const redaction = new StructuredRedactionBoundary({
    environmentValues: secretEnvironmentValues(environment),
  });
  const notificationAdapter = new NtfyNotificationAdapter({
    baseUrl: configuration.runtime.ntfy.baseUrl,
    transport: new FetchNtfyTransport(),
  });
  const operationalNotifications = new FactoryNotifications({
    topic: configuration.runtime.ntfy.topic,
    notifications: new RedactingNotificationAdapter(notificationAdapter, redaction),
    redaction,
  });
  const ledger = openSqliteLedger({
    stateDirectory: paths.stateDirectory,
    instanceId: `daemon-${process.pid}`,
    clock,
    ids,
    initialState: initialState(configuration.profiles),
    redaction,
  });

  const command = new BunCommandAdapter();
  const releaseFileSystem = new LocalReleaseFileSystemAdapter();
  const releaseStore = new ReleaseStore({
    root: paths.releaseDirectory,
    fileSystem: releaseFileSystem,
    clock,
    ids,
  });
  await releaseStore.prepare();
  const factoryRoot = resolve(import.meta.dir, "..", "..");
  const factorySourceRepository = environment.AGENT_FACTORY_SOURCE_REPOSITORY ?? factoryRoot;
  const commandEnvironment = Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
  const releaseBuilder = new ReleaseBuilder({
    builds: new LocalFactoryReleaseBuildAdapter({
      commands: command,
      repositoryRoot: factorySourceRepository,
      checkoutRoot: paths.releaseBuildDirectory,
      environment: commandEnvironment,
    }),
    store: releaseStore,
  });
  const releaseLedger = new SqliteReleaseLedgerAdapter({
    ledger,
    backupDirectory: paths.releaseBackupDirectory,
  });
  const releaseService = new SystemdReleaseServiceAdapter({
    commands: command,
    releaseDirectory: paths.releaseDirectory,
    runtimeRoot: factoryRoot,
    environment: commandEnvironment,
  });
  const http = new FetchGitHubTransport();
  const tokens = new GitHubAppTokenBroker({
    environment,
    profiles: configuration.profiles,
    fileSystem,
    clock,
    transport: http,
  });
  const githubClient = new GitHubApiClient({ transport: http, delay });
  const labelGateway = new GuardedGitHubLabelApi({
    profiles: configuration.profiles,
    client: githubClient,
    transport: http,
    tokens,
  });
  const mutations = new GitHubMutationExecutor(ledger, labelGateway);
  const stages = new Map(
    configuration.profiles.map((profile) => [
      profile.id,
      new CanonicalStageManager(profile, mutations),
    ]),
  );
  const lifecycle = new GitHubLifecycleReconciler(configuration.profiles, stages, ledger);
  const convergence = new ReviewConvergenceCoordinator({
    profiles: configuration.profiles,
    engine: new ReviewConvergenceEngine(clock, ledger),
    emitters: new Map(
      [...stages].map(([projectId, stage]) => [projectId, new ReadyToMergeEmitter(stage)]),
    ),
    clock,
  });
  const github = new ProductionGitHubAdapter({
    profiles: configuration.profiles,
    client: githubClient,
    tokens,
    mutationExecutors: new Map(configuration.profiles.map((profile) => [profile.id, mutations])),
    lifecycle,
    convergence,
  });

  const git = new GuardedGitCommandAdapter({
    commands: command,
    tokens,
    mirrorBaseDirectory: paths.mirrorDirectory,
    worktreeBaseDirectory: paths.worktreeDirectory,
    protectedCheckoutDirectories: [resolve(import.meta.dir, "..", "..")],
  });
  const worktrees = new WorktreeCustody(git);
  const processTree = new LinuxProcessTreeAdapter();
  const herdrCommands = new GuardedHerdrCommandAdapter({
    commands: command,
    workingDirectory: paths.stateDirectory,
  });
  const herdr = new HerdrSessionManager({
    herdr: herdrCommands,
    processes: processTree,
    repository: ledger,
    clock,
    hostIdentity: `host-${process.pid}`,
  });
  const herdrExecution = new HerdrCommandExecutionAdapter({
    herdr,
    ledger,
    delay,
    clock,
    stateDirectory: paths.stateDirectory,
    workerExecutable: resolve(import.meta.dir, "worker-command.ts"),
  });
  const verifier = new ObservedWorkerOutcomeVerifier({
    async observeProject(projectId) {
      const observed = (await github.observe([projectId], {
        reason: "recovery",
        allowMutations: false,
        enabledProjectIds: [projectId],
        activeFeedbackPullRequests: [],
      })) as readonly unknown[];
      return observed[0];
    },
  });
  const claude = new ClaudeCodeRunner({
    commands: herdrExecution,
    tokens,
    ids,
    clock,
    verifier,
    runtime: parseClaudeRuntimeFromEnvironment(environment),
    controllerEnvironment: environment,
  });
  const codex = new CodexFeedbackRunner({
    commands: herdrExecution,
    tokens,
    clock,
    verifier,
    controllerEnvironment: environment,
  });
  const recorder = new ProviderExecutionRecorder(new HerdrProviderExecutionRepository(ledger));
  const selections = new SelectionCheckoutCustody({
    git,
    worktreeDirectory: paths.worktreeDirectory,
  });
  const recoveryHandoff = new RecoveryHandoffCoordinator({
    ledger,
    comments: new RecoveryCommentPublisher(mutations, redaction),
    incidents: new StallIncidentRecorder(ledger, redaction),
    onHandoff: async ({ terminalStatus, record }) => {
      try {
        await operationalNotifications.alert("stalled-handoff", {
          terminalStatus,
          record,
        });
      } catch (error) {
        ledger.appendAudit("stalled-handoff-notification-failed", {
          terminalStatus,
          message: error instanceof Error ? error.message : "notification failed",
        });
      }
    },
  });
  let supervisor: ProviderWorkerSupervisor;
  supervisor = new ProviderWorkerSupervisor({
    profiles: configuration.profiles,
    ledger,
    git,
    worktrees,
    selections,
    claude,
    codex,
    commands: herdrExecution,
    recorder,
    codexRuntime: { model: "gpt-5.6-codex", effort: "high" },
    nextExecutionId: () => `execution-${crypto.randomUUID()}`,
    stopExecution: async (executionId) => {
      await herdr.kill(executionId);
    },
    recoveryHandoff,
  });
  const workers = new HerdrWorkerOperator({
    herdr,
    ledger,
    processes: processTree,
    resume: (executionId) => supervisor.resumeExecution(executionId),
  });
  const daemon = composeDaemon({
    paths,
    configuration,
    fileSystem,
    disk: new LocalDiskUsageAdapter(),
    doctorSystem: new LocalDoctorSystemAdapter({
      environment,
      systemdUserDirectory: join(dirname(paths.configDirectory), "systemd", "user"),
      workingDirectory: paths.stateDirectory,
    }),
    clock,
    random,
    delay,
    ids,
    instanceId: `daemon-${process.pid}`,
    notificationAdapter,
    redaction,
    environment,
    ledger,
    releases: {
      builder: releaseBuilder,
      store: releaseStore,
      ledger: releaseLedger,
      migrations: new LocalReleaseMigrationSourceAdapter(),
      service: releaseService,
    },
    prior: {
      controllerAdapters: {
        github,
        clock,
        random,
        fileSystem,
        processes: supervisor,
        notifications: new RedactingNotificationAdapter(notificationAdapter, redaction),
      },
      workers,
      labels: new GitHubLabelOperator(configuration.profiles, mutations),
      recoveryScanner: herdr,
      recoveryVerifier: new LedgerRecoveryVerifier(ledger),
      ownedProcesses: new LedgerOwnedProcessStopper(ledger, processTree),
      retentionArtifacts: new LedgerRetentionArtifacts({
        ledger,
        worktrees,
        logDirectory: resolve(paths.stateDirectory, "execution-details"),
        clock,
        observedMergedAt: (projectId, pullRequestNumber) =>
          github.mergedAt(projectId, pullRequestNumber),
      }),
      claudeRunner: claude,
      codexRunner: codex,
      herdr,
      worktrees,
      convergence,
      recoveryHandoff,
    },
  });

  const stop = (): void => {
    void daemon.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await daemon.start();
}

if (import.meta.main) {
  await productionDaemonMain();
}
