# Post-v1 work: documented, not authorized

The approved v1 specification explicitly excludes the following capabilities. They are recorded
here so later design work does not leak into the v1 controller, release updater, or rollout
machinery.

## Agent-assisted rebase and conflict repair

A future specification may define attended, auditable conflict analysis and repair. It must
separately decide authority, protected-branch behavior, history-rewrite rules, stale-review
handling, verification, and operator handoff. V1 contains no rebase, amend, force-push, merge, or
conflict-repair operation.

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

None of these notes grant implementation authority. A separate approved issue/specification is
required before adding any of them.
