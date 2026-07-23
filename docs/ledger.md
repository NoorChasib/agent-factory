# SQLite execution ledger

Phase 2 adds the controller's durable local execution ledger. It is deliberately narrower than
the GitHub model: GitHub remains authoritative for issue and pull-request lifecycle, claims,
labels, heads, reviews, checks, and merge state. If a local record disagrees with a current GitHub
observation, reconciliation must accept GitHub and repair the local execution plan. The ledger is
authoritative only for controller ownership, local executions and attempts, provider resume
identity, process recovery metadata, mutation reconciliation, maintenance, release bookkeeping,
and audit history.

## On-disk layout and connection policy

The production adapter receives a state-directory path. It does not select or create an XDG
directory; Phase 6 owns that wiring. The directory must already exist and be writable.

```text
<injected-state-directory>/
├── ledger.sqlite3
├── ledger.sqlite3-wal    # transient while WAL work is pending
└── ledger.sqlite3-shm    # transient WAL shared-memory file
```

A newly created main database is mode `0600`. SQLite uses WAL journal mode,
`synchronous=NORMAL`, foreign-key enforcement, a zero busy timeout so ownership conflicts fail
loudly, and the default 1,000-page WAL auto-checkpoint threshold. Open performs `quick_check`
before applying migrations. A corrupt database, missing/non-directory state path, unsupported
schema history, or unavailable filesystem fails open instead of falling back to volatile state.

The adapter requires injected clock, ID source, controller instance ID, and initial controller
state. Ledger code does not call the wall clock or ambient randomness. The initial state is used
only when the database has no controller snapshot; reopening never overwrites durable state.

## One-writer ownership

`ledger_owner` is a singleton lease acquired in a `BEGIN IMMEDIATE` transaction. Every repository
write verifies the instance ID in that row in its own immediate transaction. A second controller
cannot open the ledger while the current lease is valid. The default lease is five minutes; the
duration is injectable for deterministic tests. Controller-state reads, all writes, and explicit
lease renewal extend the lease using the injected clock.

After an abnormal termination, a new controller may take ownership only after the recorded lease
expires. Acquisition and replacement are atomic, so two contenders cannot both acquire the row.
The displaced instance fails its next read or write. Clean close records an audit event and
releases the row. This is the enforcement available within SQLite; filesystem access to the state
directory must still be limited to the service account.

The controller snapshot uses an independent monotonically increasing revision. `commit` updates
only when the supplied expected revision matches. A stale commit raises a typed conflict and the
transaction preserves the prior snapshot and repository rows.

## Schema

All tables are `STRICT`; JSON columns have `json_valid` checks and are parsed again through
strict application schemas when read.

| Table | Purpose and key guarantees |
| --- | --- |
| `schema_migrations` | Ordered schema version, migration name, and injected application timestamp. |
| `ledger_owner` | Singleton controller instance lease, heartbeat, and expiration. |
| `controller_state` | Singleton validated planner snapshot and optimistic revision. |
| `executions` | Durable execution identity, target-neutral lane/workflow ownership, claim, subject, branch/worktree/head, and status. Historical rows are not deleted when snapshots are synchronized. |
| `execution_attempts` | Monotonic attempt history per execution with start/finish, status, checkpoint, outcome, and reason. |
| `provider_sessions` | Claude/Codex session or thread ID plus exact model, reasoning effort, and validated JSON runtime metadata for resume. |
| `process_metadata` | Current pane/process/start-time/host identity and runtime metadata. Phase 5 populates the Herdr custody and inspected process-tree values without a migration. |
| `github_mutations` | Intended mutation, unique idempotency key, result, and `pending`/`applied`/`ambiguous`/`reconciled` state. Terminal reconciliation cannot move backward. |
| `review_baselines` | Per-project/per-PR current head plus review/check observation and quiescent-poll count. |
| `provider_circuits` | Claude, Codex, GitHub, and reviewer circuit state, reason, open time, and update time. Controller snapshot commits keep these rows synchronized. |
| `maintenance_requests` | Pause, resume, drain, and shutdown-when-idle requests with constrained lifecycle state. |
| `releases` | Installed, queued, candidate, failed, and rolled-back release metadata. Partial unique indexes permit at most one installed and one queued release. |
| `audit_events` | Monotonic SQLite sequence, injected timestamp, kind, and sanitized JSON payload. |

Execution recovery reads executions, attempts, provider sessions, and process metadata as one
validated aggregate after reopening the database. Mutation idempotency returns the existing
record only when the full intent matches; reuse for different intent fails.

Audit has append-only insert/list methods. Database triggers reject `UPDATE` and `DELETE` even if
accidental SQL bypasses the repository API. Audit input is normalized to finite, acyclic JSON and
passes through the shared Phase 5 structured redaction boundary. Secret-like keys, GitHub/bearer
tokens, PEM blocks, configured environment echoes, absolute filesystem paths, and over-limit
text fields are replaced before storage. Callers must still avoid collecting confidential
project content.

## Additive migrations

Migrations are contiguous, named, and ordered from version 1. The engine rejects gaps, renamed
known versions, histories newer than its migration set, and attempts to open a newer database
with an older migration set. A migration containing destructive schema operations such as
`DROP`, column removal, or table rename is rejected. Each pending migration and its history row
commit in one immediate transaction; a statement fault rolls back that entire version while
leaving earlier versions intact. Reopening at the current version is idempotent.

Phase 2 has three schema versions:

1. execution/session/process recovery, controller state and owner, and audit;
2. mutations, review baselines, circuits, and maintenance;
3. release state.

Future versions must be additive. A release requiring a schema newer than the running binary is
rejected.

## Backup and restore

`backup(path)` first commits its audit/lease update, then uses SQLite serialization to capture the
connection's consistent view, including WAL-visible pages. It writes a mode-`0600` task-specific
temporary file, opens that snapshot for `quick_check` and schema verification, and atomically
installs it without overwriting a destination that must not already exist. It never copies a live
main database file while ignoring its WAL.

Restore is intentionally non-destructive: the target state directory must contain no main, WAL,
or shared-memory ledger file. Restore writes the serialized backup to a temporary SQLite file,
checks integrity, applies any pending compatible additive migrations, removes the backed-up
owner lease, checkpoints it into a standalone main database, and atomically installs it. Normal
open then enables WAL and acquires a fresh owner lease. Corrupt backups and unknown/newer schema
histories fail before installation.

## Retention concepts

This phase supplies durable records and no purge API. In particular:

- audit events are append-only;
- attempt and session history remains available for restart and incident reconstruction;
- stalled or operator-required recovery state must remain until explicit release;
- mutation intent remains until reconciliation can prove the GitHub outcome; and
- release rows remain available to Phase 7 update/rollback machinery.

Phase 5 computes merged-worktree cleanup eligibility at the exact 24-hour boundary and retains
stalled/operator state until explicit release. Phase 6 owns scheduling that cleanup, and later
retention work may remove detailed merged execution logs after 30 days. Retention must not delete
unreconciled mutations, active ownership, audit history, or preserved handoff state.
