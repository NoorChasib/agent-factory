# Troubleshooting

## Daemon or socket unavailable

Run `agent-factory doctor`, then:

```sh
systemctl --user status agent-factory.service
journalctl --user -u agent-factory.service
```

Confirm `releases/current/bin/agent-factory-daemon` exists and the CLI/service use the same
`XDG_STATE_HOME`. If the socket path exceeds 100 bytes, choose a shorter absolute
`XDG_STATE_HOME` consistently for both.

## Configuration rejected

Confirm `config.yaml` and every referenced profile are regular files with mode `0600`, and all
Agent Factory XDG directories are mode `0700`. Unknown/duplicate YAML keys, aliases, absolute or
traversing profile paths, duplicate project IDs/repositories, and invalid ntfy values are
rejected. Re-copy a shipped example with `install -m 0600` if permissions are uncertain.

## GitHub App authentication fails

Check that the numeric `AGENT_FACTORY_GITHUB_APP_ID` is present in the service environment, that
systemd loaded `github-app.pem`, and that
`AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE=%d/github-app.pem`. Install the App only on each
enabled target and grant the documented repository permissions. Do not paste the PEM into the
environment file. Use `doctor --live` only when a consuming GitHub probe is intentional.

## No work launches

Inspect:

```sh
agent-factory status
agent-factory circuits
agent-factory config list
agent-factory update status
```

Observation mode, rollout `observation`, disabled profiles, zero limits, an active
pause/drain/shutdown/update request, open circuit, disk guard, or exhausted per-project ceiling
can all correctly block launches. Recovery below a disk threshold does not automatically resume
work; an operator must resolve the guard and resume.

## Worker missing after restart

Use `agent-factory show <execution>` and `agent-factory worker attach <execution>`. Startup
reconciles the recorded Herdr pane/process identity and classifies it as still running, exited
with result, or orphaned. Use takeover/resume/stop/kill/release only after inspecting the
identity; retained recovery state is not automatically deleted.

## Review never converges

Check that required reviewer identities and completion signals match the profile, required checks
belong to the current head SHA, conversations are resolved where configured, and the quiescence
counter has reached the configured consecutive poll count. Late feedback revokes
`ready-to-merge`; it is expected to re-enter feedback.

## Label migration will not apply

Generate a new plan/preview and apply its exact SHA-256. A changed repository observation or
profile produces a different hash and the old approval is rejected. Installation and rollout
promotion never apply label migration implicitly.

## Notification fails

Verify the runtime config uses an HTTPS ntfy base URL and safe private topic, then run:

```sh
agent-factory notifications test
agent-factory notifications digest
```

Failures do not bypass shared redaction or expose credential data.

## Update waits or rolls back

An update waits for all active work because pointer/schema changes occur only after drain. Inspect
active executions and `update status`. On rollback, retain the alert, backup, and quarantined
candidate database for audit; verify the source commit and complete validation before queueing a
different commit. An initial installation uses `bun run bootstrap -- <commit>`; self-update
requires an installed release.

## Planned reboot

Use `agent-factory shutdown --when-idle`, wait for the restart-ready result/notification, and only
then reboot. A plain service stop does not provide the durable drain and recovery verification.
