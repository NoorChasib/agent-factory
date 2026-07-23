# Architecture and authority

Agent Factory is a standalone controller for one or more explicitly configured GitHub
repositories. Target repositories own their workflows and project policy. The factory owns
scheduling, execution custody, recovery, and audit, but never imports target code or
dependencies.

## Authority model

| State | Authority |
| --- | --- |
| Issue and pull-request lifecycle, labels, reviews, checks, merge state | GitHub |
| Repository/default branch, target workflows, labels, reviewers, checks, timeouts | Validated project profile |
| Active execution, provider session, custody, recovery, maintenance, circuit, audit | Local SQLite ledger |
| Factory release identity and files | Commit-addressed immutable release plus manifest |
| Merge decision, rollout promotion, credentials, App installation, live label migration | Operator |

Every reconcile starts from current GitHub observations. Local state cannot override a later
external mutation. Ambiguous writes are observed again before retry, and all target mutations
are guarded, idempotent, project-scoped, and recorded in the mutation ledger.

## Module boundaries

The controller exposes only `status`, `command`, and `reconcile`. A deterministic planner sits
behind that interface. Protocol and profile parsing is in `src/contracts/`, canonical
target-independent stage terminology is in `src/domain/`, and every I/O seam is in
`src/adapters/`. Tests use `src/testing/` adapters and exercise the controller boundary or public
contract parsers.

Operational composition surrounds, but does not widen, the controller:

```text
CLI ── strict JSON / owner-only Unix socket ── daemon router
                                                  │
                      ┌───────────────────────────┼───────────────────────────┐
                      ▼                           ▼                           ▼
             controller/planner            operations                  releases
                      │                 lifecycle, doctor,         immutable build,
          ┌───────────┼───────────┐       disk, retention          switch, rollback
          ▼           ▼           ▼
       GitHub      providers   custody/recovery
                      │
                 SQLite ledger
```

Production polling is 60 seconds with bounded injected jitter. Startup performs recovery and a
full reconcile before normal polling. The default persisted state is `mode: observation` and
`rolloutStage: observation`, whose lane caps are all zero.

## Project isolation

Project ID and repository identity scope mirror and worktree paths, GitHub App installation-token
cache entries, provider sessions, mutation keys, review baselines, scheduling counts, and audit
records. Deterministic round-robin rotation prevents one configured project from continuously
winning a lane when multiple projects are eligible.

Workers execute only target-owned workflow entry points inside the applicable target worktree.
They receive a short-lived reduced-permission installation token, never the GitHub App private
key. The factory has no merge, history-rewrite, review-dismissal, or branch-protection-bypass
operation.

## Failure and recovery model

The SQLite ledger uses WAL, a one-writer lease, additive migrations, serialized backups, and
append-only audit/incident history. Provider, GitHub, and reviewer failures open independent
circuits. Work remains resumable with its exact provider session and runtime. Herdr custody uses
one named factory session and identity-checks pane/process records before any action.

See [GitHub integration](github.md), [providers](providers.md),
[convergence](convergence.md), [Herdr custody](herdr.md), [ledger](ledger.md), and
[recovery](recovery.md) for the component contracts.
