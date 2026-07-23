# CLI reference

`agent-factory` is the installed operator CLI. With the exception of local `help`, `version`, and
non-live `doctor`, commands send one strict protocol-v1 JSON request over the owner-only Unix
socket below the XDG state directory. Requests and responses reject unknown keys. A missing
daemon produces a clear error and non-zero exit.

Output is pretty-printed JSON so it remains inspectable and scriptable without introducing a
second presentation protocol.

## Observation

```text
agent-factory status
agent-factory workers
agent-factory show <execution>
agent-factory logs [--lines <1..10000>]
agent-factory circuits
```

`status` includes controller mode, rollout stage and effective caps, projects, executions,
planner blocks, maintenance, circuits, and release state. `show` returns durable attempts,
provider sessions, and factory process/pane metadata. Recovery records also use the equivalent
`agent-factory worker show <execution>` alias. Logs have already passed the shared redaction
boundary.

## Maintenance and workers

```text
agent-factory pause
agent-factory resume
agent-factory drain
agent-factory worker attach <execution>
agent-factory worker takeover <execution>
agent-factory worker resume <execution>
agent-factory worker release <execution>
agent-factory worker stop <execution>
agent-factory worker kill <execution>
agent-factory shutdown --when-idle
```

Pause and drain durably switch the controller to observation mode. Resume is refused at rollout
stage `observation`, while a disk/shutdown guard is active, or until the operator resolves the
block. `release` is the explicit authorization that allows stalled/operator custody to become
retention-eligible. Stop is graceful; kill is an explicit hard stop and remains scoped to the
recorded factory Herdr pane.

## Projects and configuration

```text
agent-factory project list
agent-factory project validate [project]
agent-factory project enable <project>
agent-factory project disable <project>
agent-factory config list
agent-factory config validate
```

Enable/disable changes the durable local scheduling flag; it does not install a GitHub App,
change a profile file, or mutate a target. File changes require an operator edit followed by
validation and service restart.

## Rollout, labels, and updates

```text
agent-factory rollout status
agent-factory rollout promote
agent-factory rollout demote
agent-factory labels plan <project>
agent-factory labels preview <project>
agent-factory labels apply <project> --hash <64-lowercase-hex>
agent-factory update status
agent-factory update queue <factory-commit-sha>
```

Rollout transitions are adjacent and explicit. Label apply accepts only the exact hash of the
daemon's current preview and rechecks repository-label drift. `update queue` accepts only a
40- or 64-character lowercase hexadecimal factory commit. It builds and validates a missing
candidate, records it queued, and starts a durable drain. The poll loop applies it when idle;
`update status` reports the current pointer, running commit, and release states. See
[`updates.md`](updates.md).

## Diagnostics and reconciliation

```text
agent-factory doctor
agent-factory doctor --live
agent-factory reconcile
agent-factory notifications test
agent-factory notifications digest
agent-factory version
agent-factory help
```

Non-live doctor checks local files, permissions, ledger schema, socket, unit, binary version
strings, and disk without a daemon and without provider-consuming probes. `--live` is explicit
and is the only diagnostic path that probes Claude, Codex, and GitHub.

## Exit behavior

Successful requests return zero. Usage errors, invalid responses, daemon absence, rejected state
transitions, failed checks, and transport failures return non-zero. Secrets and absolute paths
are redacted from daemon errors before they cross the socket.
