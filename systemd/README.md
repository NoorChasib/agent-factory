# systemd user service

Install the checked-in unit without editing it:

```sh
install -D -m 0644 systemd/agent-factory.service \
  "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/agent-factory.service"
systemctl --user daemon-reload
systemctl --user enable --now agent-factory.service
```

The unit starts the daemon through the immutable-release `current` pointer at
`$HOME/.local/share/agent-factory/releases/current`. Phase 7 will implement creation and atomic
switching of that pointer; during source-tree development, place an equivalent release layout
there rather than changing `ExecStart`.

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

Use `agent-factory shutdown --when-idle` before a planned VPS reboot. A normal systemd stop is
not a substitute for the durable drain and recovery verification performed by that command.
