# Runtime configuration

Production configuration lives in
`${XDG_CONFIG_HOME:-$HOME/.config}/agent-factory/config.yaml`. It and every referenced profile
must be regular mode-`0600` files. The containing directories are mode `0700`.

```yaml
schemaVersion: 1
profiles:
  - profiles/first-project.yaml
  - profiles/second-project.yaml
ntfy:
  baseUrl: https://ntfy.example.com
  topic: private-factory-topic
logging:
  rotateBytes: 10485760
  retainedFiles: 5
```

The document is strict. Unknown/duplicate keys, YAML aliases, insecure ntfy URLs, path traversal,
absolute profile paths, non-private modes, duplicate profile IDs/repositories, and invalid
profiles fail startup and doctor validation.

Project profiles are version-1 YAML documents validated by
`src/contracts/project-profile.ts`. They configure repository/default branch, target-owned
autonomous and attended workflow names, canonical stage/condition labels, reviewers and
completion signals, required checks, branch-protection expectations, timeouts, and optional lower
ceilings.

Non-secret service environment values:

```text
AGENT_FACTORY_IMPLEMENTATION_LIMIT=1
AGENT_FACTORY_FEEDBACK_LIMIT=1
AGENT_FACTORY_READY_TO_MERGE_LIMIT=1
AGENT_FACTORY_CLAUDE_MODEL=claude-fable-5
AGENT_FACTORY_CLAUDE_EFFORT=high
AGENT_FACTORY_GITHUB_APP_ID=<positive integer>
AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE=%d/github-app.pem
AGENT_FACTORY_SOURCE_REPOSITORY=<absolute factory checkout or bare repository path>
```

Lane/backlog values accept `0` through `3`. Effective limits are the minimum of rollout cap,
environment value, and profile ceiling. Claude effort accepts `low`, `medium`, `high`, or `max`.
Provider runtime is captured per session and preserved on resume.

The source-repository path is the operator-maintained local Git repository containing the factory
commits eligible for immutable release builds. The updater never fetches it implicitly. During
source development the running checkout is the default; an installed service should configure
the canonical checkout or bare repository prepared by the Phase 8 installation.

The private-key variable contains only the absolute systemd credential path. PEM contents must
never be placed in this file, an environment file, a profile, or a worker environment.
