---
name: agent-factory-address-pr-feedback
description: Autonomously audit and address GitHub pull-request feedback through delegated read-only audit, scoped fixes, independent Standards and Spec reviews, behavior-preserving simplification, orchestrator acceptance, feedback commits when tracked files change, push, replies, and resolution of in-scope inline threads. Evaluate feedback from every automated or human reviewer by evidence. Use when asked to inspect, fix, respond to, resolve, continue, or finish review feedback on an Agent Factory pull request.
---

# Agent Factory Address PR Feedback

## Operating contract

- This skill's commits, pushes, replies, and thread resolutions are the repository mutations
  AGENTS.md requires explicit authority for; an operator invocation that asks to fix, respond
  to, resolve, continue, or finish feedback grants exactly that authority and no more. When the
  operator asks only to inspect, audit, or summarize feedback, stop after the read-only audit
  and report dispositions without committing, pushing, replying, or resolving.
- Work on exactly one pull request at a time. Treat its originating issue, PR body, agreed scope,
  repository guidance (`AGENTS.md` and GitHub issues NoorChasib/agent-factory#1 and #2 as
  implementation authority), and canonical design documents under `docs/` as the behavior contract.
- Evaluate feedback from every reviewer by evidence. Never implement a suggestion merely because
  of its author, wording, or assigned severity.
- Start the read-only audit immediately. After recording a bounded execution plan, continue without
  a startup approval gate through delegated fixes, independent reviews, simplification,
  verification, feedback commits when needed, push, replies, and resolution of audited inline
  threads. Before handoff, absorb feedback that arrives during the run through the bounded
  convergence loop in section 7.
- Never merge, force-push, rebase, or amend any commit. This repository's rules prohibit history
  rewriting entirely; every correction is a new ordinary commit pushed without force. Do not
  materially expand scope or act on feedback without first auditing it in the initial audit or a
  convergence round.
- Reuse the PR's existing head branch and ticket worktree when they are aligned and safely owned.
  Never create another remote branch or PR for review feedback. If the existing worktree is dirty
  or diverged with unrelated work, use an isolated local branch and worktree anchored at the
  audited remote head when that is safe; never overwrite or move existing work.
- Create exactly one additional commit per accepted feedback round when planned work changes
  tracked files. Create no empty commit when every disposition is explanation-only, duplicate,
  already addressed, or invalid. Prefer a single commit for the whole run; a later convergence
  round that changes tracked files after a push adds one further commit rather than rewriting the
  pushed one.
- Keep every change traceable to audited feedback and prefer the smallest implementation that
  preserves correctness, required behavior, and project boundaries.
- Reply with the disposition and evidence before resolving an in-scope inline review thread.
  GitHub conversation comments and review summaries have no resolvable state; acknowledge their
  actionable feedback in one concise PR summary.
- Do not resolve deferred, ambiguous, unaudited, or unsuccessfully verified feedback.
- Load and follow the internal sibling `../agent-factory-fallow/SKILL.md`. Treat the Fallow Action
  as a required check and automated reviewer throughout the same bounded convergence loop; this
  skill owns the GitHub feedback lifecycle and the internal skill owns Fallow judgment and repair.

## Delegation and acceptance boundary

Use fresh subagents for distinct roles. Give each role the minimum complete context it needs and
do not prime independent reviewers with another reviewer's conclusions.

- Delegate the complete feedback audit to a read-only audit subagent.
- Delegate planned file changes to a scoped fix subagent. Use a repair subagent for accepted review
  findings; a fresh fix/repair subagent is preferred when context permits.
- Delegate Standards review and Spec review to two fresh, independent, read-only reviewer
  subagents against the same stable tree. They may run concurrently while no writer is active.
- Delegate a behavior-preserving simplification pass to a fresh subagent. The pass may return a
  verified no-op, but it must inspect the complete planned diff.
- Keep local writers sequential unless separate worktrees and disjoint ownership make concurrency
  provably safe. Never allow concurrent writes in the PR execution worktree.
- Do not let subagents commit, push, reply, resolve, merge, or otherwise mutate GitHub. The
  orchestrator owns those side effects and each audited feedback snapshot.
- Treat every subagent result as evidence, not acceptance. The orchestrator independently inspects
  the final diff and repository state and runs the required acceptance checks before any commit,
  push, reply, or resolution. Return rejected work to a scoped repair subagent.

## Clarify early

Do not ask for routine approval. Resolve uncertainty from repository and GitHub evidence and
prefer the smallest safe in-scope action. Ask the user only when a material ambiguity about PR
identity, branch or worktree ownership, originating scope, conflicting requirements, unrelated
local changes, or destructive history changes cannot be resolved safely. Explain the concrete
decision and its effect. If ambiguity affects only one feedback item, defer that item and continue
the rest when safe, then report it afterward.

## 1. Establish the pull-request snapshot

1. Resolve the PR from the supplied URL, repository and number, or current branch. Confirm CLI
   authentication with `gh auth status`, then fetch its metadata, body, base and head repositories,
   base and head branches, head commit, commits, files, reviews, conversation comments, linked
   issue, and checks. Include the current `Fallow / changed-code audit` check conclusion and any
   failure log or artifact; a failed Fallow check is actionable even when it posted no comment.
   Record a verified Git push target whose push URL resolves to the exact head repository; never
   infer that `origin` owns the PR branch. Stop if the head repository is missing, permissions are
   insufficient, or the push target is ambiguous.
2. Run the bundled fetcher to obtain complete thread-aware feedback:

   ```bash
   python3 scripts/fetch-pr-feedback.py --repo OWNER/REPO --pr NUMBER
   ```

   Run it from this skill directory or use its absolute path. Preserve the output as the raw audit
   snapshot. Record the original pre-workflow audited PR head and a complete fingerprint set for
   every external feedback item in that snapshot, including resolved, outdated, and purely
   informational inventory entries. A fingerprint is the stable GitHub identity plus current
   content and edit metadata and, for an inline thread, its current `isResolved` and `isOutdated`
   state. Record the PR metadata and `headRefOid` with the same fetch. This is the initial
   comparison baseline; do not substitute a flat comment query when resolution, outdated state,
   root-comment identity, or inline context matters.
   Identify Fallow feedback by its fingerprint markers and check name rather than assuming a fixed
   bot account.
3. Inspect `git worktree list --porcelain` and every candidate worktree without changing branches.
   Record the worktree whose branch matches the PR head, compare its `HEAD` with the remote PR
   head, and inventory uncommitted and untracked files. Classify it as aligned and safe, PR-owned
   work in progress, unrelated work, or ambiguous; never assume local work belongs to this
   workflow.
4. Read `AGENTS.md`, the originating issue and its comments, task-specific repository guidance
   required by the files under review, and sources directly relevant to the feedback or an
   authority conflict. Do not chase incidental references. Resolve conflicts using the
   repository's stated authority order: issues #1 and #2, then `AGENTS.md`, then `docs/`.
5. Derive exact verification commands and prerequisites from relevant manifests, READMEs,
   repository scripts, CI configuration, and existing PR evidence. The canonical local gate is
   `bun install --frozen-lockfile`, `bun run validate`, and `git diff --check`. Tests must remain
   deterministic; never start shared or production infrastructure.

## 2. Delegate the read-only feedback audit

Give one fresh audit subagent the PR identity, audited head commit, raw fetcher output, candidate
worktree paths and status, originating issue and PR contract, relevant repository guidance, and
directly relevant sources. Require read-only repository and GitHub access; prohibit edits, commits,
pushes, replies, resolutions, and other mutations.

Require the audit subagent to:

1. Inspect every unresolved, non-outdated inline thread. Audit and classify every review body or
   PR conversation comment that contains a suggestion or requested change, explicitly including
   low-confidence items; purely informational top-level entries may remain inventory-only.
   Inventory resolved and outdated feedback without reopening it unless the user explicitly
   requested that scope. Record reply eligibility separately from thread-resolution eligibility:
   every audited inline item containing a suggestion or requested change is reply-eligible,
   regardless of thread state; a thread is resolution-eligible when it is unresolved and
   non-outdated when that item enters the audited plan. It stays resolution-eligible for this run
   if the run's accepted fix later makes it outdated.
2. Inspect the relevant final code, history, tests, and design authority for each item.
3. Classify every item as exactly one of:
   - `valid — code change`;
   - `valid — explanation only`;
   - `partially valid`;
   - `already addressed`;
   - `duplicate`;
   - `not an issue`;
   - `ambiguous, conflicting, or scope-expanding`.
4. Give concrete evidence for every disposition. Treat reviewer identity, severity, and a plausible
   failure story as hypotheses rather than proof. For partially valid feedback, isolate the real
   defect from unnecessary proposed machinery.
5. Propose the smallest scoped change or response, corresponding verification, affected files,
   and any unresolved ambiguity. Group duplicates while retaining a disposition for every
   individual feedback item.

Independently inspect enough of the cited evidence to accept, revise, or reject each audit
disposition. Do not treat the audit report as authoritative merely because it is complete.

## Record the initial execution plan and continue

Record one concise execution plan containing:

- PR number, title, URL, base, head repository, head branch, original pre-workflow audited PR head,
  current audited head commit, and verified head push target;
- execution worktree, ownership evidence, unrelated or overlapping local changes, and whether to
  use the existing worktree or an isolated local-only fallback anchored at the audited head;
- a numbered table of every actionable feedback item with author, location, summary,
  classification, evidence, proposed change or response, and verification;
- resolved, outdated, and non-actionable counts, with grouped duplicates still mapped to every
  individual thread;
- exact scope, files likely to change, risks, ambiguities, and proposed commit message;
- exact local and GitHub verification commands, their documented source, and required environment
  variable names without values;
- inline threads to reply to and resolve, plus the acknowledgement for actionable top-level
  feedback;
- required subagent roles and the stable-tree evidence each reviewer will receive, including the
  complete cumulative change from the original pre-workflow audited PR head.

Initialize one shared budget of at most three external-feedback waves after the initial complete
snapshot. Every later complete fetch uses this budget, including the post-plan revalidation in
section 3; there is no separate or recursive pre-edit allowance. Record the expected PR head at
each fetch. Run-owned pushes update that expectation; unexpected external head movement invokes
the stop rule in section 7.

Do not pause to present this plan or ask for routine approval. Treat it as the initial auditable
plan for autonomous execution; extend it with the same fields for each accepted late-feedback
delta.

## 3. Revalidate and delegate scoped fixes

1. Perform one complete convergence fetch under section 7 immediately after recording the plan.
   If it finds an external feedback delta, consume one wave, audit that delta once, and extend the
   plan before editing; do not recursively restart pre-edit revalidation. If it finds unexpected
   external head movement, follow section 7's stale-head stop rule. Unchanged historical items do
   not consume a wave. New or edited feedback alone is not a blocker.
2. Reconfirm the worktree strategy:
   - Re-resolve the head repository and verified push target. Stop if they no longer match or
     cannot be updated safely.
   - Use the existing PR worktree only when its branch, head, and local changes still match the
     recorded ownership assessment.
   - For an isolated fallback, fetch without moving a local branch using
     `git fetch --no-tags HEAD_PUSH_TARGET refs/heads/PR_HEAD_BRANCH`. Require
     `git rev-parse FETCH_HEAD` to equal the exact audited `HEAD_SHA`, verify that commit locally,
     then verify the absolute path and local branch are unused before running
     `git worktree add -b pr-NUMBER-feedback-SHORT_SHA ABSOLUTE_PATH HEAD_SHA`.
   - Keep the fallback branch local-only. Do not configure or publish it as a new remote branch.
   - Stop if another process changed either worktree, the PR branch, or ownership facts. Never
     stage, overwrite, move, reformat, print, or copy unrelated work or ignored secrets.
3. If the plan requires file changes, delegate exactly that bounded work to a fix subagent in the
   execution worktree. Give it the accepted dispositions, allowed files and scope, behavioral
   contract, relevant guidance, and focused checks. Require it to preserve public contracts,
   types, Zod validation at entry points, domain meaning, ledger invariants, and the controller's
   three-operation interface, and to add or update tests for observable behavior and failure paths
   when behavior changes.
4. Inspect the resulting diff and focused-check evidence. If implementation disproves feedback,
   stop that change, restore only changes owned by this workflow, and update the disposition with
   stronger evidence. Defer revisions that would materially expand originating scope. Never absorb
   unrelated local work into the plan.

## 4. Review, repair, and simplify on a stable tree

Use the following loop before final acceptance:

1. Stop all writers. Record the execution worktree `HEAD`, status, original pre-workflow audited
   PR head, and complete cumulative diff from that original head through the current worktree,
   including committed, staged, unstaged, and pending late-feedback edits, as the stable-tree
   identity. Do not use only the working-tree diff after a run-owned feedback commit enters
   `HEAD`.
2. Launch two fresh read-only reviewers against that same tree:
   - **Standards reviewer:** check the complete cumulative planned change from the original
     pre-workflow audited PR head against `AGENTS.md`, task-specific engineering and architecture
     guidance, security and maintainability boundaries, existing patterns, and the requirement for
     the simplest correct implementation.
   - **Spec reviewer:** check the same complete cumulative change, every accepted feedback
     disposition, and changed behavior against the originating issue, PR contract, acceptance
     criteria, directly relevant canonical sources, and observable tests.
3. Require each reviewer to report only concrete, evidence-backed findings with file/line or source
   references, materiality, and a specific correction. A clean review must say so explicitly.
4. Independently disposition all review findings. If any accepted finding requires edits, delegate
   only those corrections to a repair subagent, inspect its complete diff, run focused checks, and
   establish a new stable tree.
5. After accepted findings are repaired, delegate a fresh behavior-preserving simplification pass
   over the complete planned diff. Require removal of accidental complexity, unnecessary
   indirection, duplication, dead code, avoidable branches, and verbose tests without changing
   behavior or widening scope. Require an explicit no-op result when no safe simplification exists.
6. Inspect simplification edits and run focused checks. If a repair or simplification materially
   changes behavior, contracts, tests, boundaries, or the substance of the diff, repeat both fresh
   independent reviews against the new stable tree. Continue the repair, simplification, and
   review loop until no accepted material finding remains.
7. Run the Agent Factory Fallow changed-code fix loop against the PR merge base. Every valid
   finding enters the same repair path. If a Fallow repair materially changes the diff, repeat
   both reviews and simplification against the new stable tree, then rerun Fallow until its
   verdict passes.
8. Never prime a repeated reviewer with the earlier review result or claim that a finding is fixed.
   Give it the current stable tree and primary contract so it can verify independently.

## 5. Perform independent orchestrator acceptance

After the delegated loop is clean, independently:

1. Inspect the complete cumulative final diff from the original pre-workflow audited PR head and
   repository status, including any run-owned commit already in `HEAD` and pending late-feedback
   edits. Confirm every changed line belongs to an audited disposition, every accepted code-change
   item has a corresponding change and test, no unrelated file is included, and no planned
   feedback item was omitted.
2. Recheck the originating contract, repository guidance, both final reviewer reports, repair and
   simplification results, and all explanation-only evidence. Reject unsupported conclusions or
   incomplete changes back to a scoped repair subagent, then repeat the affected stable-tree
   reviews after material repair.
3. Run the exact focused checks from the plan, followed by `git diff --check`,
   `bun run validate`, and the Agent Factory Fallow audit against the verified PR merge base.
   Inspect the Fallow JSON verdict rather than its shell status.
4. Do not proceed with unresolved correctness, security, specification, typecheck, test, lint,
   build, or formatting failures. If a required check has no documented repeatable command,
   disclose that limitation instead of claiming it passed. Separate environmental failures from
   code failures, exhaust safe documented diagnostics, and report a blocker rather than
   committing, pushing, replying, or resolving when required verification cannot complete.

This acceptance pass is mandatory and cannot be replaced by subagent reports.

## 6. Create and push commits without rewriting history

1. Query the PR head and inspect
   `git ls-remote HEAD_PUSH_TARGET refs/heads/PR_HEAD_BRANCH` immediately before committing. Stop
   if the repository, branch, or commit differs from the accepted snapshot.
2. If tracked files changed, stage only planned feedback files, inspect the staged diff, and create
   exactly one commit with a concise message such as `fix: address PR #4 review feedback`.
   Create no commit when the accepted result changes no tracked files.
3. When a commit was created, verify it contains no unrelated files and differs from the audited
   PR head by exactly that one feedback commit.
4. When a commit was created, reconfirm the remote PR head still equals the audited head, then push
   without force using `git push HEAD_PUSH_TARGET HEAD:refs/heads/PR_HEAD_BRANCH`. The push target
   must still resolve to the exact PR head repository. Never assume `origin`, push a
   cross-repository PR's feedback commit to its base repository, or publish a temporary local
   branch under another name.
5. Wait for required GitHub checks, explicitly including `Fallow / changed-code audit`, and inspect
   failures. A Fallow failure without inline feedback still enters the repair loop from the
   internal Agent Factory Fallow skill. Do not reply to or resolve threads until the pushed commit
   and all required checks succeed. If no commit was needed, reverify current required checks
   before replying.
6. If a post-push correction is required, create one additional ordinary commit for the accepted
   correction, repeat the required delegated review and acceptance stages, rerun verification, and
   push again without force. Never amend, rebase, or force-push any commit — including commits this
   workflow created. If concurrent updates prevent a safe push, report the blocker. Update the
   expected PR head to the verified pushed commit after every successful run-owned push.

## 7. Converge, reply, and resolve

After the initial complete snapshot, use the single shared budget of at most three
external-feedback waves before handoff. The post-plan/pre-edit fetch in section 3 and every fetch
here draw from this same budget. A wave is consumed only when a complete fetch contains external
feedback not already audited at its current content or action-relevant thread state. This bound
prevents an endless review loop without creating an unbounded pre-edit path.

1. For every convergence and final-handoff fetch, obtain PR metadata and `headRefOid` together with
   the Fallow check conclusion and failure details, and every comment in every inline thread,
   including root comments, replies, and comments or edits on resolved or outdated threads, plus
   all review bodies (including low-confidence suggestions) and PR conversation comments. Require
   `headRefOid` to equal the expected run-owned head. After a successful run-owned push, update
   that expectation to the verified pushed commit. Unexpected external head movement stops further
   GitHub mutations immediately: do not push, reply, or resolve against stale code. Report both
   commits and re-audit only when a new safe base can be established without rewriting or
   absorbing external work.
2. Fingerprint every external item by stable GitHub identity plus its current content and edit
   metadata and, for an inline thread, its `isResolved` and `isOutdated` state. Include resolved,
   outdated, and purely informational inventory entries. Compare the complete fingerprint set only
   with the immediately preceding complete set, then retain the current set as the next baseline.
   New or edited content and action-relevant state changes are external deltas. In particular, a
   state-only transition back to unresolved and non-outdated re-enters the thread into the audit
   and makes it resolution-eligible. An audited thread also stays resolution-eligible if this
   run's accepted fix later makes it outdated. A new or edited actionable comment on a thread that
   remains resolved or outdated is reply-eligible and requires its own disposition, but is not
   resolution-eligible: preserve the thread's prior state, never reopen it, and never resolve or
   re-resolve older feedback solely because of the new item.
3. Keep an exact mutation ledger for the reply comment IDs, summary comment ID, resolution mutation
   results, and pushed heads owned by this run. Exclude only the exact content or state transition
   attributable to those recorded mutations, such as this run's own resolution or a thread made
   outdated by its verified push; do not exclude changes by account identity. Any later external
   edit or state-only reopen is a new delta.
4. If a fetch has an external delta, consume one wave. Delegate a read-only audit of only that
   delta under section 2, independently accept its dispositions, and extend the execution plan
   with every item. Address accepted items in this same run. Unchanged historical items and exact
   run-owned mutations do not consume a wave.
   A new Fallow finding or newly failing Fallow check is an external delta even when no inline
   comment was posted; inspect the log, reproduce it locally, and inventory its findings. Merely
   pending or successful check-state transitions and duplicate findings do not consume a wave.
5. When a late delta requires tracked-file changes, repeat the complete sequence: scoped fix or
   repair, fresh independent Standards and Spec reviews, behavior-preserving simplification,
   orchestrator acceptance, and all required verification and checks. Every review,
   simplification pass, and acceptance pass must inspect the complete cumulative change from the
   original pre-workflow audited PR head, including the late delta and any run-owned feedback
   commits already in `HEAD`; never limit these passes to the uncommitted late diff. If a late
   round changes tracked files after a run-owned commit was already pushed, create one additional
   ordinary commit for that round and follow section 6's remote-head revalidation and non-force
   push path; never rewrite pushed history. For every late delta that requires a pushed commit,
   wait for required GitHub checks and inspect failures after the push; do not reply to or resolve
   any item in that delta until those checks succeed.
6. After a complete fetch finds no current unaudited delta and checks pass, upsert exactly one
   run-owned disposition reply for every reply-eligible audited inline feedback item. For a
   resolution-eligible thread, post every required reply before resolving it:
   - for a fix, name the outcome, feedback commit, and supporting check;
   - for explanation-only, invalid, duplicate, or already-addressed feedback, state the disposition
     and cite concrete code, test, issue, or design evidence;
   - never claim a check passed or behavior changed without verifying it.
   Record each feedback-item-to-reply mapping. Later passes verify the mapped reply instead of
   creating another. If a late commit changes the feedback commit or check evidence, update the
   existing run-owned reply in place so it names the current verified commit and checks. Never add
   a duplicate disposition reply for the same audited item.
7. Create an initial reply using the numeric `databaseId` under the thread's `rootComment` from the
   fetcher. Do not use a reply comment's ID:

   ```bash
   gh api --method POST \
     repos/OWNER/REPO/pulls/NUMBER/comments/COMMENT_DATABASE_ID/replies \
     --raw-field body='DISPOSITION AND EVIDENCE'
   ```

   Update an existing run-owned reply by its recorded comment `databaseId`:

   ```bash
   gh api --method PATCH \
     repos/OWNER/REPO/pulls/comments/REPLY_COMMENT_DATABASE_ID \
     --raw-field body='CURRENT DISPOSITION AND EVIDENCE'
   ```

8. Resolve a resolution-eligible thread using its GraphQL node ID after every reply-eligible item
   in it has its single verified reply. Preserve the existing state of a thread that is not
   resolution-eligible; never reopen or re-resolve it solely to dispose of a new or edited item:

   ```bash
   gh api graphql \
     -f query='mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } } }' \
     -f thread='THREAD_NODE_ID'
   ```

9. Consolidate audited review-body and conversation-comment dispositions into one concise,
   run-owned top-level PR summary. Create it once, update that same comment after later rounds, and
   do not create duplicate summaries. If a late commit changes commit or check evidence, update
   that existing summary in place. Do not post one when no top-level feedback requires a response.
10. Fetch after each addressed delta and after every reply, summary update, and resolution batch.
    Finish only after a final complete fetch matches the expected head, the Fallow check succeeds,
    no unaudited content or action-relevant state delta remains, and the single current reply for
    every audited inline item plus each intended resolution is verified. If a fourth
    external-feedback wave appears after all three waves were consumed, do not start an unbounded
    fourth audit: leave only that excess delta untouched and report its exact thread, review, or
    comment IDs plus any failing-check identifiers. Unexpected external head movement always uses
    step 1's stale-head stop rule rather than the wave limit.

## 8. Report the handoff

Report the PR URL, remote branch, execution worktree, any temporary local branch, feedback commit
hashes or explicit no-commit outcome, verification results, final Standards and Spec review
results, simplification result, independent acceptance evidence, disposition of every audited
item, resolved thread IDs, the run-owned top-level summary if any, exact IDs for any fourth-wave
excess, limitations, and preserved unrelated worktree changes. Retain an isolated fallback
worktree until explicit cleanup approval, and state that the PR remains unmerged for human review.
