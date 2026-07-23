# Target-scoped label migration

Installing or observing Agent Factory never changes repository labels. Label migration is a
separate plan, preview, approve, and apply lifecycle for exactly one validated project profile.

## Semantics

The desired set contains the seven canonical stage labels and four canonical condition labels
mapped by the selected profile. Canonical descriptions and colors are deterministic factory
metadata. The plan:

- creates a configured label that is absent;
- updates color or description when a configured label already exists;
- never deletes a repository label; and
- never renames, overwrites, or otherwise interprets extra project-owned labels.

The complete current repository label list is normalized and sorted. Its SHA-256 fingerprint is
part of the plan, so an unrelated external label change is still detected as drift before apply.

## Preview and content hash

`planLabelMigration(profile, currentLabels)` creates a versioned object containing:

- project ID and exact `owner/repository`;
- source-label fingerprint;
- the complete desired canonical label metadata; and
- ordered create/update operations.

Properties and arrays have deterministic order. `renderLabelMigrationPreview` has no timestamp,
random ID, terminal formatting, or environment-dependent ordering. The SHA-256 approval hash is
computed from the validated plan content excluding the hash field itself.

Changing the target, source fingerprint, desired metadata, or any operation changes the hash.
`approveLabelMigration` recomputes the content hash and accepts only the exact supplied value.

## Apply

`applyLabelMigration` requires all of the following:

1. the plan parses strictly;
2. its embedded hash recomputes exactly;
3. the supplied approval hash is exact;
4. project ID and repository match the selected profile;
5. desired labels still exactly match that profile's canonical mapping; and
6. a fresh full label listing has the approved source fingerprint.

Any mismatch fails before the first write. Apply then sends ordered create/update operations
through the normal mutation ledger executor. Every operation is freshly verified and reconciled
before the next begins. An ambiguous or unobserved operation stops apply.

There is no apply overload without an approval hash, no repository override parameter, and no
delete-label operation in the allowlist. Tests exercise the apply path only with fixture
gateways; the implementation and test suite never apply labels to a live repository.

## Target isolation

Project ID is present in the plan, content hash, cache keys, idempotency keys, mutation ledger
records, token selection, and gateway lookup. Repository identity is derived from the validated
profile rather than supplied by a mutation caller. A valid plan/hash pair for one profile is
rejected when presented with another profile.

