# Agent Factory

Agent Factory is a standalone, project-agnostic Bun/TypeScript controller that advances work in
explicitly enabled GitHub repositories from eligible issues to a revocable `ready-to-merge`
handoff. GitHub is authoritative for workflow state. The local SQLite ledger owns only execution,
session, recovery, maintenance, rollout, circuit, release, and audit state. The operator remains
the only merge authority.

The checked-in runtime starts in disabled observation mode with rollout stage `observation`.
Installation alone cannot launch workers, mutate GitHub, migrate labels, promote rollout, merge,
or provision credentials.

## Architecture

The controller retains its three-operation boundary:

- `status` observes GitHub and reports scheduling state without changing it.
- `command` applies a validated explicit control change.
- `reconcile` gives current GitHub state precedence and applies a deterministic plan only when
  active mode and an attended rollout stage permit it.

The daemon adds operational composition around that boundary:

```text
agent-factory CLI
        │ strict JSON over mode-0600 Unix socket
        ▼
daemon router ── maintenance / rollout / disk / retention / doctor
        │
        ├── controller: status / command / reconcile
        ├── SQLite WAL ledger and append-only audit
        ├── GitHub App broker, observations, guarded mutations
        ├── Claude/Codex runners, circuits, convergence
        ├── Herdr and factory-owned Git custody
        ├── immutable factory releases, health, and rollback
        └── redacted JSON logs and ntfy notifications
```

All clocks, random values, delays, HTTP, disk measurements, commands, processes, files, Git
custody, notifications, and persistence are injected. The polling loop is a deterministic
one-tick module; production repeats it at 60 seconds with controller-computed jitter.

Repository layout:

```text
src/contracts/    strict untrusted profile, worker, and daemon protocols
src/domain/       canonical stages and attended rollout caps
src/controller/   three-operation controller and planner
src/ledger/       SQLite WAL, recovery, maintenance, circuits, releases, audit
src/github/       App tokens, reads, guarded mutations, label migration
src/providers/    Claude/Codex runners, session persistence, circuits
src/convergence/  current-head review/check convergence
src/herdr/        dedicated-session custody and reboot re-association
src/worktrees/    mirror/worktree custody and safe cleanup eligibility
src/recovery/     sanitized recovery comments, incidents, handoffs
src/operations/   XDG, lifecycle, disk, retention, logging, ntfy, doctor
src/releases/     manifest, builder, immutable store/pointer, health, updater
src/cli/          dependency-free argument parser and Unix-socket client
src/daemon/       validated socket server, router, poll loop, composition
src/adapters/     production I/O adapters
src/testing/      deterministic scripted and in-memory adapters
systemd/          agent-factory.service user unit
```

## Prerequisites

- Linux with `systemd --user` and Unix-domain sockets
- Bun 1.3 or newer
- Git, GitHub CLI (`gh`), Claude Code, Codex, and Herdr on the service `PATH`
- a GitHub App installed only on explicitly enabled target repositories
- an ntfy topic reachable over HTTPS

The controller does not require Docker, Redis, a queue, a dashboard, or a target application's
runtime database.

## Installation

Install dependencies for development:

```sh
bun install --frozen-lockfile
bun run validate
```

Copy and edit the disabled checked-in profile examples, then bootstrap the first immutable
release from an exact local factory commit:

```sh
export AGENT_FACTORY_SOURCE_REPOSITORY=/absolute/path/to/agent-factory
bun run bootstrap -- "$(git rev-parse HEAD)"
```

Bootstrap performs frozen installation and complete validation in a detached checkout, installs
the read-only artifact, initializes the observation-mode ledger, and creates the `current`
pointer. It does not contact GitHub/providers or require credentials. Follow
[`docs/installation.md`](docs/installation.md) for prerequisites, mode-`0600` configuration,
CLI installation, and the explicit service-enablement sequence. The systemd unit and credential
override are documented in [`systemd/README.md`](systemd/README.md).

## XDG configuration

Runtime paths are derived once at composition and injected everywhere:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/
  config.yaml                  mode 0600
  profiles/*.yaml             mode 0600
${XDG_STATE_HOME:-$HOME/.local/state}/agent-factory/
  ledger.sqlite3              mode 0600, WAL
  agent-factory.sock          mode 0600
  logs/                       mode 0700
  release-backups/            mode 0700
  release-builds/             mode 0700, temporary detached checkouts
${XDG_DATA_HOME:-$HOME/.local/share}/agent-factory/
  mirrors/ worktrees/ releases/
```

All Agent Factory directories are mode `0700`. Overlong Unix socket paths are rejected with
guidance to shorten `XDG_STATE_HOME`. Configuration and profiles are strict YAML: duplicate and
unknown keys fail validation, and profile paths cannot escape `profiles/`.

Example `config.yaml`:

```yaml
schemaVersion: 1
profiles:
  - profiles/example.yaml
ntfy:
  baseUrl: https://ntfy.sh
  topic: private-agent-factory-topic
logging:
  rotateBytes: 10485760
  retainedFiles: 5
```

See [`config/README.md`](config/README.md) for the complete environment table and
[`docs/profiles.md`](docs/profiles.md) for the profile and worker-result contracts.

## GitHub App and credentials

Follow [`docs/github-app.md`](docs/github-app.md) for App creation, exact permissions,
target-only installation, and systemd credential provisioning. See
[`docs/github.md`](docs/github.md) for observation, retry, mutation, and token behavior.
The non-secret App ID is `AGENT_FACTORY_GITHUB_APP_ID`. The PEM must be supplied as a systemd
credential and referenced by the absolute
`AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE` credential path. Never store PEM contents in an
environment file, repository, profile, worker environment, log, or notification.

The broker resolves the installation for each explicitly enabled profile and mints short-lived,
reduced-permission tokens. It never installs the App or changes repository access.

## Profiles and environment

Profiles own repository identity, workflow entry points, lifecycle-label mapping, review/check
policy, timeouts, and optional lower ceilings. The controller contains no target-specific skill,
reviewer, milestone, product, or architecture policy.

Operator environment values:

```text
AGENT_FACTORY_IMPLEMENTATION_LIMIT=1
AGENT_FACTORY_FEEDBACK_LIMIT=1
AGENT_FACTORY_READY_TO_MERGE_LIMIT=1
AGENT_FACTORY_CLAUDE_MODEL=claude-fable-5
AGENT_FACTORY_CLAUDE_EFFORT=high
AGENT_FACTORY_GITHUB_APP_ID=<positive integer>
AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE=<systemd credential path>
AGENT_FACTORY_SOURCE_REPOSITORY=<absolute local factory Git repository>
```

Each limit accepts `0` through `3`. Effective limits are the minimum of the rollout-stage cap,
environment limit, and project ceiling. Changes apply only to later launches. No silent model
fallback or paid-credit enablement exists.

## Operation

The installed operator command is `agent-factory`. Routine commands use strict JSON over the
local socket and fail clearly when the daemon is absent. `help`, `version`, and non-live `doctor`
work without the daemon.

Common commands:

```sh
agent-factory status
agent-factory workers
agent-factory show execution-123
agent-factory pause
agent-factory rollout promote
agent-factory reconcile
agent-factory notifications digest
agent-factory shutdown --when-idle
```

See [`docs/cli.md`](docs/cli.md) for the complete grammar and
[`docs/operations.md`](docs/operations.md) for systemd, Herdr, rollout, disk, retention,
shutdown, and reboot recovery.

### Herdr attachment and takeover

Only the dedicated `agent-factory` Herdr session is in scope. Each outer worker owns one pane.
Attaching does not change worker custody; takeover records attended operator custody. Stop and
kill resolve the recorded factory pane/process identity and never target unrelated sessions.

```sh
agent-factory worker attach <execution>
agent-factory worker takeover <execution>
agent-factory worker resume <execution>
agent-factory worker release <execution>
```

### Rollout

Rollout is attended and durable:

| Stage | Hard cap |
| --- | --- |
| `observation` | `0/0/0` |
| `stage1` | `1/1/1` |
| `stage2` | `2/2/2` |
| `stage3` | `3/3/3` |

Only adjacent explicit `rollout promote` and `rollout demote` transitions are accepted. Promotion
from observation enables active mode; demotion to observation disables it. There is no automatic
promotion.

### Shutdown and recovery

Before a planned reboot:

```sh
agent-factory shutdown --when-idle
```

The request is durable, blocks new launches, waits for active work, verifies recovery data, stops
only factory-owned processes, completes its maintenance record, and sends the ntfy
“ready to restart” alert. On daemon startup, Herdr pane/process identity is reconciled against the
ledger; running work is re-associated, exited work is classified, orphaned work is retained for
recovery, stale shutdown intent is cleared, and a recovery reconcile runs before polling.

## Label migration and updates

Label migration is target-scoped, deterministic, previewed, and exact-hash approved:

```sh
agent-factory labels plan <project>
agent-factory labels preview <project>
agent-factory labels apply <project> --hash <sha256>
```

See [`docs/label-migration.md`](docs/label-migration.md). Installation never applies labels.

Factory updates are immutable and commit-addressed:

```sh
agent-factory update status
agent-factory update queue <factory-commit-sha>
```

Queueing builds a detached checkout of this repository with frozen dependencies and full
validation, records a durable drain, and waits for active work. The updater then verifies the
manifest, backs up SQLite, applies compatible additive migrations, atomically switches
`releases/current`, restarts through the service adapter, and runs post-switch health plus
reconciliation. Failed health automatically restores the prior pointer and database, records
`rolled-back`, alerts, and restarts the prior release.

The path has no target mirror/worktree/provider/CLI-upgrade adapters and never promotes rollout
or changes configured limits. See [`docs/updates.md`](docs/updates.md) and the explicitly
unauthorized [`docs/post-v1.md`](docs/post-v1.md).

## Security

- GitHub remains workflow authority; SQLite cannot override external lifecycle state.
- The mutation and Git guards contain no merge, force-push, rebase, amend, review-dismissal, or
  branch-protection bypass operation.
- Workers never inherit the GitHub App PEM.
- Structured logs, audit payloads, recovery records, daemon errors, and notifications pass
  through the shared redaction boundary.
- Absolute VPS paths, tokens, bearer credentials, PEM blocks, prompts, and configured environment
  sentinels are removed before output.
- The socket and configuration are owner-only; XDG directories are mode `0700`.
- `doctor --live` is the only diagnostic mode allowed to make provider-consuming probes.

See [`docs/security.md`](docs/security.md) for trust boundaries, credential handling, process
custody, redaction, and the safe deployment state.

## Development and testing

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run validate
git diff --check
```

Tests use `bun:test`, injected clocks/random/delays/disk/HTTP/process adapters, temporary local
files where necessary, and no real daemon, systemd, provider, or network process. The complete
suite covers contracts, planning, SQLite recovery, GitHub mutation safety, provider behavior,
Herdr/worktree custody, CLI/socket protocol, maintenance/rollout, exact disk and retention
thresholds, shutdown/reboot, immutable manifests, atomic pointer faults, additive update
migration/restore drills, redaction/rotation, ntfy, doctor gating, XDG modes, and the unit text.
See [`docs/testing.md`](docs/testing.md) for the complete verification map.

## Troubleshooting

- **Daemon unavailable:** run `agent-factory doctor`; then inspect the user unit with
  `systemctl --user status agent-factory.service`.
- **Config rejected:** ensure `config.yaml` and every profile are regular mode-`0600` files and
  all Agent Factory directories are mode `0700`.
- **Socket path too long:** set a shorter absolute `XDG_STATE_HOME` consistently for the service
  and CLI.
- **Launches paused:** inspect `status`, `circuits`, maintenance records, rollout stage, and disk
  usage. Disk recovery clears the guard record but requires explicit operator resume.
- **Worker unavailable after reboot:** use `show`, then attach/takeover/resume or explicitly
  release retained custody.
- **Notification failure:** validate the HTTPS ntfy base URL/topic and run
  `agent-factory notifications test`.
- **Update waiting:** inspect active executions and the self-update drain in `status`; the
  pointer cannot switch until active work reaches zero.
- **Update rolled back:** inspect `update status`, the ntfy reason, retained release backup, and
  quarantined pre-rollback ledger before deciding whether to queue a different commit.

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for credential, convergence, migration,
worker recovery, and reboot-specific diagnosis.

The v1 exclusions remain automatic merge, webhooks, dashboards, automatic rollout promotion,
automatic external CLI upgrades, project-runtime coupling, history rewriting, review dismissal,
and branch-protection bypass.
