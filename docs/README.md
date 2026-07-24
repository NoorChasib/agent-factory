# Documentation index

The root [`README`](../README.md) is the operator overview. This index is the complete topic map:

| Topic | Documentation |
| --- | --- |
| Architecture and authority | [Architecture](architecture.md) |
| Prerequisites, first installation, immutable bootstrap | [Installation](installation.md) |
| GitHub App creation, permissions, installation, credential | [GitHub App setup](github-app.md) |
| Project YAML and worker-result JSON | [Profiles and protocol fixtures](profiles.md), [configuration examples](../config/README.md) |
| GitHub observations, mutations, retries, tokens | [GitHub integration](github.md) |
| Lifecycle labels and hash-bound migration | [Label migration](label-migration.md) |
| SQLite schema, lease, audit, backup/recovery | [Ledger](ledger.md) |
| Claude/Codex runners and provider circuits | [Providers](providers.md) |
| Current-head review/check rules | [Convergence](convergence.md) |
| Opt-in converged-PR conflict repair | [Conflict repair](conflict-repair.md) |
| Herdr panes, attachment, process custody | [Herdr](herdr.md) |
| Recovery comments, incidents, takeover | [Recovery](recovery.md) |
| XDG, systemd, polling, rollout, shutdown, disk, retention, ntfy, logs, doctor | [Operations](operations.md), [systemd unit](../systemd/README.md) |
| Complete command grammar | [CLI reference](cli.md) |
| Initial release, queued update, migration, switch, rollback | [Immutable releases](updates.md) |
| Threat boundaries, credentials, redaction, safe deployment state | [Security](security.md) |
| Development, complete validation, verification map | [Testing](testing.md) |
| Failure diagnosis and operator remedies | [Troubleshooting](troubleshooting.md) |
| Implemented and future post-v1 work | [Post-v1](post-v1.md) |

The shipped state is deliberately inert: example profiles are disabled, a new ledger starts in
observation mode at rollout `observation`, and no GitHub App, credential, live label migration,
worker enablement, rollout promotion, or pull-request merge is performed by installation.
