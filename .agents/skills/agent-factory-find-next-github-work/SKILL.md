---
name: agent-factory-find-next-github-work
description: Find, claim, resume, and complete one Agent Factory GitHub issue through implementation, review, and handoff. Use when asked what work is next, to work the issue queue systematically, or to work, continue, resolve, or verify a named Agent Factory issue number or URL. Recompute and recommend the next safe issue after every handoff without starting it.
---

# Agent Factory Find Next GitHub Work

## Operating contract

- Work exactly one issue. GitHub is the durable scope, dependency, and coordination authority;
  local state is execution ownership, recovery, and audit data only.
- Issues NoorChasib/agent-factory#1 and #2 are the implementation authority. Phase ownership is
  tracked in `docs/README.md`, and `docs/post-v1.md` lists explicitly unauthorized future work.
  Never implement future phases speculatively or start work that has no authority in the issues
  or docs.
- Immediately claim every selected issue before substantive work: re-read its current state,
  assign the authenticated user, and post a short claim comment naming the intended scope. If
  another agent or assignee got there first, stop and report the issue's exact state.
- Exclude work that depends on an open prerequisite issue, an unmerged prerequisite PR, authority
  absent from the default branch, or a materially overlapping active worktree. Do not stack
  dependent work by default.
- Require fresh subagents for implementation or document edits, independent Standards and Spec
  reviews, in-scope repair, and behavior-preserving simplification. The orchestrator owns scope,
  integration, GitHub mutations, and final acceptance.
- Give every issue that changes tracked repository content one dedicated issue branch/worktree
  (run the bundled `scripts/create-ticket-worktree.sh` from this skill directory or by absolute
  path) and one non-draft issue-linked PR. This includes
  docs, scripts, tests, and config. GitHub-only mutations need neither.
- Never merge a PR, force-push, rebase, amend, dismiss reviews, or bypass branch protection.
  Never infer human approval. Do not commit, push, or mutate GitHub beyond the claims, PRs, and
  comments this workflow explicitly owns.
- For every tracked-file route, load and follow the internal sibling
  `../agent-factory-fallow/SKILL.md`. It is the sole Fallow policy and must pass before commit
  and PR handoff.

## Load repository authority

Read `AGENTS.md`, then the selected issue's full body and comment history, then every issue, PR,
and docs section it cites. For architecture or module-placement work also read
`docs/architecture.md` and the module rules in `AGENTS.md` (untrusted parsing in
`src/contracts/`, canonical terminology in `src/domain/`, I/O seams in `src/adapters/`,
deterministic test adapters in `src/testing/`, and the controller's three-operation
`status`/`command`/`reconcile` interface).

## Select and route

1. With no issue argument, discover candidates with
   `gh issue list --state open --json number,title,labels,assignees,milestone,updatedAt`.
   Read each candidate's body and comments enough to judge readiness. Rank by: explicitly
   requested by the operator, then unblocked implementation authority from issues #1/#2, then
   smallest safe next step. Present the recommendation and wait for the operator to choose.
   Never claim merely while browsing.
2. Treat an issue number or same-repository URL in the invocation as selection, but never bypass
   qualification: fetch its full body, comments, labels, assignees, linked PRs, and any worktree
   ownership before claiming.
3. Stop on terminal, handed-off, externally blocked, conflicting, missing-authority, or unsafe
   state — including anything `docs/post-v1.md` excludes. Report why instead of proceeding.
4. Record a compact plan with outcome, acceptance criteria, exclusions, dependency and authority
   evidence, risks, and verification commands (`bun install --frozen-lockfile`,
   `bun run validate`, `git diff --check`, plus focused tests). Do not pause for routine plan
   approval after a valid selection.
5. Re-fetch and claim: assign yourself and comment. Resume in-progress work only from that
   issue's current matching worktree after verifying the assignee and branch/worktree/PR
   ownership; otherwise treat the claim as reserved by another session.
6. Route: tracked-file changes go through the dedicated worktree, implementation subagents, the
   Fallow policy, independent Standards and Spec reviews, simplification, orchestrator
   acceptance, one issue-linked PR, and handoff. GitHub-only work (labels, comments, issue
   hygiene) publishes only the exact approved mutations.

## Accept and hand off

- Hand off an implementation issue only after `bun run validate` and `git diff --check` pass,
  the Fallow verdict passes, both reviews are clean or their accepted findings repaired, and the
  non-draft PR references the issue with a closing keyword.
- State plainly that the PR remains unmerged for human review. Close an issue only when its
  acceptance criteria are verifiably met and closing is this workflow's to perform.
- Never automatically continue into a second issue. After completion or handoff, rerun discovery
  read-only, recommend the highest-ranked next issue with a short reason, and print:

```text
agent-factory-find-next-github-work #123
```

Do not claim the recommendation. If candidates are genuinely tied, show each tied invocation and
ask the operator to choose in a fresh session.
