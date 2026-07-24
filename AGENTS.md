# Repository Agent Guidance

## Authority and boundaries

- GitHub issues `NoorChasib/agent-factory#1` and `#2` are the implementation authority.
- Keep the factory standalone and project-agnostic. Target policy belongs only in validated
  profile or test-fixture data.
- GitHub is authoritative for lifecycle state. Local state is execution ownership, recovery, and
  audit data only.
- Never add merge, force-push, rebase, amend, review-dismissal, branch-protection bypass, or live
  credential behavior.
- Do not implement future phases speculatively. Phase ownership is tracked in `docs/README.md`.

## Module structure

- Put untrusted protocol parsing in `src/contracts/`.
- Put canonical, target-independent terminology in `src/domain/`.
- Preserve the controller's three-operation interface: `status`, `command`, and `reconcile`.
- Put every I/O seam in `src/adapters/`; deterministic test adapters live in `src/testing/`.
- Test through the controller interface and public contract parsers, not planner internals.

## TypeScript and tests

- Keep strict TypeScript enabled, including unchecked-index and exact-optional-property checks.
- Use `bun:test` and deterministic adapters. Do not use wall-clock time, ambient randomness, the
  network, or real processes in tests.
- Treat profile, YAML, worker, adapter, and command input as untrusted. Prefer strict Zod parsing
  at entry points and never silently retain unknown keys.
- Keep target names, workflow names, reviewer identities, and product terminology out of
  controller and domain source.

## Validation

Run before handoff:

```sh
bun install
bun run validate
git diff --check
```

`bun run validate` runs strict typechecking, Biome checks, and the complete test suite. Do not
commit, push, provision credentials, or mutate GitHub unless a task grants that authority
explicitly.
