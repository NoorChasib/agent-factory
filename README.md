# Agent Factory

Agent Factory is a standalone, project-agnostic Bun/TypeScript controller that advances
explicitly configured GitHub projects from eligible issues to a revocable
`ready-to-merge` handoff. GitHub remains authoritative for workflow state, and the operator
remains the only merge authority.

This repository is under construction in eight implementation phases. Phases 1 and 2 establish
the versioned integration contracts, deterministic planner, and durable SQLite execution ledger.
The checked-in defaults are disabled observation mode: they launch no workers and make no GitHub
mutations.

## Architecture

The controller is a deep module with exactly three operations:

- `status` reports observed and local scheduling state without changing it.
- `command` applies an explicit operator control change.
- `reconcile` compares GitHub observations with local execution state, gives external GitHub
  state precedence, and applies a deterministic plan when active mode is explicitly enabled.

The deterministic implementation sits behind that interface. GitHub access, the clock,
randomness, files, worker processes, notifications, and the execution ledger are injected
adapters. Tests use deterministic in-memory adapters; Phase 2 adds the production SQLite ledger
adapter without adding I/O to the controller.

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

Phase 2 includes the production SQLite persistence adapter, but no production service, CLI,
GitHub client, or credential provisioning. The adapter receives its state directory and all
clock/ID sources from callers; Phase 6 will supply XDG and service wiring.

## Contracts and safety

Project profiles and worker results carry schema version `1` and are parsed as untrusted input.
Every object is strict: unknown fields are rejected. Profile YAML may be loaded only through a
filesystem adapter from a regular file whose permission bits are exactly mode `0600`.

Global implementation, feedback, and ready-to-merge limits come from the documented
`AGENT_FACTORY_*_LIMIT` environment names, accept integers from zero through three, and default
to one. A project may lower any limit. Zero pauses the corresponding lane; a zero
ready-to-merge ceiling suppresses new implementation launches.

See [the documentation index](docs/README.md), [ledger guide](docs/ledger.md), and
[configuration notes](config/README.md).

## Documentation plan

Later phases will extend this foundation with dedicated, verified guidance for installation,
GitHub App setup, profiles, environment variables, GitHub reconciliation and label migration,
provider runners and circuits, Herdr attachment, systemd operation, CLI commands, rollout,
updates and rollback, graceful shutdown, recovery/takeover, notifications, security, testing,
and troubleshooting. The documentation index records the owning implementation phase so
unfinished machinery is not presented as available.

## v1 boundaries

Agent Factory never merges, force-pushes, rebases, amends, dismisses reviews, bypasses branch
protection, provisions live credentials, silently falls back between models, or embeds a target
project's policy. Docker, Redis, message queues, web dashboards, webhooks, automatic rollout
promotion, and automatic external CLI upgrades are outside v1.
