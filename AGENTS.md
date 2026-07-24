# Repository Agent Guidance

## Project

Agent Factory is a standalone, project-agnostic controller that supervises coding-agent workers
against GitHub-tracked work. It observes issue and PR lifecycle state, plans and commands worker
executions, and records everything in a local ledger while keeping a human as the final gate for
merges and credentials.

## Always-on boundaries

- GitHub issues `NoorChasib/agent-factory#1` and `#2` are the implementation authority.
- Keep the factory standalone and project-agnostic. Target policy belongs only in validated
  profile or test-fixture data.
- GitHub is authoritative for lifecycle state. Local state is execution ownership, recovery, and
  audit data only.
- Never add merge, force-push, rebase, amend, review-dismissal, branch-protection bypass, or live
  credential behavior.
- Do not implement future phases speculatively. Phase ownership is tracked in `docs/README.md`,
  and `docs/post-v1.md` lists explicitly unauthorized future work.
- Never commit secrets. Do not commit, push, provision credentials, or mutate GitHub unless a
  task grants that authority explicitly.

## Task-specific guidance

Read the relevant guidance before making changes:

- Module placement or architecture: put untrusted protocol parsing in `src/contracts/`, canonical
  target-independent terminology in `src/domain/`, and every I/O seam in `src/adapters/` with
  deterministic test adapters in `src/testing/`. Preserve the controller's three-operation
  interface: `status`, `command`, and `reconcile`. See `docs/architecture.md`.
- TypeScript and tests: keep strict TypeScript enabled, including unchecked-index and
  exact-optional-property checks. Use `bun:test` and deterministic adapters — no wall-clock time,
  ambient randomness, network, or real processes in tests. Test through the controller interface
  and public contract parsers, not planner internals.
- Untrusted input: treat profile, YAML, worker, adapter, and command input as untrusted. Prefer
  strict Zod parsing at entry points and never silently retain unknown keys. Keep target names,
  workflow names, reviewer identities, and product terminology out of controller and domain
  source.
- Installation, releases, or updates: read `docs/installation.md` and `docs/updates.md`. Version
  releases with `bun run release <patch|minor|major|x.y.z>`, or `bun run release` alone for an
  interactive menu of the resolved versions. Either form updates `package.json` and `release.json`
  together and never pushes.
- GitHub issue work: use `$agent-factory-find-next-github-work` as the only entry point for
  finding, selecting, resuming, or working an issue; an explicit issue number or URL may bypass
  discovery. Use `$agent-factory-address-pr-feedback` only after a PR exists and its review
  feedback needs attention. These are the only two public workflow skills;
  `$agent-factory-fallow` is internal and loaded by them.

## Review guidelines

- Look for the simplest implementation that preserves correctness, required behavior, and project
  boundaries. Prefer existing patterns over new abstractions or dependencies.
- Flag unnecessary indirection, branching, duplication, speculative generality, and verbose code
  when a smaller, clearer implementation would suffice.
- When proposing a change, recommend a concrete simplification rather than adding more machinery.
- Do not invent hypothetical problems or manufacture findings to justify a review. Raise only
  concrete, evidence-based issues that are material to correctness, requirements, security, or
  maintainability; if there are none, say the change looks good and conclude the review.
- In follow-up reviews, verify the requested fixes and inspect the new changes without
  introducing unrelated preferences or repeatedly reopening resolved points.
- Keep review feedback concise and actionable. Do not restate the diff or add commentary that
  does not help the author improve the change.

## Validation

Run before handoff:

```sh
bun install
bun run validate
git diff --check
```

`bun run validate` runs strict typechecking, Biome checks, and the complete test suite.
