# Operations guide

## XDG layout and permissions

Agent Factory resolves XDG variables at composition and injects absolute paths into every
component. Defaults are `$HOME/.config`, `$HOME/.local/state`, and `$HOME/.local/share`.

The config, state, data, profiles, log, mirror, worktree, and release directories must be mode
`0700`. `config.yaml`, profiles, the ledger, and the local socket are mode `0600`. Symlinks are
not accepted as configuration files. Profile paths are confined below `profiles/`, and socket
paths longer than 100 bytes are refused before bind.

## systemd user service

Install [`../systemd/agent-factory.service`](../systemd/agent-factory.service) as a user unit.
It starts:

```text
%h/.local/share/agent-factory/releases/current/bin/agent-factory-daemon
```

The unit uses `Restart=on-failure`, `UMask=0077`, and `WantedBy=default.target`. The release
updater creates and atomically switches `current`; do not hand-edit the unit to point into a
mutable checkout.

The unit loads the GitHub App PEM from the operator-owned mode-`0600`
`%h/.config/agent-factory/credentials/github-app.pem` source. A systemd override may reset
`LoadCredential=` and select another absolute source. The unit maps
`AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE` to `%d/github-app.pem`. The credential source remains
outside the repository and environment file.

## Polling and reconciliation

Startup performs reboot recovery before accepting normal polling. Each poll:

1. measures the relevant state and data filesystems;
2. applies the disk maintenance guard;
3. advances a queued release or resumes its post-restart health/rollback phase, and stops the
   tick before normal work if a service restart is pending;
4. reconciles GitHub through the controller;
5. advances current-head review/check quiescence and guarded ready-to-merge emission in active
   mode;
6. sends newly opened circuit alerts;
7. runs safe retention;
8. completes operator/update drains when idle; and
9. emits one redacted structured poll record.

The controller returns the next 60-second jittered delay from injected random input. Tests drive
individual ticks with scripted clocks, randomness, disk, and delay.

## ntfy

The strict config supplies an HTTPS base URL and topic. The injected transport posts plain UTF-8
body content with an ntfy title header. Alerts cover:

- provider circuit opened;
- 80/90-percent disk guard;
- drain completed;
- shutdown ready;
- stalled recovery handoff;
- update failure; and
- automatic update rollback.

`notifications digest` summarizes mode, rollout stage, active workers, project backlog,
maintenance, open circuits, and releases. Alert/digest fields are sanitized before the HTTP
adapter receives them.

## Disk guards

The guard evaluates the maximum usage across the state and data filesystems:

- below 80%: no new guard; stale disk guard records are cancelled, but resumption stays explicit;
- exactly 80% through below 90%: durable pause, launch block, and alert;
- exactly 90% or above: durable drain and alert.

The 90-percent drain remains active even when no workers are left, until usage drops below the
threshold. Repeated polls reuse active maintenance records and avoid repeated transition alerts.
Active work is never deleted to recover space.

## Retention

Cleanup is periodic and identity-checked:

- merged worktrees are eligible at exactly 24 hours;
- merged detailed execution logs are eligible at exactly 30 days;
- stalled and operator-required state is retained indefinitely;
- `worker release <execution>` is the only early/retained-state release authorization.

Worktree deletion rechecks project, issue path, and branch through phase-5 custody. Missing
artifacts are idempotent. Retention never deletes a live execution, unknown path, non-file log, or
unrelated Git checkout.

## Rollout and maintenance

`observation`, `stage1`, `stage2`, and `stage3` persist in the controller snapshot. Their caps are
`0/0/0`, `1/1/1`, `2/2/2`, and `3/3/3`; environment and profile values can only lower them.
Promotion and demotion are adjacent explicit commands. There is no success counter or automatic
promotion.

Pause, resume, drain, disk, and shutdown requests are append-only lifecycle records with
validated transitions. Observation remains the safe default. Resume never silently clears a
disk or shutdown block.

## Graceful shutdown

`agent-factory shutdown --when-idle`:

1. persists and activates `shutdown-when-idle`;
2. enters observation mode, stopping new launches;
3. waits while tracked active executions finish;
4. verifies every execution has durable terminal/recovery state;
5. signals only processes proven to belong to factory custody;
6. completes the request and sends the restart-ready alert; and
7. stops the daemon socket/poll loop.

If recovery verification fails, the service stays in maintenance and does not announce readiness.

## Reboot recovery and takeover

At startup the Herdr manager lists only the dedicated `agent-factory` session and matches each
pane name, pane ID, root PID, and process start identity against the ledger. It classifies work as
`still-running`, `exited-with-result`, or `orphaned`. Running work keeps capacity; exited/orphaned
work becomes durable recovery state. A stale pre-reboot shutdown request is cancelled, an audit
classification is appended, and controller reconcile runs with reason `recovery`.

Use `show`, `attach`, and `takeover` before deciding to resume, stop, kill, or release. Takeover is
recorded; attaching alone never changes custody.

## Structured logs

The state log is newline-delimited JSON with timestamp, severity, event, and structured data.
Rotation occurs before a write would exceed the configured byte ceiling; a bounded number of
numbered files is retained. Data is sanitized before the file sink. Redaction sentinels include
absolute paths, GitHub/bearer credentials, PEM blocks, secret-looking keys, prompts, configured
environment values, and oversized text.

## Doctor

Routine doctor is read-only and checks:

- strict configuration/profile validity;
- XDG directory/file modes;
- read-only ledger openability and current schema;
- socket reachability and unit presence;
- version output for Git, gh, Bun, Claude, Codex, and Herdr; and
- state/data filesystem usage.

Only `doctor --live` runs provider-consuming Claude/Codex probes and a GitHub API probe. No poll,
status command, startup check, or routine doctor performs those probes.

## Updates

The ledger and CLI expose `installed`, `queued`, `candidate`, `failed`, and `rolled-back` release
states. Phase 7 builds commit-addressed read-only artifacts from detached factory checkouts,
drains active work, backs up SQLite, applies validated additive migrations, atomically switches
`current`, restarts through the injected service seam, and runs health plus recovery
reconciliation. Failed health restores both the previous pointer and pre-migration ledger,
alerts, and restarts the prior release. See [`updates.md`](updates.md).
