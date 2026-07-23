import type { Database } from "bun:sqlite";

import type { ClockAdapter } from "../adapters/interfaces";
import { LedgerMigrationError } from "./errors";

export interface LedgerMigration {
	readonly version: number;
	readonly name: string;
	readonly statements: readonly string[];
}

interface AppliedMigrationRow {
	readonly version: number;
	readonly name: string;
}

const MIGRATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DESTRUCTIVE_SCHEMA_SQL =
	/\b(?:DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)|TRUNCATE|ALTER\s+TABLE\s+\S+\s+(?:DROP|RENAME))\b/iu;

function timestamp(clock: ClockAdapter): string {
	const value = clock.now();
	if (!Number.isFinite(value.getTime())) {
		throw new LedgerMigrationError("migration clock returned an invalid date");
	}
	return value.toISOString();
}

export function validateLedgerMigrations(migrations: readonly LedgerMigration[]): void {
	if (migrations.length === 0) {
		throw new LedgerMigrationError("at least one ledger migration is required");
	}
	for (const [index, migration] of migrations.entries()) {
		const expectedVersion = index + 1;
		if (migration.version !== expectedVersion) {
			throw new LedgerMigrationError(
				`ledger migrations must be contiguous and ordered: expected version ${expectedVersion}, received ${migration.version}`,
			);
		}
		if (!MIGRATION_NAME.test(migration.name)) {
			throw new LedgerMigrationError(`invalid ledger migration name '${migration.name}'`);
		}
		if (migration.statements.length === 0) {
			throw new LedgerMigrationError(`ledger migration ${migration.version} has no statements`);
		}
		for (const statement of migration.statements) {
			if (DESTRUCTIVE_SCHEMA_SQL.test(statement)) {
				throw new LedgerMigrationError(
					`ledger migration ${migration.version} contains destructive schema SQL`,
				);
			}
		}
	}
}

function bootstrapMigrationTable(database: Database): void {
	database
		.transaction(() => {
			database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
		})
		.immediate();
}

export function readSchemaVersion(database: Database): number {
	const row = database
		.query<{ version: number | null }, []>("SELECT MAX(version) AS version FROM schema_migrations")
		.get();
	return row?.version ?? 0;
}

export function applyLedgerMigrations(
	database: Database,
	clock: ClockAdapter,
	migrations: readonly LedgerMigration[] = LEDGER_MIGRATIONS,
): number {
	validateLedgerMigrations(migrations);
	bootstrapMigrationTable(database);

	const applied = database
		.query<AppliedMigrationRow, []>("SELECT version, name FROM schema_migrations ORDER BY version")
		.all();
	for (const [index, row] of applied.entries()) {
		const expectedVersion = index + 1;
		if (row.version !== expectedVersion) {
			throw new LedgerMigrationError(
				`ledger schema history has a gap before version ${row.version}`,
			);
		}
		const known = migrations[index];
		if (known === undefined) {
			throw new LedgerMigrationError(
				`ledger schema version ${row.version} is newer than supported version ${migrations.length}; downgrade is forbidden`,
			);
		}
		if (known.name !== row.name) {
			throw new LedgerMigrationError(
				`ledger schema version ${row.version} is unknown: recorded '${row.name}', expected '${known.name}'`,
			);
		}
	}

	for (const migration of migrations.slice(applied.length)) {
		database
			.transaction(() => {
				for (const statement of migration.statements) {
					database.exec(statement);
				}
				database
					.query(
						"INSERT INTO schema_migrations (version, name, applied_at) VALUES ($version, $name, $appliedAt)",
					)
					.run({
						version: migration.version,
						name: migration.name,
						appliedAt: timestamp(clock),
					});
			})
			.immediate();
	}

	return readSchemaVersion(database);
}

export const LEDGER_MIGRATIONS: readonly LedgerMigration[] = [
	{
		version: 1,
		name: "execution-recovery-core",
		statements: [
			`
        CREATE TABLE ledger_owner (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          instance_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE controller_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state_json TEXT NOT NULL CHECK (json_valid(state_json)),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE executions (
          execution_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          lane TEXT NOT NULL CHECK (lane IN ('implementation', 'feedback')),
          provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
          workflow TEXT NOT NULL,
          claim_state TEXT NOT NULL CHECK (
            claim_state IN ('selecting', 'awaiting-verification', 'verified')
          ),
          issue_number INTEGER CHECK (issue_number IS NULL OR issue_number > 0),
          pull_request_number INTEGER CHECK (
            pull_request_number IS NULL OR pull_request_number > 0
          ),
          branch TEXT,
          worktree_id TEXT,
          head_sha TEXT,
          status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'released')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX executions_project_status
          ON executions (project_id, status);

        CREATE TABLE execution_attempts (
          execution_id TEXT NOT NULL REFERENCES executions(execution_id),
          attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
          status TEXT NOT NULL CHECK (
            status IN (
              'active',
              'completed',
              'blocked',
              'operator-required',
              'provider-limit',
              'stalled',
              'failed',
              'released'
            )
          ),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          checkpoint TEXT,
          outcome TEXT,
          reason_code TEXT,
          PRIMARY KEY (execution_id, attempt_number)
        ) STRICT;

        CREATE TABLE provider_sessions (
          session_key TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
          provider_session_id TEXT NOT NULL,
          model TEXT NOT NULL,
          reasoning_effort TEXT NOT NULL,
          runtime_metadata_json TEXT NOT NULL CHECK (json_valid(runtime_metadata_json)),
          created_at TEXT NOT NULL,
          last_resumed_at TEXT,
          FOREIGN KEY (execution_id, attempt_number)
            REFERENCES execution_attempts(execution_id, attempt_number),
          UNIQUE (provider, provider_session_id)
        ) STRICT;

        CREATE INDEX provider_sessions_execution
          ON provider_sessions (execution_id, attempt_number);

        CREATE TABLE process_metadata (
          execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
          attempt_number INTEGER CHECK (attempt_number IS NULL OR attempt_number > 0),
          pane_id TEXT,
          process_id INTEGER CHECK (process_id IS NULL OR process_id > 0),
          process_started_at TEXT,
          host_identity TEXT,
          runtime_metadata_json TEXT NOT NULL CHECK (json_valid(runtime_metadata_json)),
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
        ) STRICT;

        CREATE TRIGGER audit_events_no_update
        BEFORE UPDATE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'audit events are append-only');
        END;

        CREATE TRIGGER audit_events_no_delete
        BEFORE DELETE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'audit events are append-only');
        END;
      `,
		],
	},
	{
		version: 2,
		name: "reconciliation-and-maintenance",
		statements: [
			`
        CREATE TABLE github_mutations (
          mutation_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          execution_id TEXT REFERENCES executions(execution_id),
          kind TEXT NOT NULL,
          subject_type TEXT NOT NULL CHECK (
            subject_type IN ('issue', 'pull-request', 'repository')
          ),
          subject_number INTEGER CHECK (subject_number IS NULL OR subject_number > 0),
          intended_mutation_json TEXT NOT NULL CHECK (json_valid(intended_mutation_json)),
          idempotency_key TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (
            state IN ('pending', 'applied', 'reconciled', 'ambiguous')
          ),
          result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX github_mutations_reconcile_queue
          ON github_mutations (state, project_id, created_at);

        CREATE TABLE review_baselines (
          project_id TEXT NOT NULL,
          pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
          head_sha TEXT NOT NULL,
          review_observation_json TEXT NOT NULL CHECK (json_valid(review_observation_json)),
          check_observation_json TEXT NOT NULL CHECK (json_valid(check_observation_json)),
          quiescent_poll_count INTEGER NOT NULL CHECK (quiescent_poll_count >= 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, pull_request_number)
        ) STRICT;

        CREATE TABLE provider_circuits (
          provider TEXT PRIMARY KEY CHECK (
            provider IN ('claude', 'codex', 'github', 'reviewer')
          ),
          status TEXT NOT NULL CHECK (status IN ('closed', 'open')),
          reason_code TEXT,
          opened_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE maintenance_requests (
          request_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (
            kind IN ('pause', 'resume', 'drain', 'shutdown-when-idle')
          ),
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'active', 'completed', 'cancelled')
          ),
          reason_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX maintenance_requests_status
          ON maintenance_requests (status, created_at);
      `,
		],
	},
	{
		version: 3,
		name: "release-state",
		statements: [
			`
        CREATE TABLE releases (
          release_id TEXT PRIMARY KEY,
          commit_sha TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('installed', 'queued', 'candidate', 'failed', 'rolled-back')
          ),
          artifact_path TEXT,
          required_schema_version INTEGER NOT NULL CHECK (required_schema_version > 0),
          metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX releases_one_installed
          ON releases ((1))
          WHERE status = 'installed';

        CREATE UNIQUE INDEX releases_one_queued
          ON releases ((1))
          WHERE status = 'queued';
      `,
		],
	},
	{
		version: 4,
		name: "release-commit-identity",
		statements: [
			`
        CREATE UNIQUE INDEX releases_commit_sha_unique
          ON releases (commit_sha);
      `,
		],
	},
];

export const CURRENT_LEDGER_SCHEMA_VERSION = LEDGER_MIGRATIONS.length;
