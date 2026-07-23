# Immutable releases and self-update

## Release identity and layout

Every release ID is the lowercase 40- or 64-hex commit SHA of this factory repository. The
ledger enforces `release_id == commit_sha` and schema version 4 adds a unique commit index. A
release is installed once at:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/agent-factory/releases/
├── <factory-commit-sha>/
│   ├── bin/agent-factory
│   ├── bin/agent-factory-daemon
│   ├── release.json
│   ├── release-manifest.json
│   └── ...
└── current -> <factory-commit-sha>
```

The two `bin/` files in an installed commit directory are compiled standalone Bun executables,
not the source checkout's development shell wrappers. Release staging begins as a copy of the
validated checkout so it still contains the worker wrapper and other sources; the builder then
overwrites only `bin/agent-factory` and `bin/agent-factory-daemon` in staging with compiled output.
No external source-map files remain in `bin/`. The systemd `ExecStart` and operator CLI symlink
paths therefore stay stable across this packaging change.

`release.json` contains the strict semantic CLI version and required ledger schema version.
`agent-factory version` reads that file from the running artifact. The semantic version is human
facing; the immutable build/update identity is always the factory commit SHA.

The artifact tree is changed to read-only files and directories before its staging directory is
renamed to the commit path. The updater never modifies an installed commit directory. Activation
creates a new relative symlink and renames it over `current`; a failed rename leaves the old
pointer intact and removes the temporary link.

`release-manifest.json` is strict and contains:

- the exact factory commit;
- the injected build timestamp;
- the ledger schema version required by that release;
- a sorted inventory of every regular file and symlink except the manifest itself, including
  relative path, kind, byte count, installed mode, and SHA-256; and
- a SHA-256 over the canonical inventory.

The manifest and every inventory entry are revalidated before backup, before activation health,
and when an already-built candidate is reused.

## Candidate construction

The first installation uses:

```sh
bun run bootstrap -- <factory-commit-sha>
```

Bootstrap uses the same release builder/store validation as update, creates an
observation/observation ledger, activates `current`, and records the installed row. It refuses a
non-empty foreign release ledger or a different current/installed release and is idempotent for
the same commit. It has no GitHub, provider, target, credential, service, or rollout adapter.
After the first installation, use the queued update command.

`agent-factory update queue <factory-commit-sha>` builds a missing candidate before queueing it.
Production reads commits from the operator-maintained absolute
`AGENT_FACTORY_SOURCE_REPOSITORY`; source-tree development defaults to the running checkout.
There is no implicit fetch, clone, or credential provisioning, so the addressed commit must
already exist in that local factory Git repository. The production build adapter:

1. proves the commit object exists in the running factory repository;
2. creates a detached, commit-addressed Git worktree in the private release-build directory;
3. runs `bun install --frozen-lockfile`;
4. runs the repository's complete `bun run validate`;
5. verifies validation did not modify tracked files;
6. reads strict `release.json` and copies the validated checkout and installed dependencies into
   release staging;
7. compiles both staged release executables;
8. removes the temporary factory worktree.

After the adapter returns, the release store inventories and hashes the full staging tree,
including both compiled binaries, and writes the release manifest before the candidate becomes
queue-eligible.

Both the production adapter and the locally runnable
`bun run build:binaries -- <artifact-root>` command consume the same build-plan generator. Each
entrypoint is compiled with:

```text
bun build --compile --minify --sourcemap --bytecode \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  <entrypoint> --outfile <artifact>/bin/<name>
```

The entrypoints are exactly `src/cli/main.ts` and `src/daemon/main.ts`; no worker or provider
runner is compiled. `--compile` embeds the release's Bun runtime, while minification and bytecode
reduce load/parse work for faster startup. Bun embeds each source map in its executable and also
emits an entrypoint-named external map; the build plan deletes that redundant external file
immediately after each compilation, preventing the two `main.ts` entrypoints from colliding while
preserving mapped production diagnostics.
`--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` prevent the credential-handling
executables from silently loading `.env` or `bunfig.toml` from their runtime working directory.
Environment continues to arrive explicitly from the operator shell or systemd `EnvironmentFile`.
There is deliberately no `--target`: builds are native to the deployment host.

Bytecode is regenerated for every immutable release. Bun bytecode is tied to the Bun runtime
version that produced it, which is safe here because that exact runtime is embedded in the same
standalone executable rather than selected from the host at launch. Host Bun remains required for
release construction, source development/tests, and the spec-mandated
`bun <wrapper.ts> <spec>` worker command.

The command/process adapter is the only build execution seam. Tests replace it with scripted
builders and never run Git, Bun, systemctl, a provider, or the network. An install, validation, or
binary compilation failure creates a `failed` release row with no artifact path, never creates a
queued release, and cannot be retried under the same immutable commit identity.

This custody is only for this repository. It is separate from target mirror/worktree custody and
has no target project ID, repository profile, branch, issue, or pull request capability.

## Queue, drain, and restart-resumable phases

One queued release is permitted. Queueing captures the current controller mode, rollout stage,
effective limits, installed release, and database schema version, then requests a normal durable
maintenance drain. Candidate construction may happen while work is active, but no backup,
migration, pointer write, or restart happens until active execution count reaches zero.

The queued release remains in the existing `queued` ledger state while strict metadata records
restart-resumable phases:

```text
queued -> validated -> backup-created -> migrated -> restart-requested
```

The daemon poll loop advances this state after completing idle drains. Repeating a phase is
idempotent: an existing backup is reused, additive migrations are idempotent, and a pointer
already aimed at the candidate is recognized after restart. The updater does not add an
`activating` release status merely to duplicate this recovery metadata.

The temporary drain changes mode to `observation`, so reconciliation cannot mutate GitHub or
launch workers. Health requires the captured rollout stage and effective limits to remain
unchanged. On success or pre-switch failure, the updater clears only its own maintenance reason
and restores the prior mode unless another maintenance request still blocks launches. It never
promotes, demotes, changes limits, or enables a project.

## Backup, compatibility, and additive migration

Before the first migration, the live WAL-aware ledger `backup()` API serializes and integrity
checks a mode-`0600` snapshot at:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/agent-factory/release-backups/<candidate-sha>.sqlite3
```

Compatibility is checked before backup or pointer switch:

- `candidate required version < current database version` is a forbidden downgrade;
- the validated candidate must export a contiguous, non-destructive migration set whose length
  equals its manifest requirement; and
- the migration engine must recognize the existing history.

If the candidate requires a newer schema, its already-validated migration definitions are loaded
from the immutable factory artifact and applied by the migration engine. Each version remains its
own immediate transaction. A migration failure restores the pre-update backup and marks the
candidate `failed` without switching `current`.

## Switch and post-switch health

After migration, the updater rechecks that `current` still identifies the captured installed
release, atomically switches it to the candidate, records `restart-requested`, and asks the
injected service adapter for a non-blocking user-service restart. No test calls real systemd.

The new daemon sees the same queued record and current pointer on its startup poll. Health passes
only when all of these hold:

- the candidate manifest and full inventory still verify;
- `current` and the actually running release both equal the candidate SHA;
- the ledger schema exactly equals the manifest requirement;
- the service probe is healthy;
- controller mode is still the temporary observation drain and rollout stage/limits match the
  captured policy; and
- a post-switch recovery reconciliation completes with no invariant violations.

Only then does one SQLite transaction demote the prior installed row to `candidate`, promote the
new row to `installed`, and append the activation audit event.

## Automatic rollback and restore drill

Failed post-switch health performs this sequence:

1. atomically restore `current` to the captured prior commit;
2. close the candidate-schema ledger cleanly;
3. preserve it as `ledger.sqlite3.pre-rollback-<id>`;
4. restore the pre-migration serialized backup with the prior migration prefix;
5. reacquire the one-writer lease in the same ledger object;
6. mark the candidate `rolled-back` while the prior release remains `installed`;
7. restore the captured operational mode without changing rollout or limits;
8. send a redacted `update-rollback` ntfy alert; and
9. request a restart through the restored prior pointer.

If restoring the backup fails, the replacement API puts the quarantined database back and
reopens it rather than deleting the only usable ledger. Backups and quarantined candidate
databases are retained for operator audit; this phase does not add speculative purge policy.

The deterministic drill in `tests/releases.test.ts` opens a real schema-3 SQLite ledger, takes a
real serialized backup, applies additive schema 4, switches the pointer, scripts failed health,
then proves pointer restoration, schema-3 restore, installed/rolled-back rows, alerting, and
quarantine retention.

## Operator commands and boundaries

```sh
agent-factory update status
agent-factory update queue <40-or-64-lowercase-hex-factory-commit>
```

`status` reports the current pointer, running release, and ledger release rows. Queueing requires
an already installed release whose ledger row matches `current`; initial installation uses the
local bootstrap command above.

Self-update has no adapter for target mirrors, target worktrees, label mutation, providers,
Herdr, or CLI upgrades. Post-switch controller reconciliation is exposed only as a narrow health
signal and runs in observation mode. The factory never upgrades or rewrites Git, gh, Bun, Claude
Code, Codex, or Herdr as part of an update.
