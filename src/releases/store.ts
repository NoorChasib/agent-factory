import { join, resolve } from "node:path";
import type { ClockAdapter } from "@/adapters/interfaces.ts";
import type {
	ReleaseArtifactFileSystemAdapter,
	ReleaseIdSource,
} from "@/adapters/release-interfaces.ts";
import { GitCommitShaSchema, type ReleaseManifest } from "@/contracts/release-manifest.ts";
import { within } from "@/path-guard.ts";
import {
	generateReleaseManifestAtClock,
	RELEASE_MANIFEST_FILENAME,
	validateReleaseManifest,
} from "@/releases/manifest.ts";

export class ReleaseStore {
	readonly #root: string;
	readonly #fileSystem: ReleaseArtifactFileSystemAdapter;
	readonly #clock: ClockAdapter;
	readonly #ids: ReleaseIdSource;

	public constructor(input: {
		readonly root: string;
		readonly fileSystem: ReleaseArtifactFileSystemAdapter;
		readonly clock: ClockAdapter;
		readonly ids: ReleaseIdSource;
	}) {
		this.#root = resolve(input.root);
		this.#fileSystem = input.fileSystem;
		this.#clock = input.clock;
		this.#ids = input.ids;
	}

	public get root(): string {
		return this.#root;
	}

	public async prepare(): Promise<void> {
		await this.#fileSystem.ensureDirectory(this.#root, 0o700);
	}

	public artifactPath(commitSha: string): string {
		return this.#inside(GitCommitShaSchema.parse(commitSha));
	}

	public relativeArtifactPath(commitSha: string): string {
		return GitCommitShaSchema.parse(commitSha);
	}

	public stagingPath(commitSha: string, buildId: string): string {
		const commit = GitCommitShaSchema.parse(commitSha);
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(buildId)) {
			throw new Error("release build ID is invalid");
		}
		return this.#inside(`.candidate-${commit}-${buildId}`);
	}

	public nextBuildId(): string {
		return this.#ids.nextReleaseId();
	}

	public async hasRelease(commitSha: string): Promise<boolean> {
		return this.#fileSystem.pathExists(this.artifactPath(commitSha));
	}

	public async install(input: {
		readonly commitSha: string;
		readonly stagingPath: string;
		readonly requiredLedgerSchemaVersion: number;
	}): Promise<ReleaseManifest> {
		const commitSha = GitCommitShaSchema.parse(input.commitSha);
		const stagingPath = resolve(input.stagingPath);
		if (!within(this.#root, stagingPath) || !stagingPath.startsWith(`${this.#root}/.candidate-`)) {
			throw new Error("release staging path is outside the release store");
		}
		const destination = this.artifactPath(commitSha);
		if (await this.#fileSystem.pathExists(destination)) {
			throw new Error(`immutable release '${commitSha}' is already installed`);
		}
		const inventory = (
			await this.#fileSystem.inventory(stagingPath, [RELEASE_MANIFEST_FILENAME])
		).map((entry) =>
			entry.kind === "file"
				? { ...entry, mode: (entry.mode & 0o111) === 0 ? 0o444 : 0o555 }
				: entry,
		);
		const manifest = generateReleaseManifestAtClock({
			commitSha,
			clock: this.#clock,
			requiredLedgerSchemaVersion: input.requiredLedgerSchemaVersion,
			inventory,
		});
		await this.#fileSystem.writeTextExclusive(
			join(stagingPath, RELEASE_MANIFEST_FILENAME),
			`${JSON.stringify(manifest, null, 2)}\n`,
			0o444,
		);
		await this.#fileSystem.makeImmutable(stagingPath);
		await this.#fileSystem.rename(stagingPath, destination);
		return this.validate(commitSha);
	}

	public async validate(commitSha: string): Promise<ReleaseManifest> {
		const commit = GitCommitShaSchema.parse(commitSha);
		const root = this.artifactPath(commit);
		const decoded = JSON.parse(
			await this.#fileSystem.readText(join(root, RELEASE_MANIFEST_FILENAME)),
		) as unknown;
		const inventory = await this.#fileSystem.inventory(root, [RELEASE_MANIFEST_FILENAME]);
		return validateReleaseManifest(decoded, inventory, commit);
	}

	public async currentReleaseId(): Promise<string | null> {
		const target = await this.#fileSystem.readSymbolicLink(this.#inside("current"));
		if (target === null) {
			return null;
		}
		return GitCommitShaSchema.parse(target);
	}

	public async activate(commitSha: string): Promise<string | null> {
		const commit = GitCommitShaSchema.parse(commitSha);
		if (!(await this.#fileSystem.pathExists(this.artifactPath(commit)))) {
			throw new Error(`release artifact '${commit}' is unavailable`);
		}
		const previous = await this.currentReleaseId();
		const temporary = this.#inside(`.current-${this.#ids.nextReleaseId()}`);
		try {
			await this.#fileSystem.createSymbolicLink(commit, temporary);
			await this.#fileSystem.rename(temporary, this.#inside("current"));
			return previous;
		} catch (error) {
			await this.#fileSystem.removeTree(temporary);
			throw error;
		}
	}

	public async removeStaging(path: string): Promise<void> {
		const candidate = resolve(path);
		if (!within(this.#root, candidate) || !candidate.startsWith(`${this.#root}/.candidate-`)) {
			throw new Error("refusing to remove a path outside release staging");
		}
		await this.#fileSystem.removeTree(candidate);
	}

	#inside(name: string): string {
		const path = resolve(this.#root, name);
		if (!within(this.#root, path) || path === this.#root) {
			throw new Error("release store path escaped its root");
		}
		return path;
	}
}
