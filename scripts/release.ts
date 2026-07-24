/**
 * Release helper: bumps package.json and release.json to the same new version,
 * runs the full validation gate, commits, and creates an annotated tag.
 *
 * Usage: bun run release <patch|minor|major|x.y.z>
 *        bun run release            (interactive menu of resolved versions)
 *
 * Running this command is the explicit operator grant of commit-and-tag
 * authority that AGENTS.md requires: it is operator-invoked release tooling,
 * never run by agents, CI, or any automated flow on their own initiative.
 *
 * The script never pushes on its own. After tagging it offers:
 *   git push origin main v<x.y.z>
 * which runs only on an explicit yes at the prompt; every other answer, and
 * any invocation with no operator attached, leaves the tag local for the
 * operator to push by hand. The tag push triggers
 * .github/workflows/release.yml, which creates the public GitHub release.
 * requiredLedgerSchemaVersion is deliberately never touched; it changes only
 * alongside ledger migrations.
 */
import { parseReleaseBuildMetadata } from "@/contracts/release-manifest.ts";

export type BumpKeyword = "patch" | "minor" | "major";

// The strict form this script emits: no leading zeros, no suffixes.
const FINAL_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
// Mirrors the ReleaseBuildMetadataSchema version regex exactly, so every version
// the contract accepts in checked-in metadata can be read as the current version.
const RELEASE_VERSION_PATTERN =
	/^(?<core>[0-9]+\.[0-9]+\.[0-9]+)(?<prerelease>-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function isBumpKeyword(value: string): value is BumpKeyword {
	return value === "patch" || value === "minor" || value === "major";
}

export type SplitVersion = {
	readonly core: readonly [number, number, number];
	readonly isFinal: boolean;
};

function parseComponent(component: string, version: string): number {
	const value = Number(component);
	if (!Number.isSafeInteger(value)) {
		throw new Error(
			`Version component "${component}" in "${version}" exceeds the safe integer range.`,
		);
	}
	return value;
}

/**
 * Accepts any version the release metadata contract permits, including leading
 * zeros, prerelease, and build suffixes. `isFinal` follows semver precedence:
 * build metadata is ignored, so only a prerelease part makes a version
 * non-final. Components beyond Number.MAX_SAFE_INTEGER are rejected rather
 * than silently rounded.
 */
export function splitVersion(version: string): SplitVersion {
	const groups = RELEASE_VERSION_PATTERN.exec(version)?.groups;
	if (groups?.["core"] === undefined) {
		throw new Error(`Expected a semantic version, received "${version}".`);
	}
	const [majorText = "0", minorText = "0", patchText = "0"] = groups["core"].split(".");
	return {
		core: [
			parseComponent(majorText, version),
			parseComponent(minorText, version),
			parseComponent(patchText, version),
		],
		isFinal: groups["prerelease"] === undefined,
	};
}

/** Accepts only bare final x.y.z versions — the form this script releases. */
export function parseVersion(version: string): readonly [number, number, number] {
	if (!FINAL_VERSION_PATTERN.test(version)) {
		throw new Error(`Expected a strict x.y.z version, received "${version}".`);
	}
	return splitVersion(version).core;
}

function compareCores(
	left: readonly [number, number, number],
	right: readonly [number, number, number],
): number {
	if (left[0] !== right[0]) {
		return left[0] - right[0];
	}
	if (left[1] !== right[1]) {
		return left[1] - right[1];
	}
	return left[2] - right[2];
}

export function compareVersions(left: string, right: string): number {
	return compareCores(parseVersion(left), parseVersion(right));
}

/**
 * The next version is always a bare final x.y.z. A prerelease current version
 * finalizes on `patch` (1.2.3-rc.1 -> 1.2.3), and an explicit request equal to
 * a prerelease's core is accepted because the final release outranks it. Build
 * metadata carries no precedence, so 1.2.3+build.4 behaves exactly like 1.2.3:
 * `patch` yields 1.2.4 and an explicit 1.2.3 is rejected as a non-increase.
 */
export function computeNextVersion(current: string, request: string): string {
	const { core, isFinal } = splitVersion(current);
	if (!isBumpKeyword(request)) {
		const requested = parseVersion(request);
		const comparison = compareCores(requested, core);
		if (comparison < 0 || (comparison === 0 && isFinal)) {
			throw new Error(`Requested version ${request} must be greater than current ${current}.`);
		}
		return request;
	}
	const [major, minor, patch] = core;
	switch (request) {
		case "major":
			return `${increment(major, current)}.0.0`;
		case "minor":
			return `${major}.${increment(minor, current)}.0`;
		case "patch":
			return isFinal
				? `${major}.${minor}.${increment(patch, current)}`
				: `${major}.${minor}.${patch}`;
	}
}

/**
 * A bumped component must itself survive splitVersion on the next release, so
 * the increment refuses to leave the safe integer range rather than writing
 * metadata this helper could never read back.
 */
function increment(component: number, current: string): number {
	const next = component + 1;
	if (!Number.isSafeInteger(next)) {
		throw new Error(
			`Bumping ${current} would push a version component beyond the safe integer range.`,
		);
	}
	return next;
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

export type ReleaseChoice = {
	readonly kind: BumpKeyword | "as-is" | "custom";
	readonly label: string;
	readonly detail: string;
	/** Absent for "custom", whose version is only known after a second prompt. */
	readonly version?: string;
};

/**
 * Builds the menu shown when no version request is passed on the command line.
 * Every keyword entry resolves through computeNextVersion, so the number the
 * operator picks is the exact version that will be released. The as-is entry
 * appears only while the current version has no tag: it is what allows the
 * first release of an already-checked-in version, which computeNextVersion
 * rejects as a non-increase.
 */
export function buildReleaseChoices(
	current: string,
	currentIsTagged: boolean,
): readonly ReleaseChoice[] {
	const bumps: readonly BumpKeyword[] = ["patch", "minor", "major"];
	const choices: ReleaseChoice[] = bumps.map((kind) => {
		const version = computeNextVersion(current, kind);
		return { kind, label: kind, detail: `${current} -> ${version}`, version };
	});
	if (!currentIsTagged) {
		choices.push({
			kind: "as-is",
			label: "as-is",
			detail: `release ${current} without bumping`,
			version: current,
		});
	}
	choices.push({ kind: "custom", label: "custom", detail: "enter an explicit version" });
	return choices;
}

/**
 * Parses the push confirmation. Only an explicit yes pushes: any other answer,
 * and the null prompt() returns at EOF, declines. Pushing the tag is what
 * triggers release.yml and publishes a public GitHub release, so a stray
 * keypress or an unattended invocation must never reach it.
 */
export function confirmsPush(answer: string | null): boolean {
	const normalized = answer?.trim().toLowerCase();
	return normalized === "y" || normalized === "yes";
}

/** Resolves a 1-based menu selection, rejecting anything outside the listed range. */
export function resolveChoice(choices: readonly ReleaseChoice[], input: string): ReleaseChoice {
	const trimmed = input.trim();
	const selected = /^[0-9]+$/u.test(trimmed) ? choices[Number(trimmed) - 1] : undefined;
	if (selected === undefined) {
		throw new Error(`Enter a number between 1 and ${choices.length}; received "${input}".`);
	}
	return selected;
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
	// release.yml only publishes tags whose commit is reachable from main, so a
	// release commit created anywhere else would produce a tag the workflow
	// rejects. Require main before any file is modified.
	const branch = runOrFail(
		["git", "symbolic-ref", "--quiet", "HEAD"],
		"HEAD is detached. Check out main before releasing.",
	).trim();
	if (branch !== "refs/heads/main") {
		throw new Error(
			`Releases must start from main; currently on ${branch.replace("refs/heads/", "")}.`,
		);
	}
}

/**
 * Reports where a tag already exists, if anywhere. A checkout that has not
 * fetched recently can be unaware of a tag another clone pushed, so origin is
 * consulted too; ls-remote exits 2 for a clean miss and anything else means the
 * lookup itself failed, which must not be read as absence.
 */
function findExistingTag(tag: string): "local" | "origin" | null {
	const local = runCommand(["git", "rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]);
	if (local.exitCode === 0) {
		return "local";
	}
	const remote = runCommand(["git", "ls-remote", "--exit-code", "--tags", "origin", tag]);
	if (remote.exitCode === 0) {
		return "origin";
	}
	if (remote.exitCode !== 2) {
		throw new Error(`Unable to check origin for tag ${tag}; verify network access and retry.`);
	}
	return null;
}

// Failing here preserves the all-or-nothing flow: nothing is written when the
// later push would be rejected anyway.
function assertTagAbsent(tag: string): void {
	const existing = findExistingTag(tag);
	if (existing === "local") {
		throw new Error(`Tag ${tag} already exists.`);
	}
	if (existing === "origin") {
		throw new Error(`Tag ${tag} already exists on origin. Fetch tags and pick a newer version.`);
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

const USAGE = "Usage: bun run release <patch|minor|major|x.y.z>";

/** prompt() returns null at EOF, which is how a piped or CI invocation reports
 * that no operator is present to answer. Those callers get the usage error the
 * argument form has always produced rather than a hang or a silent default. */
function ask(question: string): string {
	const answer = prompt(question);
	if (answer === null) {
		throw new Error(USAGE);
	}
	return answer;
}

function selectVersionInteractively(current: string): string {
	const choices = buildReleaseChoices(current, findExistingTag(`v${current}`) !== null);
	const width = Math.max(...choices.map((entry) => entry.label.length));
	console.log(`Current version: ${current}\n`);
	for (const [index, choice] of choices.entries()) {
		console.log(`  ${index + 1}) ${choice.label.padEnd(width)}  ${choice.detail}`);
	}
	console.log("");
	const choice = resolveChoice(choices, ask(`Select [1-${choices.length}]:`));
	return choice.version ?? computeNextVersion(current, ask("Version:").trim());
}

async function main(): Promise<void> {
	const request = Bun.argv[2];
	// The repository preconditions are checked before anything is displayed, so
	// a dirty tree or wrong branch fails without first asking for a selection.
	assertCleanRepository();
	const current = await readCurrentVersion();
	const next =
		request === undefined || request === ""
			? selectVersionInteractively(current)
			: computeNextVersion(current, request);
	const tag = `v${next}`;
	assertTagAbsent(tag);

	// Releasing the current version as-is has nothing to write or commit; it
	// only tags the validated HEAD.
	const bumps = next !== current;
	if (bumps) {
		await writeVersion("package.json", next);
		await writeVersion("release.json", next);
		console.log(`Bumped version ${current} -> ${next}. Running validation...`);
	} else {
		console.log(`Releasing ${current} without a version bump. Running validation...`);
	}

	const validation = Bun.spawnSync(["bun", "run", "validate"], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if (validation.exitCode !== 0) {
		throw new Error(
			bumps
				? "Validation failed. Version files were updated but not committed."
				: "Validation failed. No tag was created.",
		);
	}

	if (bumps) {
		runOrFail(["git", "add", "package.json", "release.json"], "git add failed.");
		runOrFail(["git", "commit", "-m", `release: ${tag}`], "git commit failed.");
	}
	runOrFail(["git", "tag", "-a", tag, "-m", `agent-factory ${tag}`], "git tag failed.");
	console.log(`Created ${bumps ? "release commit and tag" : "tag"} ${tag}.`);
	offerPush(tag);
}

/**
 * Offers the publish step the script used to leave entirely to the operator.
 * The push is still never automatic: it happens only on an explicit yes from a
 * real prompt, because it triggers release.yml and publishes a public GitHub
 * release. Declining — including the null prompt() returns when no operator is
 * present — prints the command and leaves the tag local, exactly as before.
 */
function offerPush(tag: string): void {
	const command = `git push origin main ${tag}`;
	console.log("\nPushing the tag triggers release.yml and publishes a public GitHub release.");
	if (confirmsPush(prompt(`Run "${command}" now? [y/N]:`))) {
		runOrFail(["git", "push", "origin", "main", tag], "git push failed.");
		console.log(`Pushed ${tag}. Watch the release workflow with: gh run list --workflow Release`);
		return;
	}
	console.log(`Left ${tag} local. Publish with:`);
	console.log(`  ${command}`);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
