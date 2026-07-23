# Post-v1 work

The approved v1 specification originally excluded the capabilities below. Issue #5 separately
authorized the narrow conflict-repair item for v1.1. The other items remain future work and this
record does not authorize them.

## Just-in-time conflict repair — implemented in v1.1

Issue #5 implements conflict repair only when a PR is converged except for
`mergeability: conflicting`. It is profile-opt-in, bounded independently from feedback, uses the
existing feedback lane and PR-scoped Codex thread, and requires a newly observed non-conflicting
head before accepting completion. Normal current-head convergence then starts again.

This is not a rebase assistant. Rebase, amend, force-push, history rewriting, default-branch
push, and automatic PR merge remain forbidden. See
[Just-in-time conflict repair](conflict-repair.md).

## Automatic rollout promotion

A future specification may define evidence thresholds, failure budgets, observation periods, and
operator override for automatic promotion or demotion. V1 rollout transitions remain adjacent,
explicit operator commands. Self-update preserves stage, mode, and effective limits and does not
interpret successful updates as rollout evidence.

## Controlled external CLI upgrades

A future specification may define pinned sources, signatures, compatibility matrices, staged
installation, credential boundaries, rollback, and maintenance windows for Git, gh, Bun, Claude
Code, Codex, or Herdr. V1 release artifacts contain only this factory repository and its frozen
dependencies. The self-update adapter can invoke the existing Git and Bun binaries to build the
factory and systemctl to restart its service, but it cannot install, replace, or upgrade those
tools.

Except for issue #5's conflict-repair scope above, these notes grant no implementation authority.
A separate approved issue/specification is required before adding the remaining capabilities.
