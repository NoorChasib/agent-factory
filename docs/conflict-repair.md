# Just-in-time conflict repair

Conflict repair is an optional Agent Factory v1.1 feedback-lane activity. It exists only to
repair a pull request that has already converged on its current head and is blocked solely by a
GitHub merge conflict. It does not keep open pull requests continuously fresh.

## Exact trigger

Reconciliation marks an open pull request eligible only when all of these facts hold together:

- GitHub reports `mergeability: conflicting`;
- every configured required review completion belongs to the current head;
- every configured required check is successful on the current head;
- there is no unresolved current-head feedback, changes-requested decision, or draft state;
- the review/check observation matches the saved current-head baseline; and
- the configured consecutive quiescence-poll count has been reached.

Equivalently, the ordinary ready-to-merge assessment must have exactly one reason:
`mergeability`. `unknown` mergeability does not qualify. A mergeable pull request does not
qualify merely because its branch is behind the default branch. Eligibility is an observed
controller signal, not a lifecycle label.

The factory deliberately waits for this state. Repairing an unconverged PR would move its head,
invalidate current-head review evidence, and spend review/model capacity before that cost is
useful.

## Opt-in profile

The target must provide `workflow.conflictRepair`. Its absence disables conflict repair even
when a PR otherwise qualifies. The optional budget object can only lower the hard defaults:

```yaml
workflow:
  implement: project/implement
  feedback: project/converge
  operatorImplement: project/operator-implement
  operatorFeedback: project/operator-feedback
  conflictRepair: project/repair-conflict
conflictRepair:
  perHeadInvocations: 1        # allowed range 1–2; default 2
  perPullRequestInvocations: 3 # allowed range 1–4; default 4
```

The HHC AEP shipped example demonstrates the opt-in and lowered budgets. The Lumen Notes
example omits both fields and proves the disabled path.

## Lane, claim, and session ownership

A repair is a feedback-lane execution:

- it uses the existing global and per-project feedback ceilings;
- observation mode, attended rollout caps, Codex/GitHub/reviewer circuits, target enablement,
  fair rotation, and one-owner checks apply unchanged;
- repair claims are serialized, and the configured `in-progress` claim is observed and verified;
- only one active worker can own a PR; and
- the PR keeps one Codex outer thread.

If the PR already has a recorded feedback thread, repair resumes that exact thread with its
recorded model and reasoning effort while selecting the target's repair workflow entry point.
If repair is the first Codex activity for the PR, its new thread is captured before the outcome
is trusted. Later attended resume finds the PR-scoped recorded thread even when the repair has a
different execution ID.

## Worker contract and verification

The repair prompt is intentionally narrow. The target workflow must:

1. claim and verify the PR's configured `in-progress` stage;
2. forward-merge the configured target default branch into the current PR branch;
3. resolve only the conflicts caused by that merge;
4. make no unrelated changes;
5. push only the PR branch; and
6. emit one strict version-1 `WorkerResult`.

It must not rebase, force-push, amend, rewrite history, merge the PR, push to or change the
default branch, bypass branch protection, or ask an interactive question. The controller's Git
and GitHub adapters gain no mutation capable of those operations.

A `completed` result is not accepted from worker prose alone. The verifier must observe on
GitHub:

- the reported PR and branch;
- a head different from the repair's initial head;
- that exact reported new head; and
- mergeability at that head that does not report `conflicting`.

Missing observation, an unchanged head, or a still-conflicting head fails verification.

## Budgets and handoff

Repair accounting is independent of the feedback budget of three code-changing rounds and six
total invocations. The defaults are at most two repair invocations for one PR head and four over
the PR lifetime. A new head resets only the per-head count.

Invocation and deduplicated handoff records live in the validated SQLite controller-state JSON.
The existing schema already durably stores that state, so v1.1 needs no table or column
migration. Every launch is counted before activation, including an invocation that later fails.

Budget exhaustion or any repair failure stops automatic repair for that head and uses the
standard sanitized operator handoff. The PR worktree and Codex thread remain available through
the normal `worker show`, `attach`, `takeover`, `resume`, and `release` commands.

## After repair

The repair push creates a new PR head. All old current-head review, check, and quiescence evidence
is stale. The ordinary convergence engine starts again without a shortcut and may emit
`ready-to-merge` only after the configured policy succeeds on the new head. The factory still
does not merge the PR; the operator remains the only merge authority.
