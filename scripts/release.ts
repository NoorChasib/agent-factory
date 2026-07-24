/**
 * Release helper: bumps package.json and release.json to the same new version,
 * runs the full validation gate, commits, and creates an annotated tag.
 *
 * Usage: bun run release <patch|minor|major|x.y.z>
 *
 * The script never pushes. Publish with:
 *   git push origin main v<x.y.z>
 * The tag push triggers .github/workflows/release.yml, which creates the
 * GitHub release. requiredLedgerSchemaVersion is deliberately never touched;
 * it changes only alongside ledger migrations.
 */
import { parseReleaseBuildMetadata } from "@/contracts/release-manifest.ts";

export type BumpKeyword = "patch" | "minor" | "major";

const RELEASE_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export function isBumpKeyword(value: string): value is BumpKeyword {
	return value === "patch" || value === "minor" || value === "major";
}

export function parseVersion(version: string): readonly [number, number, number] {
	if (!RELEASE_VERSION_PATTERN.test(version)) {
		throw new Error(`Expected a strict x.y.z version, received "${version}".`);
	}
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	return [major, minor, patch];
}

export function compareVersions(left: string, right: string): number {
	const [leftMajor, leftMinor, leftPatch] = parseVersion(left);
	const [rightMajor, rightMinor, rightPatch] = parseVersion(right);
	if (leftMajor !== rightMajor) {
		return leftMajor - rightMajor;
	}
	if (leftMinor !== rightMinor) {
		return leftMinor - rightMinor;
	}
	return leftPatch - rightPatch;
}

export function computeNextVersion(current: string, request: string): string {
	if (!isBumpKeyword(request)) {
		parseVersion(request);
		if (compareVersions(request, current) <= 0) {
			throw new Error(`Requested version ${request} must be greater than current ${current}.`);
		}
		return request;
	}
	const [major, minor, patch] = parseVersion(current);
	switch (request) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

/**
 * Re-renders a JSON document with an updated version field, preserving the
 * repository convention of tab indentation and a trailing newline. Every
 * other key is carried through unchanged.
 */
export function renderVersionedJson(source: string, nextVersion: string): string {
	const document = JSON.parse(source) as { version?: unknown } & Record<string, unknown>;
	if (typeof document.version !== "string") {
		throw new Error("Document has no string version field.");
	}
	document.version = nextVersion;
	return `${JSON.stringify(document, null, "\t")}\n`;
}

type CommandResult = { readonly exitCode: number; readonly stdout: string };

function runCommand(command: readonly string[]): CommandResult {
	const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "inherit" });
	return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

function runOrFail(command: readonly string[], failure: string): string {
	const result = runCommand(command);
	if (result.exitCode !== 0) {
		throw new Error(failure);
	}
	return result.stdout;
}

function assertCleanRepository(): void {
	const status = runOrFail(
		["git", "status", "--porcelain"],
		"Unable to read git status; run from inside the repository.",
	);
	if (status.trim() !== "") {
		throw new Error("Working tree is not clean. Commit or stash changes before releasing.");
	}
	runOrFail(
		["git", "symbolic-ref", "--quiet", "HEAD"],
		"HEAD is detached. Check out a branch before releasing.",
	);
}

function assertTagAbsent(tag: string): void {
	const result = runCommand(["git", "rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]);
	if (result.exitCode === 0) {
		throw new Error(`Tag ${tag} already exists.`);
	}
}

async function readCurrentVersion(): Promise<string> {
	const packageDocument = JSON.parse(await Bun.file("package.json").text()) as {
		readonly version?: unknown;
	};
	const releaseMetadata = parseReleaseBuildMetadata(
		JSON.parse(await Bun.file("release.json").text()),
	);
	if (packageDocument.version !== releaseMetadata.version) {
		throw new Error(
			`package.json version (${String(packageDocument.version)}) and release.json version ` +
				`(${releaseMetadata.version}) differ. Align them manually before releasing.`,
		);
	}
	return releaseMetadata.version;
}

async function writeVersion(path: string, nextVersion: string): Promise<void> {
	const source = await Bun.file(path).text();
	await Bun.write(path, renderVersionedJson(source, nextVersion));
}

async function main(): Promise<void> {
	const request = Bun.argv[2];
	if (request === undefined || request === "") {
		throw new Error("Usage: bun run release <patch|minor|major|x.y.z>");
	}
	assertCleanRepository();
	const current = await readCurrentVersion();
	const next = computeNextVersion(current, request);
	const tag = `v${next}`;
	assertTagAbsent(tag);

	await writeVersion("package.json", next);
	await writeVersion("release.json", next);
	console.log(`Bumped version ${current} -> ${next}. Running validation...`);

	const validation = Bun.spawnSync(["bun", "run", "validate"], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if (validation.exitCode !== 0) {
		throw new Error("Validation failed. Version files were updated but not committed.");
	}

	runOrFail(["git", "add", "package.json", "release.json"], "git add failed.");
	runOrFail(["git", "commit", "-m", `release: ${tag}`], "git commit failed.");
	runOrFail(["git", "tag", "-a", tag, "-m", `agent-factory ${tag}`], "git tag failed.");
	console.log(`Created release commit and tag ${tag}. Publish with:`);
	console.log(`  git push origin main ${tag}`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
