# Recovery records, redaction, and retained work

Phase 5 makes a non-successful worker outcome recoverable without keeping its scheduler slot
occupied. Work, provider session, pane, process identity, branch, and issue worktree remain
durable; the execution changes from `active` to `completed` only after a sanitized incident and
recovery-comment mutation have been recorded. This is not an explicit worktree release.

## Stable reason codes

Worker terminal status maps to a target-independent reason code:

| Worker status | Recovery reason | Canonical condition when applicable |
| --- | --- | --- |
| `completed` | no recovery record | none |
| `blocked` | `blocked-external` | `blocked-external` |
| `operator_required` | `operator-required` | none |
| `provider_limit` | `provider-limit` | none |
| `stalled` | `worker-stalled` | `worker-stalled` |
| `failed` | `execution-failed` | none |

`provider-unavailable` is also available for controller-observed provider loss. The enum is
machine-readable and does not incorporate provider prose, target terminology, or arbitrary
checkpoint content.

## Canonical editable comment

The pure renderer accepts a strict record containing only:

- sanitized project alias;
- execution ID and issue/PR identity;
- branch and commit;
- pane and provider session ID;
- checkpoint;
- reason code; and
- commands derived solely from the validated execution ID.

It emits fields in that stable order and begins with an execution-specific hidden marker. The
copyable command contract is:

```sh
agent-factory worker show <execution-id>
agent-factory worker attach <execution-id>
agent-factory worker takeover <execution-id>
agent-factory worker resume <execution-id>
agent-factory worker release <execution-id>
```

Phase 6 implements those CLI entries. Paths are never needed because commands resolve custody
from the ledger.

Recovery publication uses the existing reconcile-before-retry mutation executor. The only new
GitHub mutation kinds are:

- `create-comment` for an issue or PR; and
- `update-comment` for an existing comment ID, with issue/PR context retained in the mutation
  ledger.

The update form keeps one editable canonical comment rather than accumulating mutable copies.
The body fingerprint is part of the operation key, so a changed checkpoint or reason is a new
guarded intent. Merge, push, force-push, rebase, amend, review dismissal, and branch-protection
bypass remain rejected by the strict allowlist.

## Append-only stall incidents

`StallIncidentRecorder` renders the same permitted field set without the editable-comment marker
and appends it as `stall-incident` to Phase 2 `audit_events`. SQLite sequence ordering and the
existing no-update/no-delete triggers make the incident history append-only. Updating the
canonical comment never edits an earlier incident.

## One redaction boundary

`StructuredRedactionBoundary` is the shared boundary for structured logs, audit payloads,
notification wrappers, and comment/incident bodies. The Phase 2 audit implementation imports
this boundary; it no longer has a separate path-only sanitizer. Callers may inject known
environment values without reading ambient process state.

The boundary:

- replaces secret-like keyed fields such as token, credential, password, prompt, PEM, or private
  key;
- replaces `ghs_`, `ghp_`, other GitHub token prefixes, `github_pat_`, and bearer credentials;
- replaces PEM private-key/certificate blocks;
- replaces configured environment-value echoes;
- replaces embedded absolute POSIX paths while leaving URLs and relative branch tokens intact;
  and
- replaces over-limit string fields with `[REDACTED_LONG_TEXT]`.

Recovery renderers additionally flatten control characters, prevent Markdown backtick injection,
and scan the completed body for secret/path sentinels before returning it. Tests seed
`/home/...`, fake GitHub tokens, bearer values, PEM blocks, environment echoes, and long
prompt-like text, then assert none survives in comments, incidents, notifications, mutation
intents, or audit payloads.

## Mirrors, issue worktrees, and retention

Mirror and worktree base directories are injected. Construction fails if either overlaps the
factory checkout, an operator checkout, or the other custody base. Paths are derived only from a
validated project alias and issue number:

```text
<mirror-base>/<project-alias>.git
<worktree-base>/<project-alias>/issue-<number>
```

The Git adapter has no generic argv method. Its strict operation union permits mirror inspection,
mirror clone/fetch, worktree list, worktree add with branch creation/checkout, and safe worktree
remove. Push, commit, merge, force-push, rebase, amend, and reset are rejected. Removal derives
the exact issue path, verifies its recorded branch, and uses no force option.

Creating custody clones a missing target mirror or fetches an existing one, then refuses a second
path for the same branch or a different branch at the same issue path. This enforces one issue ↔
one worktree behind the controller's existing invariant.

Cleanup eligibility is pure and uses an injected time:

- a normally merged worktree is ineligible until exactly 24 hours after merge;
- stalled or operator-required recovery remains ineligible regardless of merge age; and
- an explicit operator release makes the retained worktree eligible immediately.

Phase 6 owns retention scheduling and real base-directory composition. Phase 5 only computes
eligibility and exposes the exact safe removal operation.
