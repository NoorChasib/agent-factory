# Documentation index

| Topic | Owning phase | State |
| --- | ---: | --- |
| Architecture, contracts, development, testing | 1 | Implemented |
| [SQLite ledger and recovery model](ledger.md) | 2 | Implemented |
| [GitHub App/API and reconciliation](github.md), [label migration](label-migration.md) | 3 | Implemented |
| [Provider runners and circuits](providers.md), [review/check convergence](convergence.md) | 4 | Implemented |
| [Herdr custody](herdr.md), [recovery records](recovery.md) | 5 | Implemented |
| [CLI reference](cli.md), [operations](operations.md) | 6 | Implemented |
| [Immutable releases, activation, rollback](updates.md) | 7 | Implemented |
| Final installation/rollout verification | 8 | Upcoming |

The root [`README`](../README.md) is the operator entry point. Phase 7 adds release building,
queue/drain/application, compatibility gating, atomic activation, post-switch health, SQLite
restore, and automatic rollback. Phase 8 still owns initial production installation and final
rollout verification.

[Post-v1 work](post-v1.md) records agent-assisted rebase/conflict repair, automatic rollout
promotion, and controlled external CLI upgrades as unauthorized future work.
