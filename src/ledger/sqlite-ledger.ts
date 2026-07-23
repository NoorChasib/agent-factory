import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { ClockAdapter, LedgerAdapter } from "../adapters/interfaces";
import {
  type ControllerLocalState,
  ControllerLocalStateSchema,
  type ExecutionRecord,
  ExecutionRecordSchema,
  type LedgerSnapshot,
} from "../controller/model";
import {
  DEFAULT_REDACTION_BOUNDARY,
  plainJsonValue,
  type RedactedJson,
  type RedactionBoundary,
  sanitizeAuditJson,
} from "../redaction";
import {
  LedgerCorruptionError,
  LedgerError,
  LedgerOwnershipError,
  LedgerRevisionConflictError,
} from "./errors";
import {
  applyLedgerMigrations,
  LEDGER_MIGRATIONS,
  type LedgerMigration,
  readSchemaVersion,
} from "./migrations";
import {
  type AuditEvent,
  AuditEventSchema,
  type ExecutionAttempt,
  ExecutionAttemptSchema,
  type ExecutionRecovery,
  ExecutionRecoverySchema,
  type LedgerIdSource,
  type LedgerOwner,
  type LedgerPragmas,
  type MaintenanceRequest,
  MaintenanceRequestSchema,
  type MutationRecord,
  MutationRecordSchema,
  type MutationState,
  MutationStateSchema,
  type NewMaintenanceRequest,
  NewMaintenanceRequestSchema,
  type NewMutation,
  NewMutationSchema,
  type NewProviderSession,
  NewProviderSessionSchema,
  type NewReleaseRecord,
  NewReleaseRecordSchema,
  type ProcessMetadata,
  type ProcessMetadataInput,
  ProcessMetadataInputSchema,
  ProcessMetadataSchema,
  type ProviderCircuitRecord,
  ProviderCircuitRecordSchema,
  type ProviderSession,
  ProviderSessionSchema,
  type ReleaseRecord,
  ReleaseRecordSchema,
  type ReviewBaseline,
  type ReviewBaselineInput,
  ReviewBaselineInputSchema,
  ReviewBaselineSchema,
} from "./types";

export const LEDGER_FILENAME = "ledger.sqlite3";

interface ControllerStateRow {
  readonly revision: number;
  readonly stateJson: string;
}

interface OwnerRow {
  readonly instanceId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

interface ExecutionRow {
  readonly executionId: string;
  readonly projectId: string;
  readonly lane: string;
  readonly provider: string;
  readonly workflow: string;
  readonly claimState: string;
  readonly issueNumber: number | null;
  readonly pullRequestNumber: number | null;
  readonly branch: string | null;
  readonly worktreeId: string | null;
  readonly headSha: string | null;
  readonly status: string;
}

interface AttemptRow {
  readonly executionId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly checkpoint: string | null;
  readonly outcome: string | null;
  readonly reasonCode: string | null;
}

interface SessionRow {
  readonly sessionKey: string;
  readonly executionId: string;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly providerSessionId: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly runtimeMetadataJson: string;
  readonly createdAt: string;
  readonly lastResumedAt: string | null;
}

interface ProcessRow {
  readonly executionId: string;
  readonly attemptNumber: number | null;
  readonly paneId: string | null;
  readonly processId: number | null;
  readonly processStartedAt: string | null;
  readonly hostIdentity: string | null;
  readonly runtimeMetadataJson: string;
  readonly updatedAt: string;
}

interface MutationRow {
  readonly mutationId: string;
  readonly projectId: string;
  readonly executionId: string | null;
  readonly kind: string;
  readonly subjectType: string;
  readonly subjectNumber: number | null;
  readonly intendedMutationJson: string;
  readonly idempotencyKey: string;
  readonly state: string;
  readonly resultJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ReviewBaselineRow {
  readonly projectId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly reviewObservationJson: string;
  readonly checkObservationJson: string;
  readonly quiescentPollCount: number;
  readonly updatedAt: string;
}

interface CircuitRow {
  readonly provider: string;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly openedAt: string | null;
  readonly updatedAt: string;
}

interface MaintenanceRow {
  readonly requestId: string;
  readonly kind: string;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ReleaseRow {
  readonly releaseId: string;
  readonly commitSha: string;
  readonly status: string;
  readonly artifactPath: string | null;
  readonly requiredSchemaVersion: number;
  readonly metadataJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AuditRow {
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly payloadJson: string;
}

const CONTROLLER_STATE_COLUMNS = `
  revision,
  state_json AS stateJson
`;

const LEDGER_OWNER_COLUMNS = `
  instance_id AS instanceId,
  acquired_at AS acquiredAt,
  heartbeat_at AS heartbeatAt,
  expires_at AS expiresAt
`;

const EXECUTION_COLUMNS = `
  execution_id AS executionId,
  project_id AS projectId,
  lane,
  provider,
  workflow,
  claim_state AS claimState,
  issue_number AS issueNumber,
  pull_request_number AS pullRequestNumber,
  branch,
  worktree_id AS worktreeId,
  head_sha AS headSha,
  status
`;

const EXECUTION_ATTEMPT_COLUMNS = `
  execution_id AS executionId,
  attempt_number AS attemptNumber,
  status,
  started_at AS startedAt,
  finished_at AS finishedAt,
  checkpoint,
  outcome,
  reason_code AS reasonCode
`;

const PROVIDER_SESSION_COLUMNS = `
  session.session_key AS sessionKey,
  session.execution_id AS executionId,
  session.attempt_number AS attemptNumber,
  session.provider,
  session.provider_session_id AS providerSessionId,
  session.model,
  session.reasoning_effort AS reasoningEffort,
  session.runtime_metadata_json AS runtimeMetadataJson,
  session.created_at AS createdAt,
  session.last_resumed_at AS lastResumedAt
`;

const PROCESS_METADATA_COLUMNS = `
  execution_id AS executionId,
  attempt_number AS attemptNumber,
  pane_id AS paneId,
  process_id AS processId,
  process_started_at AS processStartedAt,
  host_identity AS hostIdentity,
  runtime_metadata_json AS runtimeMetadataJson,
  updated_at AS updatedAt
`;

const GITHUB_MUTATION_COLUMNS = `
  mutation_id AS mutationId,
  project_id AS projectId,
  execution_id AS executionId,
  kind,
  subject_type AS subjectType,
  subject_number AS subjectNumber,
  intended_mutation_json AS intendedMutationJson,
  idempotency_key AS idempotencyKey,
  state,
  result_json AS resultJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const REVIEW_BASELINE_COLUMNS = `
  project_id AS projectId,
  pull_request_number AS pullRequestNumber,
  head_sha AS headSha,
  review_observation_json AS reviewObservationJson,
  check_observation_json AS checkObservationJson,
  quiescent_poll_count AS quiescentPollCount,
  updated_at AS updatedAt
`;

const PROVIDER_CIRCUIT_COLUMNS = `
  provider,
  status,
  reason_code AS reasonCode,
  opened_at AS openedAt,
  updated_at AS updatedAt
`;

const MAINTENANCE_REQUEST_COLUMNS = `
  request_id AS requestId,
  kind,
  status,
  reason_code AS reasonCode,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const RELEASE_COLUMNS = `
  release_id AS releaseId,
  commit_sha AS commitSha,
  status,
  artifact_path AS artifactPath,
  required_schema_version AS requiredSchemaVersion,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const AUDIT_EVENT_COLUMNS = `
  sequence,
  timestamp,
  kind,
  payload_json AS payloadJson
`;

export interface OpenSqliteLedgerOptions {
  readonly stateDirectory: string;
  readonly instanceId: string;
  readonly clock: ClockAdapter;
  readonly ids: LedgerIdSource;
  readonly initialState: ControllerLocalState;
  readonly migrations?: readonly LedgerMigration[];
  readonly ownerLeaseDurationMs?: number;
  readonly redaction?: RedactionBoundary;
}

export interface RestoreSqliteLedgerOptions extends OpenSqliteLedgerOptions {
  readonly backupPath: string;
}

export interface UpdateAttemptInput {
  readonly executionId: string;
  readonly attemptNumber: number;
  readonly status: ExecutionAttempt["status"];
  readonly checkpoint: string | null;
  readonly outcome: string | null;
  readonly reasonCode: string | null;
}

function clockTimestamp(clock: ClockAdapter): string {
  const value = clock.now();
  if (!Number.isFinite(value.getTime())) {
    throw new LedgerError("ledger clock returned an invalid date");
  }
  return value.toISOString();
}

const ledgerJsonError = (message: string): LedgerError => new LedgerError(`ledger JSON ${message}`);

function encodeJson(input: unknown): string {
  return JSON.stringify(plainJsonValue(input, ledgerJsonError));
}

function decodeJson(input: string, description: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new LedgerCorruptionError(`ledger contains invalid ${description} JSON`, {
      cause: error,
    });
  }
}

function parseExecution(row: ExecutionRow): ExecutionRecord {
  return ExecutionRecordSchema.parse({
    executionId: row.executionId,
    projectId: row.projectId,
    lane: row.lane,
    provider: row.provider,
    workflow: row.workflow,
    claimState: row.claimState,
    issueNumber: row.issueNumber,
    pullRequestNumber: row.pullRequestNumber,
    branch: row.branch,
    worktreeId: row.worktreeId,
    headSha: row.headSha,
    status: row.status,
  });
}

function parseAttempt(row: AttemptRow): ExecutionAttempt {
  return ExecutionAttemptSchema.parse(row);
}

function parseSession(row: SessionRow): ProviderSession {
  return ProviderSessionSchema.parse({
    sessionKey: row.sessionKey,
    executionId: row.executionId,
    attemptNumber: row.attemptNumber,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    runtimeMetadata: decodeJson(row.runtimeMetadataJson, "provider session runtime metadata"),
    createdAt: row.createdAt,
    lastResumedAt: row.lastResumedAt,
  });
}

function parseProcess(row: ProcessRow): ProcessMetadata {
  return ProcessMetadataSchema.parse({
    executionId: row.executionId,
    attemptNumber: row.attemptNumber,
    paneId: row.paneId,
    processId: row.processId,
    processStartedAt: row.processStartedAt,
    hostIdentity: row.hostIdentity,
    runtimeMetadata: decodeJson(row.runtimeMetadataJson, "process runtime metadata"),
    updatedAt: row.updatedAt,
  });
}

function parseMutation(row: MutationRow): MutationRecord {
  return MutationRecordSchema.parse({
    mutationId: row.mutationId,
    projectId: row.projectId,
    executionId: row.executionId,
    kind: row.kind,
    subjectType: row.subjectType,
    subjectNumber: row.subjectNumber,
    intendedMutation: decodeJson(row.intendedMutationJson, "intended mutation"),
    idempotencyKey: row.idempotencyKey,
    state: row.state,
    result: row.resultJson === null ? null : decodeJson(row.resultJson, "mutation result"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function parseReviewBaseline(row: ReviewBaselineRow): ReviewBaseline {
  return ReviewBaselineSchema.parse({
    projectId: row.projectId,
    pullRequestNumber: row.pullRequestNumber,
    headSha: row.headSha,
    reviewObservation: decodeJson(row.reviewObservationJson, "review observation"),
    checkObservation: decodeJson(row.checkObservationJson, "check observation"),
    quiescentPollCount: row.quiescentPollCount,
    updatedAt: row.updatedAt,
  });
}

function parseCircuit(row: CircuitRow): ProviderCircuitRecord {
  return ProviderCircuitRecordSchema.parse(row);
}

function parseMaintenance(row: MaintenanceRow): MaintenanceRequest {
  return MaintenanceRequestSchema.parse(row);
}

function parseRelease(row: ReleaseRow): ReleaseRecord {
  return ReleaseRecordSchema.parse({
    releaseId: row.releaseId,
    commitSha: row.commitSha,
    status: row.status,
    artifactPath: row.artifactPath,
    requiredSchemaVersion: row.requiredSchemaVersion,
    metadata: decodeJson(row.metadataJson, "release metadata"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function parseAudit(row: AuditRow): AuditEvent {
  return AuditEventSchema.parse({
    sequence: row.sequence,
    timestamp: row.timestamp,
    kind: row.kind,
    payload: decodeJson(row.payloadJson, "audit payload"),
  });
}

function assertDirectory(path: string, description: string): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new LedgerError(`${description} '${path}' is unavailable`, { cause: error });
  }
  if (!metadata.isDirectory()) {
    throw new LedgerError(`${description} '${path}' is not a directory`);
  }
}

function verifyIntegrity(database: Database, description: string): void {
  let rows: readonly { quickCheck: string }[];
  try {
    rows = database
      .query<{ quick_check: string }, []>("PRAGMA quick_check")
      .all()
      .map((row) => ({ quickCheck: row.quick_check }));
  } catch (error) {
    throw new LedgerCorruptionError(`${description} is not a valid SQLite database`, {
      cause: error,
    });
  }
  if (rows.length !== 1 || rows[0]?.quickCheck !== "ok") {
    throw new LedgerCorruptionError(
      `${description} failed SQLite integrity check: ${rows.map((row) => row.quickCheck).join(", ")}`,
    );
  }
}

function configureConnection(database: Database): void {
  database.exec(`
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 0;
    PRAGMA wal_autocheckpoint = 1000;
  `);
  const journal = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL").get();
  if (journal?.journal_mode.toLowerCase() !== "wal") {
    throw new LedgerError("SQLite refused WAL journal mode");
  }
  const foreignKeys = database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  if (foreignKeys?.foreign_keys !== 1) {
    throw new LedgerError("SQLite refused foreign-key enforcement");
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort cleanup is used only for a task-specific temporary file.
  }
}

function generatedId(ids: LedgerIdSource, kind: Parameters<LedgerIdSource["nextId"]>[0]): string {
  return AuditEventSchema.shape.kind.parse(ids.nextId(kind));
}

function installWithoutOverwrite(temporaryPath: string, destinationPath: string): void {
  linkSync(temporaryPath, destinationPath);
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    safeUnlink(destinationPath);
    throw error;
  }
}

export class SqliteLedger implements LedgerAdapter, Disposable {
  #database: Database;
  readonly #databasePath: string;
  readonly #instanceId: string;
  readonly #clock: ClockAdapter;
  readonly #ids: LedgerIdSource;
  readonly #ownerLeaseDurationMs: number;
  readonly #redaction: RedactionBoundary;
  readonly #initialState: ControllerLocalState;
  #migrations: readonly LedgerMigration[];
  #closed = false;

  private constructor(database: Database, databasePath: string, options: OpenSqliteLedgerOptions) {
    this.#database = database;
    this.#databasePath = databasePath;
    this.#instanceId = options.instanceId;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#ownerLeaseDurationMs = options.ownerLeaseDurationMs ?? 300_000;
    this.#redaction = options.redaction ?? DEFAULT_REDACTION_BOUNDARY;
    this.#initialState = ControllerLocalStateSchema.parse(structuredClone(options.initialState));
    this.#migrations = [...(options.migrations ?? LEDGER_MIGRATIONS)];
  }

  public static open(options: OpenSqliteLedgerOptions): SqliteLedger {
    assertDirectory(options.stateDirectory, "ledger state directory");
    if (options.instanceId.length === 0 || options.instanceId.length > 200) {
      throw new LedgerOwnershipError("ledger instance ID must contain 1 through 200 characters");
    }
    const ownerLeaseDurationMs = options.ownerLeaseDurationMs ?? 300_000;
    if (
      !Number.isSafeInteger(ownerLeaseDurationMs) ||
      ownerLeaseDurationMs < 1_000 ||
      ownerLeaseDurationMs > 86_400_000
    ) {
      throw new LedgerOwnershipError(
        "ledger owner lease duration must be an integer from 1000 through 86400000 milliseconds",
      );
    }
    const initialState = ControllerLocalStateSchema.parse(structuredClone(options.initialState));
    const databasePath = join(options.stateDirectory, LEDGER_FILENAME);
    const existed = existsSync(databasePath);
    let database: Database | undefined;
    try {
      database = new Database(databasePath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      if (!existed) {
        chmodSync(databasePath, 0o600);
      }
      verifyIntegrity(database, "ledger");
      configureConnection(database);
      applyLedgerMigrations(database, options.clock, options.migrations ?? LEDGER_MIGRATIONS);
    } catch (error) {
      database?.close();
      if (error instanceof LedgerError) {
        throw error;
      }
      throw new LedgerCorruptionError(`failed to open SQLite ledger '${databasePath}'`, {
        cause: error,
      });
    }
    if (database === undefined) {
      throw new LedgerError("failed to initialize SQLite ledger");
    }

    const ledger = new SqliteLedger(database, databasePath, options);
    try {
      ledger.#acquireOwner(initialState);
      return ledger;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  public static restore(options: RestoreSqliteLedgerOptions): SqliteLedger {
    assertDirectory(options.stateDirectory, "ledger state directory");
    const databasePath = join(options.stateDirectory, LEDGER_FILENAME);
    if (
      existsSync(databasePath) ||
      existsSync(`${databasePath}-wal`) ||
      existsSync(`${databasePath}-shm`)
    ) {
      throw new LedgerError("restore target already contains ledger files");
    }
    let serialized: Buffer;
    try {
      serialized = readFileSync(options.backupPath);
    } catch (error) {
      throw new LedgerError(`ledger backup '${options.backupPath}' is unavailable`, {
        cause: error,
      });
    }

    let restored: Database | undefined;
    let temporaryCreated = false;
    const temporaryPath = join(
      options.stateDirectory,
      `.${LEDGER_FILENAME}.restore-${generatedId(options.ids, "audit-backup")}`,
    );
    try {
      writeFileSync(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
      temporaryCreated = true;
      restored = new Database(temporaryPath, {
        readwrite: true,
        strict: true,
      });
      restored.exec("PRAGMA foreign_keys = ON");
      verifyIntegrity(restored, "ledger backup");
      applyLedgerMigrations(restored, options.clock, options.migrations ?? LEDGER_MIGRATIONS);
      restored
        .transaction(() => {
          restored?.exec("DELETE FROM ledger_owner");
        })
        .immediate();
      restored.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
      verifyIntegrity(restored, "restored ledger");
      restored.close();
      restored = undefined;
      safeUnlink(`${temporaryPath}-wal`);
      safeUnlink(`${temporaryPath}-shm`);
      installWithoutOverwrite(temporaryPath, databasePath);
      temporaryCreated = false;
    } catch (error) {
      if (temporaryCreated) {
        safeUnlink(temporaryPath);
        safeUnlink(`${temporaryPath}-wal`);
        safeUnlink(`${temporaryPath}-shm`);
      }
      if (error instanceof LedgerError) {
        throw error;
      }
      throw new LedgerCorruptionError("failed to restore ledger backup", { cause: error });
    } finally {
      restored?.close();
    }

    return SqliteLedger.open(options);
  }

  public get databasePath(): string {
    return this.#databasePath;
  }

  public get schemaVersion(): number {
    this.#assertOpen();
    return readSchemaVersion(this.#database);
  }

  public get pragmas(): LedgerPragmas {
    this.#assertOpen();
    const journal = this.#database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    const synchronous = this.#database
      .query<{ synchronous: number }, []>("PRAGMA synchronous")
      .get();
    const foreignKeys = this.#database
      .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
      .get();
    if (journal === null || synchronous === null || foreignKeys === null) {
      throw new LedgerError("failed to read SQLite pragmas");
    }
    return {
      journalMode: journal.journal_mode,
      synchronous: synchronous.synchronous,
      foreignKeys: foreignKeys.foreign_keys,
    };
  }

  public owner(): LedgerOwner {
    this.#assertOpen();
    const row = this.#database
      .query<OwnerRow, []>(
        `
          SELECT ${LEDGER_OWNER_COLUMNS}
          FROM ledger_owner
          WHERE singleton = 1
        `,
      )
      .get();
    if (row === null) {
      throw new LedgerOwnershipError("ledger has no controller owner");
    }
    return row;
  }

  public async read(): Promise<LedgerSnapshot> {
    const at = clockTimestamp(this.#clock);
    let snapshot: LedgerSnapshot | undefined;
    this.#database
      .transaction(() => {
        this.#assertOwned();
        this.#heartbeat(at);
        const row = this.#readControllerState();
        snapshot = {
          revision: row.revision,
          state: ControllerLocalStateSchema.parse(decodeJson(row.stateJson, "controller state")),
        };
      })
      .immediate();
    if (snapshot === undefined) {
      throw new LedgerError("failed to read controller state");
    }
    return snapshot;
  }

  public async commit(
    expectedRevision: number,
    state: ControllerLocalState,
  ): Promise<LedgerSnapshot> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new LedgerRevisionConflictError(expectedRevision, this.#readControllerState().revision);
    }
    const validated = ControllerLocalStateSchema.parse(structuredClone(state));
    const updatedAt = clockTimestamp(this.#clock);
    let revision = -1;

    this.#database
      .transaction(() => {
        this.#assertOwned();
        const current = this.#readControllerState();
        if (current.revision !== expectedRevision) {
          throw new LedgerRevisionConflictError(expectedRevision, current.revision);
        }
        revision = current.revision + 1;
        const changed = this.#database
          .query(
            `
            UPDATE controller_state
            SET revision = $revision, state_json = $stateJson, updated_at = $updatedAt
            WHERE singleton = 1 AND revision = $expectedRevision
          `,
          )
          .run({
            revision,
            stateJson: encodeJson(validated),
            updatedAt,
            expectedRevision,
          });
        if (changed.changes !== 1) {
          throw new LedgerRevisionConflictError(
            expectedRevision,
            this.#readControllerState().revision,
          );
        }
        this.#syncExecutions(validated.executions, updatedAt);
        this.#syncCircuits(validated, updatedAt);
        this.#heartbeat(updatedAt);
        this.#insertAudit("controller-state-committed", { revision }, updatedAt);
      })
      .immediate();

    return { revision, state: structuredClone(validated) };
  }

  public listExecutions(): readonly ExecutionRecord[] {
    this.#assertOwned();
    return this.#database
      .query<ExecutionRow, []>(
        `
          SELECT ${EXECUTION_COLUMNS}
          FROM executions
          ORDER BY created_at, execution_id
        `,
      )
      .all()
      .map(parseExecution);
  }

  public startAttempt(executionId: string): ExecutionAttempt {
    const startedAt = clockTimestamp(this.#clock);
    let attempt: ExecutionAttempt | undefined;
    this.#database
      .transaction(() => {
        this.#assertOwned();
        this.#requireExecution(executionId);
        const row = this.#database
          .query<{ nextAttempt: number }, [string]>(
            `
            SELECT COALESCE(MAX(attempt_number), 0) + 1 AS nextAttempt
            FROM execution_attempts
            WHERE execution_id = ?
          `,
          )
          .get(executionId);
        const attemptNumber = row?.nextAttempt ?? 1;
        this.#database
          .query(
            `
            INSERT INTO execution_attempts (
              execution_id, attempt_number, status, started_at, finished_at,
              checkpoint, outcome, reason_code
            ) VALUES ($executionId, $attemptNumber, 'active', $startedAt, NULL, NULL, NULL, NULL)
          `,
          )
          .run({ executionId, attemptNumber, startedAt });
        attempt = ExecutionAttemptSchema.parse({
          executionId,
          attemptNumber,
          status: "active",
          startedAt,
          finishedAt: null,
          checkpoint: null,
          outcome: null,
          reasonCode: null,
        });
        this.#heartbeat(startedAt);
        this.#insertAudit("execution-attempt-started", { executionId, attemptNumber }, startedAt);
      })
      .immediate();
    if (attempt === undefined) {
      throw new LedgerError("failed to create execution attempt");
    }
    return attempt;
  }

  public updateAttempt(input: UpdateAttemptInput): ExecutionAttempt {
    const validated = ExecutionAttemptSchema.pick({
      executionId: true,
      attemptNumber: true,
      status: true,
      checkpoint: true,
      outcome: true,
      reasonCode: true,
    }).parse(input);
    const updatedAt = clockTimestamp(this.#clock);
    let result: ExecutionAttempt | undefined;
    this.#database
      .transaction(() => {
        this.#assertOwned();
        const existing = this.#getAttempt(validated.executionId, validated.attemptNumber);
        if (existing.status !== "active") {
          if (
            existing.status === validated.status &&
            existing.checkpoint === validated.checkpoint &&
            existing.outcome === validated.outcome &&
            existing.reasonCode === validated.reasonCode
          ) {
            result = existing;
            return;
          }
          throw new LedgerError(
            `attempt ${validated.executionId}/${validated.attemptNumber} is terminal`,
          );
        }
        const finishedAt = validated.status === "active" ? null : updatedAt;
        this.#database
          .query(
            `
            UPDATE execution_attempts
            SET
              status = $status,
              finished_at = $finishedAt,
              checkpoint = $checkpoint,
              outcome = $outcome,
              reason_code = $reasonCode
            WHERE execution_id = $executionId AND attempt_number = $attemptNumber
          `,
          )
          .run({ ...validated, finishedAt });
        result = ExecutionAttemptSchema.parse({
          ...existing,
          ...validated,
          finishedAt,
        });
        this.#heartbeat(updatedAt);
        this.#insertAudit(
          "execution-attempt-updated",
          {
            executionId: validated.executionId,
            attemptNumber: validated.attemptNumber,
            status: validated.status,
          },
          updatedAt,
        );
      })
      .immediate();
    if (result === undefined) {
      throw new LedgerError("failed to update execution attempt");
    }
    return result;
  }

  public registerProviderSession(input: NewProviderSession): ProviderSession {
    const validated = NewProviderSessionSchema.parse(structuredClone(input));
    const createdAt = clockTimestamp(this.#clock);
    const sessionKey = generatedId(this.#ids, "provider-session");
    const record = ProviderSessionSchema.parse({
      sessionKey,
      ...validated,
      createdAt,
      lastResumedAt: null,
    });
    this.#database
      .transaction(() => {
        this.#assertOwned();
        this.#getAttempt(record.executionId, record.attemptNumber);
        this.#database
          .query(
            `
            INSERT INTO provider_sessions (
              session_key, execution_id, attempt_number, provider, provider_session_id,
              model, reasoning_effort, runtime_metadata_json, created_at, last_resumed_at
            ) VALUES (
              $sessionKey, $executionId, $attemptNumber, $provider, $providerSessionId,
              $model, $reasoningEffort, $runtimeMetadataJson, $createdAt, NULL
            )
          `,
          )
          .run({
            sessionKey: record.sessionKey,
            executionId: record.executionId,
            attemptNumber: record.attemptNumber,
            provider: record.provider,
            providerSessionId: record.providerSessionId,
            model: record.model,
            reasoningEffort: record.reasoningEffort,
            runtimeMetadataJson: encodeJson(record.runtimeMetadata),
            createdAt: record.createdAt,
          });
        this.#heartbeat(createdAt);
        this.#insertAudit(
          "provider-session-registered",
          {
            executionId: record.executionId,
            attemptNumber: record.attemptNumber,
            provider: record.provider,
            providerSessionId: record.providerSessionId,
          },
          createdAt,
        );
      })
      .immediate();
    return record;
  }

  public findCodexSessionForPullRequest(
    projectId: string,
    pullRequestNumber: number,
  ): ProviderSession | null {
    this.#assertOwned();
    if (
      !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(projectId) ||
      projectId.length > 64 ||
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber <= 0
    ) {
      throw new LedgerError("Codex session lookup subject is invalid");
    }
    const sessions = this.#database
      .query<SessionRow, [string, number]>(
        `
          SELECT ${PROVIDER_SESSION_COLUMNS}
          FROM provider_sessions AS session
          INNER JOIN executions AS execution
            ON execution.execution_id = session.execution_id
          WHERE
            execution.project_id = ?
            AND execution.pull_request_number = ?
            AND session.provider = 'codex'
          ORDER BY session.created_at, session.session_key
          LIMIT 2
        `,
      )
      .all(projectId, pullRequestNumber)
      .map(parseSession);
    if (sessions.length > 1) {
      throw new LedgerCorruptionError(
        `pull request ${projectId}/${pullRequestNumber} has multiple Codex outer sessions`,
      );
    }
    return sessions[0] ?? null;
  }

  public markProviderSessionResumed(sessionKey: string): ProviderSession {
    const resumedAt = clockTimestamp(this.#clock);
    let result: ProviderSession | undefined;
    this.#database
      .transaction(() => {
        this.#assertOwned();
        const existing = this.#getProviderSession(sessionKey);
        this.#database
          .query("UPDATE provider_sessions SET last_resumed_at = ? WHERE session_key = ?")
          .run(resumedAt, sessionKey);
        result = { ...existing, lastResumedAt: resumedAt };
        this.#heartbeat(resumedAt);
        this.#insertAudit(
          "provider-session-resumed",
          { executionId: existing.executionId, sessionKey },
          resumedAt,
        );
      })
      .immediate();
    if (result === undefined) {
      throw new LedgerError("failed to resume provider session");
    }
    return result;
  }

  public saveProcessMetadata(input: ProcessMetadataInput): ProcessMetadata {
    const validated = ProcessMetadataInputSchema.parse(structuredClone(input));
    const updatedAt = clockTimestamp(this.#clock);
    const record = ProcessMetadataSchema.parse({ ...validated, updatedAt });
    this.#database
      .transaction(() => {
        this.#assertOwned();
        this.#requireExecution(record.executionId);
        if (record.attemptNumber !== null) {
          this.#getAttempt(record.executionId, record.attemptNumber);
        }
        this.#database
          .query(
            `
            INSERT INTO process_metadata (
              execution_id, attempt_number, pane_id, process_id, process_started_at,
              host_identity, runtime_metadata_json, updated_at
            ) VALUES (
              $executionId, $attemptNumber, $paneId, $processId, $processStartedAt,
              $hostIdentity, $runtimeMetadataJson, $updatedAt
            )
            ON CONFLICT (execution_id) DO UPDATE SET
              attempt_number = excluded.attempt_number,
              pane_id = excluded.pane_id,
              process_id = excluded.process_id,
              process_started_at = excluded.process_started_at,
              host_identity = excluded.host_identity,
              runtime_metadata_json = excluded.runtime_metadata_json,
              updated_at = excluded.updated_at
          `,
          )
          .run({
            executionId: record.executionId,
            attemptNumber: record.attemptNumber,
            paneId: record.paneId,
            processId: record.processId,
            processStartedAt: record.processStartedAt,
            hostIdentity: record.hostIdentity,
            runtimeMetadataJson: encodeJson(record.runtimeMetadata),
            updatedAt: record.updatedAt,
          });
        this.#heartbeat(updatedAt);
        this.#insertAudit(
          "process-metadata-saved",
          { executionId: record.executionId, attemptNumber: record.attemptNumber },
          updatedAt,
        );
      })
      .immediate();
    return record;
  }

  public readExecutionRecovery(executionId: string): ExecutionRecovery {
    this.#assertOwned();
    const execution = this.#requireExecution(executionId);
    const attempts = this.#database
      .query<AttemptRow, [string]>(
        `
          SELECT ${EXECUTION_ATTEMPT_COLUMNS}
          FROM execution_attempts
          WHERE execution_id = ?
          ORDER BY attempt_number
        `,
      )
      .all(executionId)
      .map(parseAttempt);
    const sessions = this.#database
      .query<SessionRow, [string]>(
        `
          SELECT ${PROVIDER_SESSION_COLUMNS}
          FROM provider_sessions AS session
          WHERE execution_id = ?
          ORDER BY attempt_number, created_at, session_key
        `,
      )
      .all(executionId)
      .map(parseSession);
    const processRow = this.#database
      .query<ProcessRow, [string]>(
        `
          SELECT ${PROCESS_METADATA_COLUMNS}
          FROM process_metadata
          WHERE execution_id = ?
        `,
      )
      .get(executionId);
    return ExecutionRecoverySchema.parse({
      execution,
      attempts,
      sessions,
      process: processRow === null ? null : parseProcess(processRow),
    });
  }

  public recordMutation(input: NewMutation): MutationRecord {
    const validated = NewMutationSchema.parse(structuredClone(input));
    const intendedMutationJson = encodeJson(validated.intendedMutation);
    const existing = this.#findMutationByIdempotencyKey(validated.idempotencyKey);
    if (existing !== null) {
      if (
        existing.projectId !== validated.projectId ||
        existing.executionId !== validated.executionId ||
        existing.kind !== validated.kind ||
        existing.subjectType !== validated.subjectType ||
        existing.subjectNumber !== validated.subjectNumber ||
        encodeJson(existing.intendedMutation) !== intendedMutationJson
      ) {
        throw new LedgerError(
          `idempotency key '${validated.idempotencyKey}' identifies a different mutation`,
        );
      }
      return existing;
    }

    const mutationId = generatedId(this.#ids, "mutation");
    const createdAt = clockTimestamp(this.#clock);
    const record = MutationRecordSchema.parse({
      mutationId,
      ...validated,
      state: "pending",
      result: null,
      createdAt,
      updatedAt: createdAt,
    });
    this.#database
      .transaction(() => {
        this.#assertOwned();
        if (record.executionId !== null) {
          this.#requireExecution(record.executionId);
        }
        this.#database
          .query(
            `
            INSERT INTO github_mutations (
              mutation_id, project_id, execution_id, kind, subject_type, subject_number,
              intended_mutation_json, idempotency_key, state, result_json, created_at, updated_at
            ) VALUES (
              $mutationId, $projectId, $executionId, $kind, $subjectType, $subjectNumber,
              $intendedMutationJson, $idempotencyKey, 'pending', NULL, $createdAt, $updatedAt
            )
          `,
          )
          .run({
            mutationId: record.mutationId,
            projectId: record.projectId,
            executionId: record.executionId,
            kind: record.kind,
            subjectType: record.subjectType,
            subjectNumber: record.subjectNumber,
            intendedMutationJson,
            idempotencyKey: record.idempotencyKey,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          });
        this.#heartbeat(createdAt);
        this.#insertAudit(
          "github-mutation-recorded",
          {
            mutationId,
            projectId: record.projectId,
            kind: record.kind,
            idempotencyKey: record.idempotencyKey,
          },
          createdAt,
        );
      })
      .immediate();
    return record;
  }

  public transitionMutation(
    mutationId: string,
    nextState: MutationState,
    result: unknown = null,
  ): MutationRecord {
    const state = MutationStateSchema.parse(nextState);
    const updatedAt = clockTimestamp(this.#clock);
    let updated: MutationRecord | undefined;
    this.#database
      .transaction(() => {
        this.#assertOwned();
        const current = this.#getMutation(mutationId);
        if (current.state === state) {
          if (encodeJson(current.result) !== encodeJson(result)) {
            throw new LedgerError(
              `mutation '${mutationId}' already reached ${state} with a different result`,
            );
          }
          updated = current;
          return;
        }
        if (!allowedMutationTransition(current.state, state)) {
          throw new LedgerError(
            `invalid mutation transition ${current.state} -> ${state} for '${mutationId}'`,
          );
        }
        const resultJson = result === null ? null : encodeJson(result);
        this.#database
          .query(
            `
            UPDATE github_mutations
            SET state = $state, result_json = $resultJson, updated_at = $updatedAt
            WHERE mutation_id = $mutationId
          `,
          )
          .run({ mutationId, state, resultJson, updatedAt });
        updated = MutationRecordSchema.parse({
          ...current,
          state,
          result: result === null ? null : plainJsonValue(result, ledgerJsonError),
          updatedAt,
        });
        this.#heartbeat(updatedAt);
        this.#insertAudit(
          "github-mutation-transitioned",
          { mutationId, previousState: current.state, state },
          updatedAt,
        );
      })
      .immediate();
    if (updated === undefined) {
      throw new LedgerError("failed to transition GitHub mutation");
    }
    return updated;
  }

  public listMutations(states?: readonly MutationState[]): readonly MutationRecord[] {
    this.#assertOwned();
    const validatedStates = states?.map((state) => MutationStateSchema.parse(state));
    const all = this.#database
      .query<MutationRow, []>(
        `
          SELECT ${GITHUB_MUTATION_COLUMNS}
          FROM github_mutations
          ORDER BY created_at, mutation_id
        `,
      )
      .all()
      .map(parseMutation);
    if (validatedStates === undefined) {
      return all;
    }
    const selected = new Set(validatedStates);
    return all.filter((mutation) => selected.has(mutation.state));
  }

  public saveReviewBaseline(input: ReviewBaselineInput): ReviewBaseline {
    const validated = ReviewBaselineInputSchema.parse(structuredClone(input));
    const updatedAt = clockTimestamp(this.#clock);
    const record = ReviewBaselineSchema.parse({ ...validated, updatedAt });
    this.#database
      .transaction(() => {
        this.#assertOwned();
        this.#database
          .query(
            `
            INSERT INTO review_baselines (
              project_id, pull_request_number, head_sha, review_observation_json,
              check_observation_json, quiescent_poll_count, updated_at
            ) VALUES (
              $projectId, $pullRequestNumber, $headSha, $reviewObservationJson,
              $checkObservationJson, $quiescentPollCount, $updatedAt
            )
            ON CONFLICT (project_id, pull_request_number) DO UPDATE SET
              head_sha = excluded.head_sha,
              review_observation_json = excluded.review_observation_json,
              check_observation_json = excluded.check_observation_json,
              quiescent_poll_count = excluded.quiescent_poll_count,
              updated_at = excluded.updated_at
          `,
          )
          .run({
            projectId: record.projectId,
            pullRequestNumber: record.pullRequestNumber,
            headSha: record.headSha,
            reviewObservationJson: encodeJson(record.reviewObservation),
            checkObservationJson: encodeJson(record.checkObservation),
            quiescentPollCount: record.quiescentPollCount,
            updatedAt: record.updatedAt,
          });
        this.#heartbeat(updatedAt);
        this.#insertAudit(
          "review-baseline-saved",
          {
            projectId: record.projectId,
            pullRequestNumber: record.pullRequestNumber,
            headSha: record.headSha,
          },
          updatedAt,
        );
      })
      .immediate();
    return record;
  }

  public getReviewBaseline(projectId: string, pullRequestNumber: number): ReviewBaseline | null {
    this.#assertOwned();
    const row = this.#database
      .query<ReviewBaselineRow, [string, number]>(
        `
          SELECT ${REVIEW_BASELINE_COLUMNS}
          FROM review_baselines
          WHERE project_id = ? AND pull_request_number = ?
        `,
      )
      .get(projectId, pullRequestNumber);
    return row === null ? null : parseReviewBaseline(row);
  }

  public listProviderCircuits(): readonly ProviderCircuitRecord[] {
    this.#assertOwned();
    return this.#database
      .query<CircuitRow, []>(
        `
          SELECT ${PROVIDER_CIRCUIT_COLUMNS}
          FROM provider_circuits
          ORDER BY provider
        `,
      )
      .all()
      .map(parseCircuit);
  }

  public createMaintenanceRequest(input: NewMaintenanceRequest): MaintenanceRequest {
    const validated = NewMaintenanceRequestSchema.parse(structuredClone(input));
    const requestId = generatedId(this.#ids, "maintenance-request");
    const createdAt = clockTimestamp(this.#clock);
    const record = MaintenanceRequestSchema.parse({
      requestId,
      ...validated,
      createdAt,
      updatedAt: createdAt,
    });
    this.#database
      .transaction(() => {
        this.#assertOwned();
        this.#database
          .query(
            `
            INSERT INTO maintenance_requests (
              request_id, kind, status, reason_code, created_at, updated_at
            ) VALUES ($requestId, $kind, $status, $reasonCode, $createdAt, $updatedAt)
          `,
          )
          .run(record);
        this.#heartbeat(createdAt);
        this.#insertAudit(
          "maintenance-request-created",
          { requestId, kind: record.kind, status: record.status },
          createdAt,
        );
      })
      .immediate();
    return record;
  }

  public updateMaintenanceRequest(
    requestId: string,
    status: MaintenanceRequest["status"],
  ): MaintenanceRequest {
    const nextStatus = MaintenanceRequestSchema.shape.status.parse(status);
    const updatedAt = clockTimestamp(this.#clock);
    let result: MaintenanceRequest | undefined;
    this.#database
      .transaction(() => {
        this.#assertOwned();
        const existing = this.#getMaintenanceRequest(requestId);
        if (!allowedMaintenanceTransition(existing.status, nextStatus)) {
          throw new LedgerError(
            `invalid maintenance transition ${existing.status} -> ${nextStatus} for '${requestId}'`,
          );
        }
        this.#database
          .query("UPDATE maintenance_requests SET status = ?, updated_at = ? WHERE request_id = ?")
          .run(nextStatus, updatedAt, requestId);
        result = { ...existing, status: nextStatus, updatedAt };
        this.#heartbeat(updatedAt);
        this.#insertAudit(
          "maintenance-request-updated",
          { requestId, previousStatus: existing.status, status: nextStatus },
          updatedAt,
        );
      })
      .immediate();
    if (result === undefined) {
      throw new LedgerError("failed to update maintenance request");
    }
    return result;
  }

  public listMaintenanceRequests(): readonly MaintenanceRequest[] {
    this.#assertOwned();
    return this.#database
      .query<MaintenanceRow, []>(
        `
          SELECT ${MAINTENANCE_REQUEST_COLUMNS}
          FROM maintenance_requests
          ORDER BY created_at, request_id
        `,
      )
      .all()
      .map(parseMaintenance);
  }

  public saveRelease(input: NewReleaseRecord): ReleaseRecord {
    const validated = NewReleaseRecordSchema.parse(structuredClone(input));
    if (validated.releaseId !== validated.commitSha) {
      throw new LedgerError("release ID must equal its factory commit SHA");
    }
    const updatedAt = clockTimestamp(this.#clock);
    const existing = this.#getRelease(validated.releaseId);
    const record = ReleaseRecordSchema.parse({
      ...validated,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    });
    this.#database
      .transaction(() => {
        this.#assertOwned();
        this.#database
          .query(
            `
            INSERT INTO releases (
              release_id, commit_sha, status, artifact_path, required_schema_version,
              metadata_json, created_at, updated_at
            ) VALUES (
              $releaseId, $commitSha, $status, $artifactPath, $requiredSchemaVersion,
              $metadataJson, $createdAt, $updatedAt
            )
            ON CONFLICT (release_id) DO UPDATE SET
              commit_sha = excluded.commit_sha,
              status = excluded.status,
              artifact_path = excluded.artifact_path,
              required_schema_version = excluded.required_schema_version,
              metadata_json = excluded.metadata_json,
              updated_at = excluded.updated_at
          `,
          )
          .run({
            releaseId: record.releaseId,
            commitSha: record.commitSha,
            status: record.status,
            artifactPath: record.artifactPath,
            requiredSchemaVersion: record.requiredSchemaVersion,
            metadataJson: encodeJson(record.metadata),
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          });
        this.#heartbeat(updatedAt);
        this.#insertAudit(
          "release-state-saved",
          { releaseId: record.releaseId, commitSha: record.commitSha, status: record.status },
          updatedAt,
        );
      })
      .immediate();
    return record;
  }

  public listReleases(): readonly ReleaseRecord[] {
    this.#assertOwned();
    return this.#database
      .query<ReleaseRow, []>(
        `
          SELECT ${RELEASE_COLUMNS}
          FROM releases
          ORDER BY created_at, release_id
        `,
      )
      .all()
      .map(parseRelease);
  }

  public activateRelease(releaseId: string, metadata: unknown): ReleaseRecord {
    const targetId = ReleaseRecordSchema.shape.releaseId.parse(releaseId);
    const parsedMetadata = decodeJson(encodeJson(metadata), "release activation metadata");
    const updatedAt = clockTimestamp(this.#clock);
    this.#database
      .transaction(() => {
        this.#assertOwned();
        const target = this.#getRelease(targetId);
        if (target === null || target.status !== "queued") {
          throw new LedgerError(`release '${targetId}' is not queued for activation`);
        }
        this.#database
          .query(
            `
              UPDATE releases
              SET status = 'candidate', updated_at = $updatedAt
              WHERE status = 'installed' AND release_id <> $releaseId
            `,
          )
          .run({ releaseId: targetId, updatedAt });
        this.#database
          .query(
            `
              UPDATE releases
              SET status = 'installed', metadata_json = $metadataJson, updated_at = $updatedAt
              WHERE release_id = $releaseId
            `,
          )
          .run({
            releaseId: targetId,
            metadataJson: encodeJson(parsedMetadata),
            updatedAt,
          });
        this.#insertAudit("release-activated", { releaseId: targetId }, updatedAt);
        this.#heartbeat(updatedAt);
      })
      .immediate();
    const activated = this.#getRelease(targetId);
    if (activated === null) {
      throw new LedgerError(`failed to activate release '${targetId}'`);
    }
    return activated;
  }

  public applyMigrations(migrations: readonly LedgerMigration[]): number {
    this.#assertOwned();
    const version = applyLedgerMigrations(this.#database, this.#clock, migrations);
    this.#migrations = [...migrations];
    this.appendAudit("ledger-migrations-applied", { schemaVersion: version });
    return version;
  }

  public appendAudit(kind: string, payload: unknown): AuditEvent {
    const at = clockTimestamp(this.#clock);
    let event: AuditEvent | undefined;
    this.#database
      .transaction(() => {
        this.#assertOwned();
        event = this.#insertAudit(kind, payload, at);
        this.#heartbeat(at);
      })
      .immediate();
    if (event === undefined) {
      throw new LedgerError("failed to append audit event");
    }
    return event;
  }

  public listAudit(afterSequence = 0, limit = 1_000): readonly AuditEvent[] {
    this.#assertOwned();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new LedgerError("audit sequence cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new LedgerError("audit result limit must be an integer from 1 through 10000");
    }
    return this.#database
      .query<AuditRow, [number, number]>(
        `
          SELECT ${AUDIT_EVENT_COLUMNS}
          FROM audit_events
          WHERE sequence > ?
          ORDER BY sequence
          LIMIT ?
        `,
      )
      .all(afterSequence, limit)
      .map(parseAudit);
  }

  public backup(backupPath: string): void {
    this.#assertOwned();
    assertDirectory(dirname(backupPath), "ledger backup directory");
    if (existsSync(backupPath)) {
      throw new LedgerError(`ledger backup '${backupPath}' already exists`);
    }
    const at = clockTimestamp(this.#clock);
    const temporaryPath = `${backupPath}.tmp-${generatedId(this.#ids, "audit-backup")}`;
    let snapshot: Database | undefined;
    let temporaryCreated = false;
    try {
      this.#database
        .transaction(() => {
          this.#assertOwned();
          this.#insertAudit("ledger-backup-created", { backupPath }, at);
          this.#heartbeat(at);
        })
        .immediate();
      writeFileSync(temporaryPath, this.#database.serialize(), {
        flag: "wx",
        mode: 0o600,
      });
      temporaryCreated = true;
      snapshot = new Database(temporaryPath, {
        readonly: true,
        strict: true,
      });
      verifyIntegrity(snapshot, "serialized ledger backup");
      if (readSchemaVersion(snapshot) !== this.schemaVersion) {
        throw new LedgerCorruptionError("serialized ledger backup has the wrong schema version");
      }
      snapshot.close();
      snapshot = undefined;
      safeUnlink(`${temporaryPath}-wal`);
      safeUnlink(`${temporaryPath}-shm`);
      installWithoutOverwrite(temporaryPath, backupPath);
      temporaryCreated = false;
    } catch (error) {
      if (temporaryCreated) {
        safeUnlink(temporaryPath);
        safeUnlink(`${temporaryPath}-wal`);
        safeUnlink(`${temporaryPath}-shm`);
      }
      if (error instanceof LedgerError) {
        throw error;
      }
      throw new LedgerError(`failed to create ledger backup '${backupPath}'`, {
        cause: error,
      });
    } finally {
      snapshot?.close();
    }
  }

  public restoreFromBackup(
    backupPath: string,
    migrations: readonly LedgerMigration[],
  ): { readonly quarantinedDatabasePath: string; readonly schemaVersion: number } {
    this.#assertOwned();
    const priorMigrations = this.#migrations;
    const quarantinePath = `${this.#databasePath}.pre-rollback-${generatedId(
      this.#ids,
      "audit-backup",
    )}`;
    this.close();
    try {
      renameSync(this.#databasePath, quarantinePath);
    } catch (error) {
      this.#reopen(priorMigrations);
      throw new LedgerError("failed to quarantine the pre-rollback ledger", { cause: error });
    }

    try {
      const restored = SqliteLedger.restore({
        stateDirectory: dirname(this.#databasePath),
        backupPath,
        instanceId: this.#instanceId,
        clock: this.#clock,
        ids: this.#ids,
        initialState: this.#initialState,
        migrations,
        ownerLeaseDurationMs: this.#ownerLeaseDurationMs,
        redaction: this.#redaction,
      });
      this.#adopt(restored, migrations);
      return {
        quarantinedDatabasePath: quarantinePath,
        schemaVersion: this.schemaVersion,
      };
    } catch (error) {
      if (existsSync(this.#databasePath)) {
        const failedRestorePath = `${this.#databasePath}.failed-restore-${generatedId(
          this.#ids,
          "audit-backup",
        )}`;
        renameSync(this.#databasePath, failedRestorePath);
      }
      renameSync(quarantinePath, this.#databasePath);
      this.#reopen(priorMigrations);
      throw error;
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    try {
      const at = clockTimestamp(this.#clock);
      this.#database
        .transaction(() => {
          this.#assertOwned();
          this.#insertAudit("ledger-owner-released", { instanceId: this.#instanceId }, at);
          this.#database
            .query("DELETE FROM ledger_owner WHERE singleton = 1 AND instance_id = ?")
            .run(this.#instanceId);
        })
        .immediate();
    } finally {
      this.#closed = true;
      this.#database.close();
    }
  }

  public [Symbol.dispose](): void {
    this.close();
  }

  #adopt(source: SqliteLedger, migrations: readonly LedgerMigration[]): void {
    this.#database = source.#database;
    this.#closed = false;
    this.#migrations = [...migrations];
    source.#closed = true;
  }

  #reopen(migrations: readonly LedgerMigration[]): void {
    const reopened = SqliteLedger.open({
      stateDirectory: dirname(this.#databasePath),
      instanceId: this.#instanceId,
      clock: this.#clock,
      ids: this.#ids,
      initialState: this.#initialState,
      migrations,
      ownerLeaseDurationMs: this.#ownerLeaseDurationMs,
      redaction: this.#redaction,
    });
    this.#adopt(reopened, migrations);
  }

  #acquireOwner(initialState: ControllerLocalState): void {
    const acquiredAt = clockTimestamp(this.#clock);
    const expiresAt = this.#leaseExpiry(acquiredAt);
    this.#database
      .transaction(() => {
        const existing = this.#database
          .query<OwnerRow, []>(
            `
            SELECT ${LEDGER_OWNER_COLUMNS}
            FROM ledger_owner
            WHERE singleton = 1
          `,
          )
          .get();
        if (existing !== null && !Number.isFinite(Date.parse(existing.expiresAt))) {
          throw new LedgerCorruptionError("ledger owner lease has an invalid expiration");
        }
        if (existing !== null && Date.parse(existing.expiresAt) > Date.parse(acquiredAt)) {
          throw new LedgerOwnershipError(
            `ledger is owned by controller instance '${existing.instanceId}' through ${existing.expiresAt}`,
          );
        }
        if (existing !== null) {
          this.#database.exec("DELETE FROM ledger_owner WHERE singleton = 1");
        }
        this.#database
          .query(
            `
            INSERT INTO ledger_owner (
              singleton, instance_id, acquired_at, heartbeat_at, expires_at
            )
            VALUES (1, $instanceId, $acquiredAt, $acquiredAt, $expiresAt)
          `,
          )
          .run({ instanceId: this.#instanceId, acquiredAt, expiresAt });

        const state = this.#database
          .query<{ present: number }, []>(
            "SELECT COUNT(*) AS present FROM controller_state WHERE singleton = 1",
          )
          .get();
        if (state?.present === 0) {
          this.#database
            .query(
              `
              INSERT INTO controller_state (
                singleton, revision, state_json, updated_at
              ) VALUES (1, 0, $stateJson, $updatedAt)
            `,
            )
            .run({ stateJson: encodeJson(initialState), updatedAt: acquiredAt });
          this.#syncExecutions(initialState.executions, acquiredAt);
          this.#syncCircuits(initialState, acquiredAt);
        }
        this.#insertAudit(
          "ledger-owner-acquired",
          {
            instanceId: this.#instanceId,
            previousInstanceId: existing?.instanceId ?? null,
          },
          acquiredAt,
        );
      })
      .immediate();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new LedgerError("SQLite ledger is closed");
    }
  }

  #assertOwned(): void {
    this.#assertOpen();
    const row = this.#database
      .query<{ instanceId: string }, []>(
        "SELECT instance_id AS instanceId FROM ledger_owner WHERE singleton = 1",
      )
      .get();
    if (row?.instanceId !== this.#instanceId) {
      throw new LedgerOwnershipError(
        `controller instance '${this.#instanceId}' does not own the ledger`,
      );
    }
  }

  #readControllerState(): ControllerStateRow {
    this.#assertOpen();
    const row = this.#database
      .query<ControllerStateRow, []>(
        `
          SELECT ${CONTROLLER_STATE_COLUMNS}
          FROM controller_state
          WHERE singleton = 1
        `,
      )
      .get();
    if (row === null) {
      throw new LedgerCorruptionError("ledger has no controller state");
    }
    return row;
  }

  #heartbeat(at: string): void {
    const expiresAt = this.#leaseExpiry(at);
    const changed = this.#database
      .query(
        `
          UPDATE ledger_owner
          SET heartbeat_at = ?, expires_at = ?
          WHERE singleton = 1 AND instance_id = ?
        `,
      )
      .run(at, expiresAt, this.#instanceId);
    if (changed.changes !== 1) {
      throw new LedgerOwnershipError(
        `controller instance '${this.#instanceId}' lost ledger ownership`,
      );
    }
  }

  #leaseExpiry(at: string): string {
    const milliseconds = Date.parse(at);
    if (!Number.isFinite(milliseconds)) {
      throw new LedgerCorruptionError("ledger owner timestamp is invalid");
    }
    return new Date(milliseconds + this.#ownerLeaseDurationMs).toISOString();
  }

  #syncExecutions(executions: readonly ExecutionRecord[], at: string): void {
    const statement = this.#database.query(
      `
        INSERT INTO executions (
          execution_id, project_id, lane, provider, workflow, claim_state,
          issue_number, pull_request_number, branch, worktree_id, head_sha,
          status, created_at, updated_at
        ) VALUES (
          $executionId, $projectId, $lane, $provider, $workflow, $claimState,
          $issueNumber, $pullRequestNumber, $branch, $worktreeId, $headSha,
          $status, $createdAt, $updatedAt
        )
        ON CONFLICT (execution_id) DO UPDATE SET
          project_id = excluded.project_id,
          lane = excluded.lane,
          provider = excluded.provider,
          workflow = excluded.workflow,
          claim_state = excluded.claim_state,
          issue_number = excluded.issue_number,
          pull_request_number = excluded.pull_request_number,
          branch = excluded.branch,
          worktree_id = excluded.worktree_id,
          head_sha = excluded.head_sha,
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
    );
    for (const execution of executions) {
      const validated = ExecutionRecordSchema.parse(execution);
      statement.run({ ...validated, createdAt: at, updatedAt: at });
    }
  }

  #syncCircuits(state: ControllerLocalState, at: string): void {
    const statement = this.#database.query(
      `
        INSERT INTO provider_circuits (
          provider, status, reason_code, opened_at, updated_at
        ) VALUES ($provider, $status, $reasonCode, $openedAt, $updatedAt)
        ON CONFLICT (provider) DO UPDATE SET
          status = excluded.status,
          reason_code = excluded.reason_code,
          opened_at = CASE
            WHEN excluded.status = 'open' AND provider_circuits.status = 'closed'
              THEN excluded.opened_at
            WHEN excluded.status = 'closed' THEN NULL
            ELSE provider_circuits.opened_at
          END,
          updated_at = excluded.updated_at
      `,
    );
    for (const provider of ["claude", "codex", "github", "reviewer"] as const) {
      const circuit = state.circuits[provider];
      statement.run({
        provider,
        status: circuit.status,
        reasonCode: circuit.reasonCode,
        openedAt: circuit.status === "open" ? at : null,
        updatedAt: at,
      });
    }
  }

  #requireExecution(executionId: string): ExecutionRecord {
    const row = this.#database
      .query<ExecutionRow, [string]>(
        `
          SELECT ${EXECUTION_COLUMNS}
          FROM executions
          WHERE execution_id = ?
        `,
      )
      .get(executionId);
    if (row === null) {
      throw new LedgerError(`unknown execution '${executionId}'`);
    }
    return parseExecution(row);
  }

  #getAttempt(executionId: string, attemptNumber: number): ExecutionAttempt {
    const row = this.#database
      .query<AttemptRow, [string, number]>(
        `
          SELECT ${EXECUTION_ATTEMPT_COLUMNS}
          FROM execution_attempts
          WHERE execution_id = ? AND attempt_number = ?
        `,
      )
      .get(executionId, attemptNumber);
    if (row === null) {
      throw new LedgerError(`unknown execution attempt '${executionId}/${attemptNumber}'`);
    }
    return parseAttempt(row);
  }

  #getProviderSession(sessionKey: string): ProviderSession {
    const row = this.#database
      .query<SessionRow, [string]>(
        `
          SELECT ${PROVIDER_SESSION_COLUMNS}
          FROM provider_sessions AS session
          WHERE session_key = ?
        `,
      )
      .get(sessionKey);
    if (row === null) {
      throw new LedgerError(`unknown provider session '${sessionKey}'`);
    }
    return parseSession(row);
  }

  #findMutationByIdempotencyKey(idempotencyKey: string): MutationRecord | null {
    this.#assertOwned();
    const row = this.#database
      .query<MutationRow, [string]>(
        `
          SELECT ${GITHUB_MUTATION_COLUMNS}
          FROM github_mutations
          WHERE idempotency_key = ?
        `,
      )
      .get(idempotencyKey);
    return row === null ? null : parseMutation(row);
  }

  #getMutation(mutationId: string): MutationRecord {
    const row = this.#database
      .query<MutationRow, [string]>(
        `
          SELECT ${GITHUB_MUTATION_COLUMNS}
          FROM github_mutations
          WHERE mutation_id = ?
        `,
      )
      .get(mutationId);
    if (row === null) {
      throw new LedgerError(`unknown GitHub mutation '${mutationId}'`);
    }
    return parseMutation(row);
  }

  #getMaintenanceRequest(requestId: string): MaintenanceRequest {
    const row = this.#database
      .query<MaintenanceRow, [string]>(
        `
          SELECT ${MAINTENANCE_REQUEST_COLUMNS}
          FROM maintenance_requests
          WHERE request_id = ?
        `,
      )
      .get(requestId);
    if (row === null) {
      throw new LedgerError(`unknown maintenance request '${requestId}'`);
    }
    return parseMaintenance(row);
  }

  #getRelease(releaseId: string): ReleaseRecord | null {
    this.#assertOwned();
    const row = this.#database
      .query<ReleaseRow, [string]>(
        `
          SELECT ${RELEASE_COLUMNS}
          FROM releases
          WHERE release_id = ?
        `,
      )
      .get(releaseId);
    return row === null ? null : parseRelease(row);
  }

  #insertAudit(kind: string, payload: unknown, at: string): AuditEvent {
    const parsedKind = AuditEventSchema.shape.kind.parse(kind);
    const sanitized: RedactedJson = sanitizeAuditJson(payload, this.#redaction);
    const inserted = this.#database
      .query(
        `
          INSERT INTO audit_events (timestamp, kind, payload_json)
          VALUES ($timestamp, $kind, $payloadJson)
        `,
      )
      .run({ timestamp: at, kind: parsedKind, payloadJson: encodeJson(sanitized) });
    const sequence =
      typeof inserted.lastInsertRowid === "bigint"
        ? Number(inserted.lastInsertRowid)
        : inserted.lastInsertRowid;
    return AuditEventSchema.parse({
      sequence,
      timestamp: at,
      kind: parsedKind,
      payload: sanitized,
    });
  }
}

function allowedMutationTransition(current: MutationState, next: MutationState): boolean {
  switch (current) {
    case "pending":
      return next === "applied" || next === "ambiguous" || next === "reconciled";
    case "applied":
      return next === "ambiguous" || next === "reconciled";
    case "ambiguous":
      return next === "reconciled";
    case "reconciled":
      return false;
  }
}

function allowedMaintenanceTransition(
  current: MaintenanceRequest["status"],
  next: MaintenanceRequest["status"],
): boolean {
  if (current === next) {
    return true;
  }
  switch (current) {
    case "pending":
      return next === "active" || next === "completed" || next === "cancelled";
    case "active":
      return next === "completed" || next === "cancelled";
    case "completed":
    case "cancelled":
      return false;
  }
}

export function openSqliteLedger(options: OpenSqliteLedgerOptions): SqliteLedger {
  return SqliteLedger.open(options);
}

export function restoreSqliteLedger(options: RestoreSqliteLedgerOptions): SqliteLedger {
  return SqliteLedger.restore(options);
}
