import { join } from "node:path";

import type {
	ClockAdapter,
	ControllerAdapters,
	DelayAdapter,
	DiskUsageAdapter,
	DoctorSystemAdapter,
	NotificationAdapter,
	RandomAdapter,
	RuntimeFileSystemAdapter,
} from "@/adapters/interfaces.ts";
import type {
	ReleaseLedgerAdapter,
	ReleaseMigrationSourceAdapter,
	ReleaseServiceAdapter,
} from "@/adapters/release-interfaces.ts";
import {
	ControllerReleaseMaintenanceAdapter,
	ControllerReleaseReconciliationAdapter,
	FactoryReleaseAlertAdapter,
} from "@/adapters/releases.ts";
import { RotatingJsonLinesSink } from "@/adapters/structured-log.ts";
import type { ProjectProfile } from "@/contracts/project-profile.ts";
import { type Controller, createController } from "@/controller/controller.ts";
import { type ControllerLocalState, ControllerLocalStateSchema } from "@/controller/model.ts";
import type { ReviewConvergenceCoordinator } from "@/convergence/index.ts";
import { DaemonPollLoop } from "@/daemon/poll-loop.ts";
import {
	AgentFactoryRouter,
	type LabelOperator,
	type OperationalRegistry,
	type WorkerOperator,
} from "@/daemon/router.ts";
import { startUnixSocketServer, type UnixSocketServer } from "@/daemon/socket.ts";
import { parseGlobalLimitsFromEnvironment } from "@/env.ts";
import type { HerdrSessionManager } from "@/herdr/index.ts";
import { type LedgerIdSource, openSqliteLedger, type SqliteLedger } from "@/ledger/index.ts";
import { Doctor } from "@/operations/doctor.ts";
import {
	DiskGuard,
	type DurableRecoveryVerifier,
	type FactoryOwnedProcessStopper,
	MaintenanceCoordinator,
	RebootRecoveryCoordinator,
	type RecoveryScanner,
	RolloutCoordinator,
	ShutdownCoordinator,
} from "@/operations/lifecycle.ts";
import { FactoryNotifications, StructuredLogger } from "@/operations/observability.ts";
import { type RetentionArtifacts, RetentionCoordinator } from "@/operations/retention.ts";
import {
	type LoadedFactoryConfiguration,
	loadFactoryConfiguration,
	type XdgPaths,
} from "@/operations/runtime.ts";
import type { ClaudeCodeRunner, CodexFeedbackRunner } from "@/providers/index.ts";
import type { RecoveryHandoffCoordinator } from "@/recovery/index.ts";
import {
	DEFAULT_REDACTION_BOUNDARY,
	RedactingNotificationAdapter,
	type RedactionBoundary,
} from "@/redaction/index.ts";
import {
	type ReleaseBuilder,
	ReleaseHealthChecker,
	type ReleaseStore,
	ReleaseUpdater,
} from "@/releases/index.ts";
import type { WorktreeCustody } from "@/worktrees/index.ts";

export interface PriorPhaseRuntime {
	readonly controllerAdapters: Omit<ControllerAdapters, "ledger">;
	readonly workers: WorkerOperator;
	readonly labels: LabelOperator;
	readonly recoveryScanner: RecoveryScanner;
	readonly recoveryVerifier: DurableRecoveryVerifier;
	readonly ownedProcesses: FactoryOwnedProcessStopper;
	readonly retentionArtifacts: RetentionArtifacts;
	readonly claudeRunner: ClaudeCodeRunner;
	readonly codexRunner: CodexFeedbackRunner;
	readonly herdr: HerdrSessionManager;
	readonly worktrees: WorktreeCustody;
	readonly convergence: ReviewConvergenceCoordinator;
	readonly recoveryHandoff: RecoveryHandoffCoordinator;
}

export interface DaemonCompositionOptions {
	readonly paths: XdgPaths;
	readonly configuration: LoadedFactoryConfiguration;
	readonly fileSystem: RuntimeFileSystemAdapter;
	readonly disk: DiskUsageAdapter;
	readonly doctorSystem: DoctorSystemAdapter;
	readonly clock: ClockAdapter;
	readonly random: RandomAdapter;
	readonly delay: DelayAdapter;
	readonly ids: LedgerIdSource;
	readonly instanceId: string;
	readonly notificationAdapter: NotificationAdapter;
	readonly redaction?: RedactionBoundary;
	readonly prior: PriorPhaseRuntime;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly releases: {
		readonly builder: ReleaseBuilder;
		readonly store: ReleaseStore;
		readonly ledger: ReleaseLedgerAdapter;
		readonly migrations: ReleaseMigrationSourceAdapter;
		readonly service: ReleaseServiceAdapter;
	};
	readonly ledger?: OperationalRegistry;
	readonly startSocket?: typeof startUnixSocketServer;
}

export interface ComposedDaemon {
	readonly controller: Controller;
	readonly ledger: OperationalRegistry;
	readonly router: AgentFactoryRouter;
	readonly pollLoop: DaemonPollLoop;
	readonly recovery: RebootRecoveryCoordinator;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function initialObservationState(profiles: readonly ProjectProfile[]): ControllerLocalState {
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

export function commandEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(environment).flatMap(([name, value]) =>
			value === undefined ? [] : [[name, value]],
		),
	);
}

export function composeDaemon(options: DaemonCompositionOptions): ComposedDaemon {
	const redaction = options.redaction ?? DEFAULT_REDACTION_BOUNDARY;
	const ledger =
		options.ledger ??
		openSqliteLedger({
			stateDirectory: options.paths.stateDirectory,
			instanceId: options.instanceId,
			clock: options.clock,
			ids: options.ids,
			initialState: initialObservationState(options.configuration.profiles),
			redaction,
		});
	const controller = createController(
		{
			profiles: options.configuration.profiles,
			limits: parseGlobalLimitsFromEnvironment(options.environment),
			polling: { intervalMs: 60_000, jitterRatio: 0.1 },
		},
		{
			...options.prior.controllerAdapters,
			clock: options.clock,
			random: options.random,
			fileSystem: options.fileSystem,
			ledger,
		},
	);
	const notifications = new FactoryNotifications({
		topic: options.configuration.runtime.ntfy.topic,
		notifications: new RedactingNotificationAdapter(options.notificationAdapter, redaction),
		redaction,
	});
	const logger = new StructuredLogger({
		clock: options.clock,
		sink: new RotatingJsonLinesSink({
			path: join(options.paths.logDirectory, "agent-factory.jsonl"),
			rotateBytes: options.configuration.runtime.logging.rotateBytes,
			retainedFiles: options.configuration.runtime.logging.retainedFiles,
		}),
		redaction,
	});
	const maintenance = new MaintenanceCoordinator({ controller, ledger });
	const releaseMaintenance = new ControllerReleaseMaintenanceAdapter({
		controller,
		maintenance,
	});
	const releaseHealth = new ReleaseHealthChecker({
		store: options.releases.store,
		ledger: options.releases.ledger,
		service: options.releases.service,
		reconciliation: new ControllerReleaseReconciliationAdapter(controller),
	});
	const updates = new ReleaseUpdater({
		builder: options.releases.builder,
		store: options.releases.store,
		ledger: options.releases.ledger,
		maintenance: releaseMaintenance,
		migrations: options.releases.migrations,
		service: options.releases.service,
		health: releaseHealth,
		alerts: new FactoryReleaseAlertAdapter(notifications),
	});
	const rollout = new RolloutCoordinator(controller);
	const retention = new RetentionCoordinator({
		clock: options.clock,
		ledger,
		artifacts: options.prior.retentionArtifacts,
	});
	const disk = new DiskGuard({
		disk: options.disk,
		maintenance,
		notifications,
	});
	const shutdown = new ShutdownCoordinator({
		controller,
		ledger,
		delay: options.delay,
		recovery: options.prior.recoveryVerifier,
		processes: options.prior.ownedProcesses,
		notifications,
	});
	const doctor = new Doctor({
		paths: options.paths,
		fileSystem: options.fileSystem,
		disk: options.disk,
		system: options.doctorSystem,
		loadConfiguration: () => loadFactoryConfiguration(options.paths, options.fileSystem),
	});
	const recovery = new RebootRecoveryCoordinator({
		controller,
		ledger,
		scanner: options.prior.recoveryScanner,
	});
	const pollLoop = new DaemonPollLoop({
		controller,
		disk,
		retention,
		maintenance,
		notifications,
		logger,
		delay: options.delay,
		updates,
		diskPaths: [options.paths.stateDirectory, options.paths.dataDirectory],
	});

	let socket: UnixSocketServer | null = null;
	let stopped = false;
	let resolveStopped: (() => void) | null = null;
	let rejectStopped: ((error: unknown) => void) | null = null;
	const stoppedPromise = new Promise<void>((resolve, reject) => {
		resolveStopped = resolve;
		rejectStopped = reject;
	});
	const router = new AgentFactoryRouter({
		controller,
		ledger,
		configuration: options.configuration,
		loadConfiguration: () => loadFactoryConfiguration(options.paths, options.fileSystem),
		maintenance,
		rollout,
		retention,
		notifications,
		logger,
		doctor,
		workers: options.prior.workers,
		labels: options.prior.labels,
		updates,
		shutdown,
		stopDaemon: () => {
			pollLoop.stop();
			setTimeout(() => {
				void stop();
			}, 0);
		},
	});

	async function terminate(error?: unknown): Promise<void> {
		if (stopped) {
			return;
		}
		stopped = true;
		pollLoop.stop();
		await socket?.stop();
		socket = null;
		if (ledger instanceof Object && "close" in ledger && typeof ledger.close === "function") {
			(ledger as SqliteLedger).close();
		}
		if (error === undefined) {
			resolveStopped?.();
		} else {
			rejectStopped?.(error);
		}
	}

	async function stop(): Promise<void> {
		await terminate();
		return stoppedPromise;
	}

	return {
		controller,
		ledger,
		router,
		pollLoop,
		recovery,
		async start(): Promise<void> {
			await recovery.recover();
			socket = (options.startSocket ?? startUnixSocketServer)({
				socketPath: options.paths.socketPath,
				router,
				redaction,
			});
			void pollLoop.run().catch(async (error: unknown) => {
				try {
					await logger.write("error", "daemon.poll-failed", {
						message: error instanceof Error ? error.message : "poll loop failed",
					});
				} finally {
					await terminate(error);
				}
			});
			return stoppedPromise;
		},
		stop,
	};
}
