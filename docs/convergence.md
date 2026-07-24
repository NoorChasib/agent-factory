# Review and check convergence

The deterministic convergence engine uses the richer GitHub snapshot and review-baseline
repository without adding a second observation model. Current-head requirements, review/check
markers, late-feedback detection, and ready-to-merge revocation all reuse the GitHub
reconciliation functions.

## Inputs and authority

Each evaluation receives:

- one validated project profile;
- one authoritative GitHub project snapshot and PR number;
- the injected time when the current head was first observed;
- optional classified reviewer-provider failure evidence; and
- optional GitHub check failure classifications.

The injected clock supplies the evaluation time. The engine does not use wall-clock APIs,
randomness, processes, or network access.

GitHub remains authoritative for the current head, reviews, review decision, unresolved threads,
checks, draft state, mergeability, and lifecycle labels. The local baseline records only
quiescence progress and prior observed markers.

## Current-head completion and timeouts

Configured reviewer completion is accepted only when its PR review or completion check belongs
to the current head. A stale-head approval is missing, not approval. An owner-review label adds
the configured optional current-head review requirement; the factory never applies or requests
that label.

Reviewer waits use `profile.timeouts.reviewerMinutes`; the documented default profile value is
45 minutes per head. Expiry returns `review-stalled` with the missing reviewer IDs and preserves
the Codex session. Absence is never converted to approval.

Required checks come from either the validated profile or observed default-branch protection.
They must succeed on the current head. Check waits use
`profile.timeouts.requiredCheckMinutes`; the documented default is 90 minutes. Expiry returns
`check-stalled`, distinct from reviewer completion.

Current-head unresolved feedback or a changes-requested decision returns `feedback-required`
immediately. A classified reviewer-provider failure returns a reviewer circuit signal instead of
silently running the timeout to approval.

## Quiescence and ready emission

After current-head reviewers and checks succeed, the engine compares the current review/check
markers with the saved baseline:

1. A missing, stale-head, or changed baseline is replaced at poll count zero.
2. An unchanged observation increments only when at least 60 seconds elapsed since the prior
   saved poll.
3. Any marker change resets the count to zero.
4. The configured `quiescencePolls` must be reached; the documented default is two.

Thus the default requires a baseline plus two unchanged polls at least 60 seconds apart. Polls
that arrive early do not advance or rewrite the baseline.

Once quiescent, the engine calls the same ready assessment used for revocation.
`emit-ready-to-merge` can be applied only through `ReadyToMergeEmitter`, which delegates to the
existing guarded, reconcile-before-retry `CanonicalStageManager`. The decision is head-bound and
is refused if applied to a later head.

Mergeability is evaluated after review/check quiescence. A mergeable, non-draft PR proceeds to
ready assessment. `unknown` mergeability waits. A PR whose only remaining ready-assessment reason
is `mergeability` and whose authoritative value is `conflicting` is detected as a conflict-repair
candidate unconditionally. The planner launches that candidate only when the profile configures
`workflow.conflictRepair`. A mergeable branch that is merely behind never enters repair.

If a PR already carries ready-to-merge, the engine calls
`detectReadyToMergeRevocation`. Head, feedback, required-review, checks, draft, or mergeability
loss returns `revoke-ready-to-merge`; lifecycle reconciliation performs the guarded
revocation or feedback requeue. This keeps emission and revocation on one evidence model.

## Bounded feedback

`assessFeedbackInvocation` enforces both PR-wide v1 limits:

- no more than three code-changing rounds; and
- no more than six total feedback invocations.

The decision is made before the proposed invocation is counted. A fourth code-changing
invocation or seventh total invocation is refused as an operator handoff. Every decision
explicitly preserves the one recorded Codex outer session for attended recovery.

Workflow child audit/review roles are outside this accounting because they are not factory
executions or invocations.

Conflict-repair invocations use a separate two-per-head/four-per-PR default budget and never
increment either feedback counter. They still occupy feedback capacity and reuse the PR's
recorded Codex thread. See [Just-in-time conflict repair](conflict-repair.md).

## Safe check reruns

Rerun permission is classification-based, not inferred from a generic failure:

| Classification | Automatic rerun |
| --- | --- |
| GitHub infrastructure/startup failure | Yes |
| GitHub cancellation | Yes |
| GitHub timeout | Yes |
| Genuine code/test failure | No |
| Unknown or unclassified failure | No |

GitHub `CANCELLED`, `STARTUP_FAILURE`, and `TIMED_OUT` conclusions map to the three allowlisted
classes. `FAILURE`, `ERROR`, and `ACTION_REQUIRED` fail closed as genuine failures unless a
trusted GitHub adapter supplies a narrower classification. The engine emits a bounded
`rerun-check` orchestration decision and preserves the outer Codex state; it exposes no generic
check or workflow mutation.

No genuine failing check is automatically rerun, and convergence has no merge or
branch-protection mutation.
