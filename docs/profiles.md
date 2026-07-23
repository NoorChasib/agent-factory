# Project profiles and protocol fixtures

Profiles are strict, versioned YAML configuration. They contain target policy as data; target
source code, credentials, and executable policy do not belong in a profile or the factory.

## Shipped examples

[`../config/examples/multi-project/config.yaml`](../config/examples/multi-project/config.yaml)
loads two complete profiles:

- [`hhc-aep.yaml`](../config/examples/multi-project/profiles/hhc-aep.yaml), the HHC AEP
  integration contract as disabled configuration data; and
- [`lumen-notes.yaml`](../config/examples/multi-project/profiles/lumen-notes.yaml), a fictional
  second project with different branches, labels, reviewer/check signals, and ceilings.

Both ship with `enabled: false`. The example ntfy host/topic are inert sentinels that must be
replaced before operation. Tests load these exact checked-in bytes through the production
configuration/profile loader with mode-`0600` metadata.

## Runtime configuration

`config.yaml` has four strict keys:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Must be `1` |
| `profiles` | One or more unique relative `profiles/*.yaml` paths; no absolute/traversal paths |
| `ntfy.baseUrl` / `ntfy.topic` | HTTPS URL and 1–200 character safe topic |
| `logging.rotateBytes` / `logging.retainedFiles` | 64 KiB–1 GiB; 1–20 files |

Unknown/duplicate keys, aliases, documents over 1 MiB, symlinks, and non-private file modes fail
validation.

## Profile fields

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `id`, `enabled` | Protocol version, stable project alias, explicit opt-in |
| `repository`, `defaultBranch` | GitHub `owner/name` and target default branch |
| `workflow` | Target-owned autonomous/operator implementation and feedback entry points |
| `labels` | Mapping from every canonical lifecycle/condition stage to target label |
| `reviewPolicy` | Required configured reviewer IDs and optional owner-review label |
| `reviewers` | GitHub user/App identity and review or named check-run completion signal |
| `requiredChecks` | Current-head checks from profile or observed branch protection |
| `defaultBranchProtection` | Expected protection posture used for safety verification |
| `issueSelection` | Target workflow owns issue selection; the controller supplies no issue number |
| `timeouts` | Reviewer/check minutes and consecutive quiescence polls |
| `ceilings` | Optional non-negative project limits for implementation, feedback, ready-to-merge |

Profile IDs and repository names must be unique across the loaded configuration. Required
reviewer IDs must exist in `reviewers`. Profile-sourced required checks must name at least one
check, and checks are unique by App/name.

Production expects the configuration directory and `profiles/` directory at mode `0700`, with
`config.yaml` and every profile as regular mode-`0600` files. Copy examples with `install -m
0600`; changing only YAML content does not correct an insecure mode.

## Worker-result protocol

Workers return a strict version-1 JSON result containing:

- execution and target identity;
- issue and optional pull request;
- branch name/base, optional head SHA, and pushed flag;
- exact provider/session identity;
- checkpoint phase, monotonic sequence, and code; and
- one terminal status: `completed`, `blocked`, `operator_required`, `provider_limit`, `stalled`,
  or `failed`.

Versioned examples for every terminal status are in
[`../config/protocol/worker-result/v1/`](../config/protocol/worker-result/v1/). Its `invalid/`
directory documents rejected unknown fields/statuses, missing versions, and inconsistent pull
request/branch state. Tests drive every JSON fixture through the public `parseWorkerResult`
contract.

All profile, YAML, adapter, command, and worker inputs are untrusted. Unknown keys are rejected
rather than retained.
