# Documentation index

Documentation grows with the implementation instead of describing unavailable behavior as
finished.

| Topic | Owning phase | Current state |
| --- | ---: | --- |
| Architecture, contracts, development, testing | 1 | Foundation in `README.md` and source docs |
| [SQLite ledger and recovery model](ledger.md) | 2 | Implemented |
| [GitHub App/API and reconciliation](github.md), [label migration](label-migration.md) | 3 | Implemented |
| [Provider runners and circuits](providers.md), [review/check convergence](convergence.md) | 4 | Implemented |
| [Herdr worker custody](herdr.md), [recovery records, redaction, and retained work](recovery.md) | 5 | Implemented |
| CLI, systemd, XDG config, ntfy, disk guards, shutdown, doctor | 6 | Planned |
| Immutable releases, updates, rollback | 7 | Planned |
| Installation, rollout, security, operations, troubleshooting | 8 | Planned verification |

Post-v1 agent-assisted rebase/conflict repair, automatic rollout promotion, and automatic external
CLI upgrades are documentation-only future work and are not authorized v1 behavior.
