# systemd user service

Bootstrap the first immutable release as documented in
[`../docs/installation.md`](../docs/installation.md), then install the checked-in unit without
editing it:

```sh
install -D -m 0644 systemd/agent-factory.service \
  "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/agent-factory.service"
systemctl --user daemon-reload
systemctl --user enable --now agent-factory.service
```

The unit starts the daemon through the immutable-release `current` pointer at
`$HOME/.local/share/agent-factory/releases/current`. Initial bootstrap creates that pointer; the
updater creates a new relative symlink and atomically renames it over the pointer. Do not change
`ExecStart` to a mutable source checkout, and do not enable the unit before
`current/bin/agent-factory-daemon` exists.

After bootstrap, queue an update with a factory commit SHA:

```sh
agent-factory update queue <factory-commit-sha>
agent-factory update status
```

The daemon drains, validates, backs up, migrates, switches, and asks systemd for a non-blocking
restart. The new daemon completes health/reconciliation or automatically restores the prior
pointer and ledger. See [`../docs/updates.md`](../docs/updates.md).

The GitHub App PEM is a systemd credential, never an environment value. By default the unit reads
the operator-provisioned mode-`0600` source at
`%h/.config/agent-factory/credentials/github-app.pem`. To use a different absolute source, add an
override that resets the list:

```ini
[Service]
LoadCredential=
LoadCredential=github-app.pem:/absolute/operator-owned/path/github-app.pem
```

The unit sets `AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE` to `%d/github-app.pem`, systemd's
ephemeral credential path. Configure the non-secret App ID and lane limits in
`%h/.config/agent-factory/environment`; never put the PEM contents there.
The installed service also needs `AGENT_FACTORY_SOURCE_REPOSITORY` pointing to the
operator-maintained local factory checkout or bare repository from which commit-addressed
releases are built. The updater does not fetch source or provision repository credentials.

Service enablement does not enable a profile or promote rollout. The installed release starts in
observation mode at rollout `observation`, and the shipped examples are disabled. GitHub App
creation/installation, credential provisioning, live label migration, profile enablement, and
rollout promotion are explicit operator actions. See
[`../docs/github-app.md`](../docs/github-app.md).

Use `agent-factory shutdown --when-idle` before a planned VPS reboot. A normal systemd stop is
not a substitute for the durable drain and recovery verification performed by that command.
