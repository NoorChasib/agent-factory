# GitHub App setup

GitHub App creation, permissions, repository installation, and private-key provisioning are
operator actions. Agent Factory only consumes an existing App ID and a private-key file made
available by systemd.

## Create the App

In the GitHub organization or account that owns the enabled target repositories, create a
GitHub App with:

- webhook delivery disabled; the factory polls;
- repository permissions:
  - **Administration: Read-only** (default-branch protection observation)
  - **Checks: Read-only**
  - **Metadata: Read-only**
  - **Issues: Read and write**
  - **Pull requests: Read-only**
  - **Commit statuses: Read-only**
- no organization or account permissions unless local policy independently requires them.

Generate a private key and record the numeric App ID. Do not place the PEM in this repository, a
profile, an environment file, a worker environment, a log, or a notification.

The broker requests exactly those reduced permissions rather than inheriting broader App
permissions. Administration, checks, metadata, pull requests, and commit statuses remain
read-only; only issues are writable. The mutation surface is limited to guarded issue/PR label
and recovery-comment operations; there is no merge or branch-protection API.

## Install only on enabled targets

Install the App with **Only select repositories**, selecting only repositories whose validated
profiles will be explicitly enabled. Do not grant an organization-wide installation for future
or disabled profiles. Adding or removing a target is a separate operator action and should be
paired with a profile/config review.

At startup the broker resolves a repository installation only for enabled profiles. Tokens are
short-lived, cached by installation and repository target, and never shared across projects.

## Store the private key

The checked-in unit loads this operator-owned source:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/credentials/github-app.pem
```

Prepare it with owner-only permissions:

```sh
install -d -m 0700 \
  "${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/credentials"
install -m 0600 /operator/source/github-app-private-key.pem \
  "${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/credentials/github-app.pem"
```

Set only non-secret values in
`${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/environment`:

```text
AGENT_FACTORY_GITHUB_APP_ID=123456
AGENT_FACTORY_SOURCE_REPOSITORY=/absolute/path/to/agent-factory
```

`systemd` copies the PEM into its ephemeral credential directory with:

```ini
LoadCredential=github-app.pem:%h/.config/agent-factory/credentials/github-app.pem
Environment=AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE=%d/github-app.pem
```

To use another source path, add a user-unit override that first clears `LoadCredential=` and then
sets `LoadCredential=github-app.pem:/absolute/operator-owned/path/github-app.pem`. The
`AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE` value is a path, never PEM contents.

## Verify without mutation

Run routine local checks first:

```sh
agent-factory doctor
```

Routine doctor does not consume provider or GitHub calls. After credentials and installation are
intentionally in place, `agent-factory doctor --live` adds GitHub, Claude, and Codex probes. Live
doctor is diagnostic only; it does not install the App, change labels, launch target workflows,
or promote rollout.

See [GitHub integration](github.md) for token caching, observation, mutation idempotency, and
failure handling.
