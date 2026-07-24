---
name: agent-factory-fallow
description: Apply Agent Factory's changed-code Fallow policy, architecture-boundary guard, CRAP judgment, and PR-check convergence. Use only when an Agent Factory issue or PR-feedback workflow invokes it, or when the operator directly asks to audit or fix Fallow findings in this repository.
---

# Agent Factory Fallow

## Role

This is the single operational authority for Fallow in Agent Factory. It is an internal quality
policy, not a third public GitHub workflow entry point. The public issue and PR-feedback skills
load it when they change or review repository content.

Read and follow the installed `$fallow` skill before running Fallow. That skill owns safe command
execution and output interpretation; this skill owns Agent Factory's thresholds, scope, and
judgment. If the installed skill is unavailable, use this minimum fallback protocol:

- Run machine-readable commands as
  `bun x fallow <command> ... --format json --quiet --explain 2>/dev/null || true`.
- Inspect the JSON root `kind` envelope instead of shell status, and treat runtime or configuration
  error envelopes as failures.
- Never run `watch`, always inspect a `fix --dry-run` before applying `fix --yes`, and never enable
  telemetry.

This fallback governs safe CLI execution only; the Agent Factory policy and ownership below still
apply.

## Changed-code contract

- Compare the complete current change with its real branch or PR base. For issue work, use the
  merge base with the resolved default branch. For PR feedback, use the merge base with the PR's
  verified base commit or branch. Never use `HEAD` as the base after the issue's commit exists,
  because that would hide committed issue changes.
- Fallow may build the repository's dependency graph to judge dead code and boundaries, but the
  audit verdict is scoped to findings introduced by the change. Do not repair inherited findings
  outside the issue or audited-feedback scope.
- Before changing imports, module placement, or the `src/` module structure, guard the affected
  source files:

  ```bash
  bun x fallow guard <files...> --format json --quiet --explain 2>/dev/null || true
  ```

  Inspect the JSON verdict and boundary explanation before editing. A zero shell status is not a
  pass because the command deliberately preserves output for inspection.
- The boundary zones in `.fallowrc.jsonc` encode the measured import graph at adoption, not the
  aspirational AGENTS.md layering. New edges between `src/` modules require justification; removed
  edges should tighten the corresponding allow list in the same change.
- On every stable candidate tree and immediately before staging or committing, run:

  ```bash
  bun x fallow audit --base <merge-base> --format json --quiet --explain 2>/dev/null || true
  ```

  Keep the configured `new-only` gate. Inspect the JSON rather than relying on the shell status.
- The staged Lefthook audit is a last local guard, not a replacement for the stable-tree audit.
  The pull-request Action independently repeats the changed-code policy after every covered PR
  event.

## Fix loop

1. Run the changed-code audit and inventory every introduced finding, including warnings.
2. Classify each finding from code, tests, architecture authority (AGENTS.md and the module rules
   it states), and Fallow's explanation:
   - valid and in scope;
   - inherited or outside scope;
   - tool/configuration mismatch;
   - intentional design requiring a narrow, reasoned suppression.
3. Fix every valid in-scope error and every maintainability warning that has a clear scoped repair.
   Prefer the smallest code or test change that improves the design. Do not add abstractions,
   tests, or branches merely to change a metric.
4. Run focused tests (`bun test <file>`) and `bun run validate` for the full gate.
5. Rerun the audit. If a repair materially changes behavior, tests, boundaries, or the substance
   of the diff, repeat the workflow's Standards and Spec reviews before acceptance.
6. Continue until the audit verdict passes and no valid, actionable changed-code finding remains.
   Do not stage, commit, push, reply to review feedback, or resolve a thread while the verdict
   fails.

Never weaken a threshold, add a broad ignore, or suppress a finding merely to pass. An intentional
suppression must be the narrowest available, include a concrete reason, and be justified by the
issue or accepted design authority. Prefer correcting a mistaken entry point, zone, or dependency
model in `.fallowrc.jsonc` when the configuration—not the code—is wrong.

Do not apply automatic cleanup without inspecting its exact scope. If a valid finding has a safe
automatic repair, preview it first:

```bash
bun x fallow fix --dry-run --format json --quiet --explain 2>/dev/null || true
```

Only after the dry-run is accepted may the workflow run the same scoped fix with `--yes`. Inspect
the resulting diff and revert only fix-owned changes that fall outside the audited task.

## CRAP judgment

CRAP combines cyclomatic complexity with coverage. Agent Factory uses `maxCrap: 60` for production
code as a review trigger. Test files move CRAP out of reporting range because test callbacks are
not meaningful coverage targets; their direct cyclomatic, cognitive, and size rules still apply.

Current Bun LCOV cannot give Fallow exact Istanbul per-function inputs, so coverage is estimated
from the import graph. Treat an estimated CRAP finding as actionable when several of these hold:

- it is production code changed by the task;
- its score is at least 60 and its cyclomatic complexity is near or over 15;
- it combines multiple responsibilities or deeply nested decisions;
- it sits on validation, security, persistence, credential, ledger, GitHub-mutation, or outbound
  access boundaries;
- branch behavior lacks focused observable tests.

Use the metric to prompt evidence-based review, not mechanical refactoring. A function may have
strong indirect tests even when static coverage is estimated at 40%; inspect those tests before
claiming it is untested. Conversely, high estimated coverage does not excuse difficult branching.
Do not add tests solely to manipulate a score, split a cohesive validator into indirection, or
repair stable code outside the current scope. When exact Istanbul `coverage-final.json` becomes
available, reassess both the threshold and any coverage-based conclusions.

## Pull-request convergence

Treat the Fallow Action as both a required check and an automated reviewer:

- Every complete PR-feedback snapshot includes the `Fallow / changed-code audit` check conclusion,
  its failure output or artifacts, and all inline comments containing Fallow fingerprint markers.
  Do not depend on a particular bot account name.
- A Fallow inline comment is external feedback and follows the normal evidence-based disposition,
  repair, reply, and resolution process.
- A new failing Fallow check with no inline comment is still actionable. Inspect the check log and
  outputs, reproduce it with the local changed-code audit, and add each new finding to the audited
  feedback delta.
- After every workflow-owned push, wait for Fallow along with all other required checks. If it
  introduces a finding or failure not already audited, consume one existing external-feedback wave
  and run the complete fix, review, acceptance, and verification loop. Pending-to-success
  transitions and duplicate reports do not consume a wave.
- Do not interpret degraded comment posting as a clean audit. Inspect the Action conclusion and
  its changed-files, posting, and reconciliation diagnostics.

The workflow may hand off only when the local changed-code audit passes, the current PR head's
Fallow check succeeds, and all audited Fallow findings have current dispositions.
