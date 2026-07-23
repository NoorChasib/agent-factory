import { createHash } from "node:crypto";

import type { ClockAdapter } from "../adapters/interfaces";
import {
  GitCommitShaSchema,
  type ReleaseInventoryEntry,
  ReleaseInventoryEntrySchema,
  type ReleaseManifest,
  ReleaseManifestSchema,
} from "../contracts/release-manifest";

export const RELEASE_MANIFEST_FILENAME = "release-manifest.json";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedInventory(entries: readonly ReleaseInventoryEntry[]): ReleaseInventoryEntry[] {
  const inventory = entries
    .map((entry) => ReleaseInventoryEntrySchema.parse(structuredClone(entry)))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (inventory.some((entry) => entry.path === RELEASE_MANIFEST_FILENAME)) {
    throw new Error("release inventory observations must exclude the manifest itself");
  }
  if (new Set(inventory.map((entry) => entry.path)).size !== inventory.length) {
    throw new Error("release inventory contains duplicate paths");
  }
  return inventory;
}

export function releaseInventoryHash(entries: readonly ReleaseInventoryEntry[]): string {
  return hash(JSON.stringify(normalizedInventory(entries)));
}

export function generateReleaseManifest(input: {
  readonly commitSha: string;
  readonly builtAt: Date;
  readonly requiredLedgerSchemaVersion: number;
  readonly inventory: readonly ReleaseInventoryEntry[];
}): ReleaseManifest {
  if (!Number.isFinite(input.builtAt.getTime())) {
    throw new Error("release build clock returned an invalid date");
  }
  const inventory = normalizedInventory(input.inventory);
  return ReleaseManifestSchema.parse({
    schemaVersion: 1,
    commitSha: GitCommitShaSchema.parse(input.commitSha),
    builtAt: input.builtAt.toISOString(),
    requiredLedgerSchemaVersion: input.requiredLedgerSchemaVersion,
    inventory,
    inventoryHash: releaseInventoryHash(inventory),
  });
}

export function generateReleaseManifestAtClock(input: {
  readonly commitSha: string;
  readonly clock: ClockAdapter;
  readonly requiredLedgerSchemaVersion: number;
  readonly inventory: readonly ReleaseInventoryEntry[];
}): ReleaseManifest {
  return generateReleaseManifest({
    commitSha: input.commitSha,
    builtAt: input.clock.now(),
    requiredLedgerSchemaVersion: input.requiredLedgerSchemaVersion,
    inventory: input.inventory,
  });
}

export function validateReleaseManifest(
  input: unknown,
  observedInventory: readonly ReleaseInventoryEntry[],
  expectedCommitSha?: string,
): ReleaseManifest {
  const manifest = ReleaseManifestSchema.parse(input);
  if (
    expectedCommitSha !== undefined &&
    manifest.commitSha !== GitCommitShaSchema.parse(expectedCommitSha)
  ) {
    throw new Error("release manifest commit does not match its commit-addressed directory");
  }
  const regenerated = generateReleaseManifest({
    commitSha: manifest.commitSha,
    builtAt: new Date(manifest.builtAt),
    requiredLedgerSchemaVersion: manifest.requiredLedgerSchemaVersion,
    inventory: observedInventory,
  });
  if (JSON.stringify(regenerated.inventory) !== JSON.stringify(manifest.inventory)) {
    throw new Error("release manifest inventory does not match the installed artifact");
  }
  if (regenerated.inventoryHash !== manifest.inventoryHash) {
    throw new Error("release manifest inventory hash does not match the installed artifact");
  }
  return manifest;
}
