# Security model

Agent Factory is designed for a single operator-controlled Linux account and explicitly enabled
GitHub repositories. It is not a multi-tenant remote control plane.

## Trust boundaries

- GitHub is authoritative for target workflow state. SQLite is execution, recovery, and audit
  state only.
- Profiles and all JSON/YAML/adapter/worker inputs are untrusted and strictly parsed.
- The daemon accepts a strict versioned JSON protocol only over an owner-only local Unix socket.
- Target workflows run in isolated project worktrees. The factory imports no target source or
  dependencies, and targets import no factory code.
- The controller has no merge, force-push, rebase, amend, review-dismissal, branch-protection
  bypass, credential-provisioning, or App-installation operation.

## Credentials

The GitHub App ID and private-key **path** are environment values. The PEM is supplied through
systemd `LoadCredential`, read by the token broker, and never passed to workers. Workers receive
only a short-lived, reduced-permission installation token in the allowlisted process
environment. Token cache entries are scoped by target/installation.

Worker tokens and workflow prompts cross Herdr custody only in a mode-`0600` specification
inside a mode-`0700` state directory. Herdr argv contains only wrapper and specification paths.
The wrapper unlinks the specification after validation and spawns the provider with exactly its
recorded allowlisted environment, never the inherited pane environment.

Worker tokens grant contents, issues, and pull-request write access because the contracted worker
flow must push an issue branch and create a non-draft PR. The factory's never-merge and
never-push-default guarantees do not depend on read-only token scopes: controller mutations and
factory-owned Git operations are constrained by guarded allowlists, while protected default
branches remain enforced by GitHub branch protection.

Profiles, runtime YAML, the environment file, logs, notifications, recovery comments, GitHub
issues, and the repository must never contain PEM data or live tokens. Private credential sources
and configuration files are owner-only.

## Mutation and process safety

Each GitHub mutation is target-scoped, idempotency-keyed, written to the mutation ledger, and
verified through observation. Ambiguous mutations reconcile before retry. Label migration
requires preview plus the exact plan hash. `ready-to-merge` is revocable when current-head review
or check convergence changes.

Herdr operations target only the named `agent-factory` session. Pane ID, root PID, process start
identity, project, branch, and worktree custody are rechecked before stop, kill, cleanup, or
recovery association. Unknown or mismatched state is retained and escalated, not guessed.

## Data protection and redaction

XDG directories are mode `0700`; configuration, ledger, and socket files are mode `0600`.
Structured logs rotate at configured bounds. The shared sanitizer covers logs, daemon error
responses, audit/recovery payloads, and ntfy bodies. It removes:

- GitHub and bearer tokens, PEM blocks, and secret-looking keys;
- configured environment sentinels;
- prompts and oversized/untrusted content; and
- absolute VPS paths.

Recovery comments intentionally expose only project alias, execution/session identity,
branch/head, checkpoint, sanitized incident data, and copyable `agent-factory` commands.

## Safe deployment state

The shipped examples are disabled. A new ledger starts with `mode: observation` and rollout stage
`observation`, whose lane caps are zero. Repository installation does not create a GitHub App,
provision credentials, apply live labels, enable workers, promote rollout, or merge a pull
request. Each is a separate operator decision; merges always remain under Noor's authority.

Only `doctor --live` may run provider-consuming diagnostic probes. Routine doctor, status,
startup checks, and observation reconciliation do not.
