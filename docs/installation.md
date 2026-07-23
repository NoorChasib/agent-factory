# Installation

Installation prepares local files only. It does not create or install a GitHub App, provision
credentials, migrate target labels, enable a profile, promote rollout, start a worker, or merge a
pull request.

## Quick install

Download and run the installer directly from the public repository:

```sh
curl -fsSL https://raw.githubusercontent.com/NoorChasib/agent-factory/main/install.sh | bash
```

A pinned ref can be substituted for `main` in the URL.

The script automates the manual installation steps below and deliberately stops short of
credential provisioning, service enablement, profile enablement, or rollout promotion. GitHub CLI
(`gh`) with authentication is required for operation/workers, not for installation.

The following environment variables customize a run:

- `AGENT_FACTORY_CHECKOUT` changes the checkout from
  `$HOME/.local/src/agent-factory`.
- `AGENT_FACTORY_REF` selects a fetched commit, tag, or branch instead of the remote default
  branch.
- `AGENT_FACTORY_SKIP_VALIDATE=1` skips the source-checkout `bun run validate` step. This is not
  recommended; immutable-release bootstrap still performs its documented validation.

For a prerequisite-only check that does not clone or install anything, set
`AGENT_FACTORY_INSTALL_CHECK_ONLY=1`.

## Prerequisites

- Linux with `systemd --user` and Unix-domain sockets
- Bun 1.3 or newer for source development, release building, and worker-wrapper execution
- Git and `systemctl` for installation
- GitHub CLI (`gh`) with authentication, Claude Code, Codex, and Herdr on the service `PATH` for
  operation/workers
- a local clone or bare repository containing each factory commit that may be installed
- an HTTPS ntfy endpoint and private topic
- before service enablement, an operator-created GitHub App installed only on enabled targets

The target application's runtime database, Docker, Redis, and a separate queue are not required.

## Validate the source checkout

From the factory repository:

```sh
bun install --frozen-lockfile
bun run validate
```

`bun run validate` is the complete repository validation command: strict TypeScript, Biome, and
the entire Bun test suite. Development and tests continue to execute TypeScript sources directly.

## Install configuration

The shipped multi-project example is deliberately disabled and contains no secrets:

```sh
install -d -m 0700 \
  "${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/profiles"
install -m 0600 config/examples/multi-project/config.yaml \
  "${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/config.yaml"
install -m 0600 config/examples/multi-project/profiles/*.yaml \
  "${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/profiles/"
```

Replace the example ntfy endpoint/topic and edit profiles for the intended repositories. Keep
every profile `enabled: false` through bootstrap. The real loader requires `config.yaml` and each
profile to be regular mode-`0600` files; directories are mode `0700`. See
[project profiles](profiles.md).

## Bootstrap the first immutable release

The bootstrap command accepts one commit already present in
`AGENT_FACTORY_SOURCE_REPOSITORY`. It creates the observation-mode schema, builds the exact
detached commit with frozen dependencies and complete validation, compiles its CLI and daemon into
standalone executables, installs a read-only artifact, atomically creates `releases/current`, and
records it as the installed release.

```sh
export AGENT_FACTORY_SOURCE_REPOSITORY=/absolute/path/to/agent-factory
bun run bootstrap -- "$(git rev-parse HEAD)"
```

Bootstrap is idempotent for the same installed commit and refuses to replace another installed
release or non-empty release ledger. Later commits use the queued update flow. Bootstrap does not
read GitHub App credentials or contact GitHub or a provider.

Make the CLI available without pointing it at a mutable source checkout:

```sh
install -d -m 0755 "$HOME/.local/bin"
ln -s "$HOME/.local/share/agent-factory/releases/current/bin/agent-factory" \
  "$HOME/.local/bin/agent-factory"
agent-factory version
agent-factory doctor
```

If the link already exists, inspect it before replacing it. `version` reads the installed
release's semantic version from `release.json`; update/release identity remains the factory
commit SHA. The linked CLI and the systemd daemon embed the Bun runtime used to construct that
release, so their startup does not depend on the host Bun version. Bun must remain installed for
future release builds and for the shipped TypeScript worker wrapper, whose guarded invocation is
still `bun <wrapper.ts> <spec>`.

## Provision credentials and the service

Follow [GitHub App setup](github-app.md), then install the checked-in user unit:

```sh
install -D -m 0644 systemd/agent-factory.service \
  "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/agent-factory.service"
systemctl --user daemon-reload
```

Run `agent-factory doctor` before enablement. Service enablement is an explicit operator action:

```sh
systemctl --user enable --now agent-factory.service
agent-factory status
```

The first service start is still disabled observation mode. Inspect observations, plan/preview
any [label migration](label-migration.md), and use adjacent attended rollout promotion only after
the operator accepts the target and operational checks. No promotion is automatic.

## Unattended-login operation

If the service must survive logout, the operator may enable user lingering according to local
host policy:

```sh
loginctl enable-linger "$USER"
```

That changes host account behavior and is not performed by this repository.
