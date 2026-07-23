# Agent Factory

Agent Factory is a standalone, project-agnostic Bun/TypeScript controller that advances
explicitly configured GitHub projects from eligible issues to a revocable
`ready-to-merge` handoff. GitHub remains authoritative for workflow state, and the operator
remains the only merge authority.

This repository is under construction in eight implementation phases. Phases 1 through 5
establish the versioned integration contracts, deterministic planner, durable SQLite execution
ledger, GitHub reconciliation, provider runners/circuits, review/check convergence, Herdr worker
custody, factory mirror/worktree custody, and sanitized recovery. The checked-in defaults are
disabled observation mode: they launch no workers and make no GitHub mutations.

## Architecture

The controller is a deep module with exactly three operations:

- `status` reports observed and local scheduling state without changing it.
- `command` applies an explicit operator control change.
- `reconcile` compares GitHub observations with local execution state, gives external GitHub
  state precedence, and applies a deterministic plan when active mode is explicitly enabled.

The deterministic implementation sits behind that interface. GitHub access, the clock,
randomness, files, commands, process inspection, Git custody, worker processes, notifications,
and the execution ledger are injected adapters. Tests use deterministic scripted or in-memory
adapters; the production SQLite ledger does not add I/O to the controller.

```text
project profile YAML ──> strict versioned contracts
                                  │
GitHub observation adapter ──> controller <── SQLite execution-ledger adapter
                                  │
                         deterministic planner
                                  │
                    worker/process adapter + results
```

Target projects provide workflow entry points and policy as configuration. The controller knows
canonical lifecycle semantics but contains no target-specific issue ranking, skill names,
reviewer accounts, architecture policy, or source dependencies.

## Repository layout

```text
src/contracts/    versioned project-profile and worker-result protocols
src/domain/       canonical lifecycle semantics
src/controller/   three-operation controller and deterministic planner
src/adapters/     I/O adapter interfaces
src/testing/      deterministic in-memory adapters
src/ledger/       WAL SQLite adapter, repositories, migrations, backup and restore
src/github/       conditional API client, observation/reconciliation, guarded labels, App tokens
src/providers/    Claude/Codex runners, session persistence, verification, circuits and recovery
src/convergence/  current-head review/check convergence, feedback bounds and safe rerun policy
src/herdr/        guarded agent-factory session/pane custody and restart recovery
src/worktrees/    factory mirror/issue-worktree custody and cleanup eligibility
src/recovery/     reason codes, deterministic records, incidents and handoff coordination
src/redaction/    shared structured payload redaction boundary
tests/            contract, planner, ledger, migration and recovery tests plus fixtures
config/           configuration contract documentation and later examples
systemd/          future systemd user-service assets
docs/             documentation index and implementation plan
```

## Development

Prerequisites are Bun 1.3 or newer and Git. Install and validate with:

```sh
bun install
bun run validate
git diff --check
```

Canonical scripts are:

- `bun test` — deterministic Bun tests.
- `bun run typecheck` — strict TypeScript validation without emitting files.
- `bun run lint` — Biome formatting and lint checks.
- `bun run format` — write Biome formatting changes.
- `bun run validate` — typecheck, lint, then test.

Phase 5 includes guarded Herdr and Git command builders but no production service, CLI, XDG path
selection, or credential provisioning. Adapters receive custody roots, protected checkout paths,
state paths, HTTP, clocks, delays, randomness, IDs, process inspection, and command execution from
callers; Phase 6 will supply XDG and service composition.

## Contracts and safety

Project profiles and worker results carry schema version `1` and are parsed as untrusted input.
Every object is strict: unknown fields are rejected. Profile YAML may be loaded only through a
filesystem adapter from a regular file whose permission bits are exactly mode `0600`.

Global implementation, feedback, and ready-to-merge limits come from the documented
`AGENT_FACTORY_*_LIMIT` environment names, accept integers from zero through three, and default
to one. A project may lower any limit. Zero pauses the corresponding lane; a zero
ready-to-merge ceiling suppresses new implementation launches.

See [the documentation index](docs/README.md), [ledger guide](docs/ledger.md),
[GitHub integration guide](docs/github.md), [label migration guide](docs/label-migration.md),
[provider runner guide](docs/providers.md), [convergence guide](docs/convergence.md),
[Herdr custody guide](docs/herdr.md), [recovery guide](docs/recovery.md), and
[configuration notes](config/README.md).

## Documentation plan

Later phases will extend this foundation with dedicated, verified guidance for installation,
profiles, systemd operation, CLI implementation, rollout, updates and rollback, graceful
shutdown, notifications, security, testing, and troubleshooting. The documentation index records
the owning implementation phase so unfinished machinery is not presented as available.

## v1 boundaries

Agent Factory never merges, force-pushes, rebases, amends, dismisses reviews, bypasses branch
protection, provisions live credentials, silently falls back between models, or embeds a target
project's policy. Docker, Redis, message queues, web dashboards, webhooks, automatic rollout
promotion, and automatic external CLI upgrades are outside v1.
