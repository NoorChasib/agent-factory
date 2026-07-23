# Development and testing

## Complete validation

Use the locked dependency graph and the repository's single complete validation entry point:

```sh
bun install --frozen-lockfile
bun run validate
git diff --check
```

`bun run validate` runs, in order:

```text
tsc --noEmit
biome check .
bun test
```

No additional command is required to include migration/restore, adapter-fault, CLI, package,
release, fixture, drill, or sentinel coverage.

## Test design

Tests use `bun:test` and deterministic adapters. Clocks, IDs, random jitter, delays, disk
measurements, GitHub responses, commands, processes, file seams, notifications, provider
sessions, and service restart signals are injected. Tests never depend on wall-clock time,
ambient randomness, live GitHub, systemd, provider processes, or network access.

Temporary SQLite and filesystem tests use private temporary directories. Controller behavior is
tested through `status`, `command`, and `reconcile`; protocol behavior is tested through public
parsers, not planner internals.

## Verification map

The suite includes:

- strict profile/runtime/worker/daemon/CLI parsing and checked-in example/fixture loading;
- deterministic stage transitions, backlog ceilings, rotation, observation mode, and
  multi-project isolation/fairness;
- SQLite WAL/lease/migrations/backups/restores, mutation idempotency, audit, recovery, circuits,
  maintenance, and release rows;
- conditional GitHub observations, retry/reconcile faults, label migration, token brokerage, and
  forbidden mutations;
- Claude/Codex initialization, exact session/runtime resume, provider pause/resume, and
  current-head review/check convergence;
- mirror/worktree/Herdr custody, controller/reboot recovery, takeover, safe cleanup, and recovery
  comment redaction;
- CLI/socket routing, non-live/live doctor gating, logging/ntfy, disk thresholds, retention,
  shutdown-when-idle, and startup observation proof;
- immutable release manifests, initial bootstrap, queued update, migration, switch, health,
  rollback, and real SQLite restore drills; and
- structural source scans for target policy, forbidden imports/mutations, secrets, and paths.

Checked-in protocol/config examples are documentation artifacts and tests consume those exact
files so examples cannot drift from production validation.

## Contributor rules

Keep strict TypeScript options enabled, use existing dependencies, put I/O behind adapters, and
do not weaken tests. Target policy belongs in validated profile or test-fixture data. Do not use
real credentials or target mutations in development tests.
