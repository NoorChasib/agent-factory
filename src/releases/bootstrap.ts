import type { ReleaseLedgerAdapter } from "@/adapters/release-interfaces.ts";
import { GitCommitShaSchema, type ReleaseManifest } from "@/contracts/release-manifest.ts";
import { CandidateReleaseMetadataSchema } from "@/contracts/release-update.ts";
import type { ReleaseBuilder } from "@/releases/builder.ts";
import type { ReleaseStore } from "@/releases/store.ts";

export interface ReleaseBootstrapResult {
	readonly releaseId: string;
	readonly manifest: ReleaseManifest;
	readonly currentReleaseId: string;
	readonly alreadyInstalled: boolean;
}

export class ReleaseBootstrapper {
	readonly #builder: ReleaseBuilder;
	readonly #store: ReleaseStore;
	readonly #ledger: ReleaseLedgerAdapter;

	public constructor(input: {
		readonly builder: ReleaseBuilder;
		readonly store: ReleaseStore;
		readonly ledger: ReleaseLedgerAdapter;
	}) {
		this.#builder = input.builder;
		this.#store = input.store;
		this.#ledger = input.ledger;
	}

	public async bootstrap(commitShaInput: string): Promise<ReleaseBootstrapResult> {
		const releaseId = GitCommitShaSchema.parse(commitShaInput);
		const releases = this.#ledger.listReleases();
		const installed = releases.find((release) => release.status === "installed");
		if (installed !== undefined && installed.releaseId !== releaseId) {
			throw new Error("initial bootstrap cannot replace an installed release");
		}
		if (releases.some((release) => release.releaseId !== releaseId)) {
			throw new Error("initial bootstrap requires an empty release ledger");
		}
		if (releases.length > 0 && installed === undefined) {
			throw new Error("initial bootstrap requires an empty or matching installed release ledger");
		}

		const current = await this.#store.currentReleaseId();
		if (current !== null && current !== releaseId) {
			throw new Error("initial bootstrap cannot replace the current release pointer");
		}
		const manifest = await this.#builder.build(releaseId);
		if (manifest.requiredLedgerSchemaVersion !== this.#ledger.schemaVersion) {
			throw new Error("initial release ledger schema does not match its validated manifest");
		}
		if (current === null) {
			await this.#store.activate(releaseId);
		}

		if (installed === undefined) {
			this.#ledger.saveRelease({
				releaseId,
				commitSha: releaseId,
				status: "installed",
				artifactPath: this.#store.relativeArtifactPath(releaseId),
				requiredSchemaVersion: manifest.requiredLedgerSchemaVersion,
				metadata: CandidateReleaseMetadataSchema.parse({
					schemaVersion: 1,
					manifest,
					update: {
						phase: "installed",
						priorPolicy: null,
						previousReleaseId: null,
						previousSchemaVersion: null,
						failureCode: null,
					},
				}),
			});
		}

		return {
			releaseId,
			manifest,
			currentReleaseId: releaseId,
			alreadyInstalled: installed !== undefined && current === releaseId,
		};
	}
}
