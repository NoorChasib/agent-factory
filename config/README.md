# Runtime configuration

Production configuration lives in
`${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/config.yaml`. It and every referenced profile
must be regular mode-`0600` files. The containing directories are mode `0700`.

The complete checked-in example is
[`examples/multi-project/config.yaml`](examples/multi-project/config.yaml), with disabled
[HHC AEP](examples/multi-project/profiles/hhc-aep.yaml) and
[fictional Lumen Notes](examples/multi-project/profiles/lumen-notes.yaml) profiles:

```yaml
schemaVersion: 1
profiles:
  - profiles/hhc-aep.yaml
  - profiles/lumen-notes.yaml
ntfy:
  baseUrl: https://ntfy.example.invalid
  topic: replace-with-private-topic
logging:
  rotateBytes: 10485760
  retainedFiles: 5
```

The example endpoint/topic must be replaced before service operation. The YAML contract is
strict. Unknown/duplicate keys, aliases, insecure ntfy URLs, path traversal, absolute profile
paths, non-private modes, duplicate profile IDs/repositories, and invalid profiles fail startup
and doctor validation. See [`../docs/profiles.md`](../docs/profiles.md) for every field and safe
copy commands.

Versioned JSON worker-result examples, including malformed/untrusted rejection examples, are in
[`protocol/worker-result/v1/`](protocol/worker-result/v1/).

## Environment

These are all Agent Factory operator inputs. Configuration values, including the XDG base
directories, are read through `src/env.ts` (see `.env.example`); pass-through worker variables
such as `PATH`, `LANG`, `NO_COLOR`, and `TERM` are forwarded from the raw process environment:

| Variable | Required/default | Contract |
| --- | --- | --- |
| `AGENT_FACTORY_LIMIT` | Required | Non-negative integer applied to every lane; `0` pauses launches |
| `AGENT_FACTORY_CLAUDE_MODEL` | Required | One safe model argument; captured per session |
| `AGENT_FACTORY_CLAUDE_EFFORT` | Required | `low`, `medium`, `high`, or `max`; captured per session |
| `AGENT_FACTORY_GITHUB_APP_ID` | Required by daemon | Positive integer App ID; non-secret |
| `AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE` | Required by daemon | Absolute credential-file path; never PEM contents |
| `AGENT_FACTORY_SOURCE_REPOSITORY` | Running factory root | Absolute local checkout/bare repository containing installable commits |
| `XDG_CONFIG_HOME` | `$HOME/.config` | Absolute base for config, profiles, environment, credential source |
| `XDG_STATE_HOME` | `$HOME/.local/state` | Absolute base for ledger, socket, logs, backups, release builds |
| `XDG_DATA_HOME` | `$HOME/.local/share` | Absolute base for mirrors, worktrees, immutable releases |
| `HOME` | Process home | Required absolute fallback when any XDG base is unset; passed to workers |
| `PATH` | Service environment | Must expose Bun, Git, gh, Claude, Codex, Herdr, and systemctl; passed to workers |
| `LANG`, `LC_ALL` | Inherited when set | Worker locale only |
| `NO_COLOR` | Inherited when set | Worker output convention only |
| `TERM` | Inherited when set | Worker terminal type only |
| `TMPDIR` | Inherited when set | Worker temporary-directory hint only |
| `XDG_CACHE_HOME` | Inherited when set | Worker cache-directory hint only |

The worker also receives `XDG_CONFIG_HOME` from the table when set. The factory itself supplies
`GH_PROMPT_DISABLED=1`, `GIT_TERMINAL_PROMPT=0`, and both `GH_TOKEN`/`GITHUB_TOKEN` as the
project-scoped short-lived installation token. Those four are controller-generated, not
operator inputs. No other service environment keys reach workers.

Effective lane/backlog values are the minimum of the attended rollout cap, environment value,
and optional profile ceiling. A value of zero pauses that lane. There is no silent provider
model fallback or paid-credit enablement.

The source repository is operator-maintained; bootstrap/update never fetch it or provision Git
credentials. The checked-in systemd unit maps
`AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE=%d/github-app.pem` to an ephemeral `LoadCredential`
path. PEM contents must never be placed in the environment file, runtime YAML, profile, or worker
environment.
