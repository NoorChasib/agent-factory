# GitHub integration

The production GitHub layer supplies API observation, reconciliation, guarded mutation, and
credential components. Daemon composition wires these components to the controller.

## Observation and polling

The controller's existing polling contract remains 60 seconds with injected jitter. The
production adapter receives controller context on every observation:

- `status` is always read-only;
- observation mode never authorizes mutations;
- startup, relevant change, available capacity, degraded recovery, and operator requests force
  full reconciliation; and
- an unchanged ordinary poll may reuse a conditional response without running lifecycle
  mutations.

GraphQL reads send `If-None-Match` when an ETag is cached. A `304` is accepted only when a
previous response for the same target and page was strictly validated. A forced post-mutation
read bypasses the condition and replaces the cache so a later `304` cannot resurrect stale state.
Issue, pull-request, and branch-protection connections paginate independently and are bounded at
100 pages. Nested label, review, review-thread, closing-reference, and check connections compare
`totalCount` with the returned nodes and fail closed instead of planning from a truncated view.

Reads retry only a configured, bounded number of times. Backoff and waiting are injected. The
client classifies authentication, authorization, not-found, rate-limit, timeout, transport, 5xx,
invalid-response, and schema-validation failures. A `GitHubReadError` carries a
`GitHubCircuitFailureSignal`; controller/planner state remains responsible for opening or closing
the GitHub circuit.

All response bodies are untrusted input. The response contracts are strict Zod objects, and
malformed or newly unknown fields fail closed.

## Observation mapping

The adapter returns the canonical `GitHubProjectObservation` shape without adding target policy to
the controller:

- issue state and labels come from the issue connection;
- pull-request state, labels, branch, and head SHA come from the pull-request connection;
- issue-to-PR association uses GraphQL `closingIssuesReferences`;
- zero closing references maps to no association, while multiple references fail as ambiguous;
- the associated PR supplies the issue branch and PR number; and
- worktree IDs are an optional local association overlay. GitHub cannot authoritatively observe a
  local worktree, so the default is `null`.

The richer internal snapshot retains current-head reviews, checks, comments, unresolved review
threads, mergeability, review decision, and default-branch required-check names. Those details
are reduced to canonical stage changes before the deterministic planner sees the observation.

Disabled targets produce empty observations without resolving a credential or issuing HTTP.
Every cache key, token request, mutation, review baseline, and returned observation is scoped by
project ID.

## Mutation ledger flow

`GitHubMutationExecutor` depends on a narrow repository implemented structurally by
`SqliteLedger`: `recordMutation`, `transitionMutation`, and `listMutations`. The controller calls
the adapter/executor and remains the only ledger owner and writer.

The guarded flow is:

1. Record an idempotent intent as `pending`.
2. Send exactly one allowlisted GitHub write.
3. Record a known accepted response as `applied`.
4. Perform a fresh authoritative read.
5. Record the observed outcome as terminal `reconciled`.

A timeout, transport loss, 5xx, or failed verification changes the attempt to `ambiguous`. No
write retry occurs in that invocation. On a later explicit invocation, `pending`, `applied`, and
`ambiguous` attempts are read and reconciled first. If the outcome is already present, the
executor stops. If it is absent, the old attempt becomes `reconciled` and only then is a new
idempotency-keyed attempt recorded and sent. Startup/recovery reconciliation can reconcile all
outstanding attempts for one project without retrying them.

Known 4xx rejection is terminal and is never treated as an ambiguous success. Each verified
mutation finishes before the next stage or migration mutation begins.

## Claims and canonical stages

`CanonicalStageManager` resolves configured labels through the canonical profile mapping.
A claim is sequential and guarded:

1. Freshly read the issue and require the configured implementation-ready stage.
2. Add the configured `in-progress` label.
3. Freshly verify that `in-progress` stuck.
4. Refuse the transition if an unrelated external stage appeared.
5. Remove the prior stage and verify that removal.
6. Freshly resolve the final labels and report the claim verified only when the sole canonical
   stage is `in-progress`.

If another actor removes the label or changes the stage, the claim is lost rather than assumed.
Other repository labels and condition labels are retained.

All stage changes use the same guarded mutation executor. There is no generic target write
method.

## Late feedback and ready-to-merge revocation

`captureFeedbackBaseline` records a typed snapshot in the review-baseline repository when
a feedback worker exits. Later reconciliation compares current GitHub state with that baseline.
When no feedback worker owns the PR, later comments, reviews, head changes, or changed repairable
checks re-add the configured feedback-ready stage.

`ready-to-merge` is evidence, not a terminal promise. It is revoked when any of these cease to
hold:

- the baseline and current head are identical;
- comments/reviews/unresolved feedback remain unchanged and resolved;
- configured required reviews or review completion checks are current-head and complete;
- configured or branch-protection required checks succeed on the current head;
- the PR is non-draft and mergeable; and
- no repairable current-head check failure is present.

Actionable feedback or a repairable failure transitions directly to feedback-ready when no
worker owns the PR. A mergeability-only loss removes ready-to-merge without inventing feedback.
External labels are freshly checked again by the stage manager before every transition.

## GitHub App token broker

The broker accepts exactly this environment contract:

```text
AGENT_FACTORY_GITHUB_APP_ID=<positive integer>
AGENT_FACTORY_GITHUB_APP_PRIVATE_KEY_FILE=<absolute credential-file path>
```

The environment contains a path, never PEM text. The broker reads a regular credential file,
signs a short App JWT using Bun's `node:crypto` RS256 implementation, and resolves
`/repos/{owner}/{repository}/installation` only for a profile explicitly enabled when the broker
is created. It then requests a repository-restricted installation token with exactly:

```json
{
  "administration": "read",
  "checks": "read",
  "contents": "read",
  "issues": "write",
  "metadata": "read",
  "pull_requests": "read",
  "statuses": "read"
}
```

The returned permission set must match exactly. Tokens are cached per project until an injected
expiry-skew boundary. Installation IDs are also cached per project. PEM contents are passed only
to the local signing primitive, are never sent through the transport, are never included as an
error cause, and are never made available as worker environment.

Factory-owned mirror clone and fetch operations obtain a token from this same project-scoped
provider for each remote operation. The guarded Git adapter converts
`x-access-token:<token>` to a Basic authorization header carried only through
`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, and `GIT_CONFIG_VALUE_0`. Git argv retains the clean
`https://github.com/{owner}/{repository}.git` URL, so the token is absent from process argv and
the persisted `origin` URL. Mirror inspection and every local worktree/branch operation receive
an empty environment rather than GitHub credentials. Command adapters do not log environment
maps.

## HTTP and security boundary

All HTTP crosses `GitHubHttpTransport`. `FetchGitHubTransport` is the production implementation;
tests use `ScriptedGitHubTransport` and JSON fixtures, so tests perform no real network I/O.

Repository writes are structurally limited to:

- add one label to an issue or PR;
- remove one label from an issue or PR;
- create one repository label; and
- update one repository label's color/description without renaming it;
- create one sanitized issue/PR recovery comment; and
- update that recovery comment by comment ID.

Merge, push, force-push, rebase, amend, review dismissal, branch-protection bypass, and any
unknown mutation kind fail the allowlist before a transport-capable write path is reached. The
token broker's installation-token POST is an authentication operation and cannot target a
repository content endpoint. Recovery comment bodies pass through the shared redaction boundary
before mutation intent is recorded and again at the guarded HTTP call site.
