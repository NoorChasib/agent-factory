# Documentation index

| Topic | Owning phase | State |
| --- | ---: | --- |
| Architecture, contracts, development, testing | 1 | Implemented |
| [SQLite ledger and recovery model](ledger.md) | 2 | Implemented |
| [GitHub App/API and reconciliation](github.md), [label migration](label-migration.md) | 3 | Implemented |
| [Provider runners and circuits](providers.md), [review/check convergence](convergence.md) | 4 | Implemented |
| [Herdr custody](herdr.md), [recovery records](recovery.md) | 5 | Implemented |
| [CLI reference](cli.md), [operations](operations.md) | 6 | Implemented |
| Immutable releases, activation, rollback | 7 | Upcoming |
| Final installation/rollout verification | 8 | Upcoming |

The root [`README`](../README.md) is the operator entry point. Phase 6 documentation covers XDG,
systemd assets, ntfy, disk guards, retention, rollout, graceful shutdown, reboot recovery,
security, and troubleshooting while clearly distinguishing the Phase 7 update machinery that
does not yet exist.

Post-v1 agent-assisted rebase/conflict repair, automatic rollout promotion, and automatic
external CLI upgrades remain unauthorized future work.
