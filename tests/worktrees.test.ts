import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandExecutionResult } from "@/adapters/interfaces.ts";
import { SelectionCheckoutCustody } from "@/adapters/worker-supervisor.ts";
import { parseProjectProfileYaml } from "@/contracts/project-profile.ts";
import type { GitHubProjectTokenProvider } from "@/github/index.ts";
import { InMemoryGitCustodyAdapter, ScriptedCommandAdapter } from "@/testing/index.ts";
import {
	assertAllowedGitOperation,
	assessWorktreeCleanup,
	FactoryCustodyPaths,
	FORBIDDEN_GIT_OPERATION_KINDS,
	ForbiddenGitOperationError,
	GuardedGitCommandAdapter,
	MERGED_WORKTREE_RETENTION_MS,
	parseGitWorktreePorcelain,
	WorktreeCleanupNotEligibleError,
	WorktreeCustody,
	WorktreeInvariantError,
} from "@/worktrees/index.ts";

const profile = parseProjectProfileYaml(
	await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);

class Tokens implements GitHubProjectTokenProvider {
	public readonly requests: string[] = [];

	public async tokenForProject(projectId: string): Promise<string> {
		this.requests.push(projectId);
		return "ghs_private-mirror-token";
	}
}

function ok(stdout = "", exitCode = 0): CommandExecutionResult {
	return {
		status: "exited",
		exitCode,
		stdout,
		stderr: "",
		processId: null,
	};
}

function custodyPaths(): FactoryCustodyPaths {
	return new FactoryCustodyPaths({
		mirrorBaseDirectory: "/factory-data/mirrors",
		worktreeBaseDirectory: "/factory-data/worktrees",
		protectedCheckoutDirectories: ["/operator/agent-factory", "/operator/target-project"],
	});
}

const request = {
	projectId: "project-one",
	repository: "ExampleOrg/project-one",
	issueNumber: 7,
	branch: "factory/issue-7",
	startPoint: "main",
} as const;

describe("factory mirror and issue-worktree custody", () => {
	test("strictly parses Git worktree porcelain without retaining unknown states", () => {
		const head = "1".repeat(40);
		expect(
			parseGitWorktreePorcelain(
				[
					"worktree /factory-data/mirrors/project-one.git",
					"bare",
					"",
					"worktree /factory-data/worktrees/project-one/issue-7",
					`HEAD ${head}`,
					"branch refs/heads/factory/issue-7",
					"",
				].join("\n"),
			),
		).toEqual([
			{
				path: "/factory-data/worktrees/project-one/issue-7",
				branch: "factory/issue-7",
				headSha: head,
			},
		]);
		expect(() =>
			parseGitWorktreePorcelain(
				[
					"worktree /factory-data/worktrees/project-one/issue-7",
					`HEAD ${head}`,
					"branch refs/heads/factory/issue-7",
					"future-field untrusted",
					"",
				].join("\n"),
			),
		).toThrow("unknown field");
	});

	test("keeps injected custody roots outside protected checkouts", () => {
		const paths = custodyPaths();
		expect(paths.mirrorPath("project-one")).toBe("/factory-data/mirrors/project-one.git");
		expect(paths.worktreePath("project-one", 7)).toBe(
			"/factory-data/worktrees/project-one/issue-7",
		);
		expect(
			() =>
				new FactoryCustodyPaths({
					mirrorBaseDirectory: "/operator/agent-factory/mirrors",
					worktreeBaseDirectory: "/factory-data/worktrees",
					protectedCheckoutDirectories: ["/operator/agent-factory"],
				}),
		).toThrow("outside factory and operator checkouts");
		expect(
			() =>
				new FactoryCustodyPaths({
					mirrorBaseDirectory: "/factory-data",
					worktreeBaseDirectory: "/factory-data/worktrees",
					protectedCheckoutDirectories: [],
				}),
		).toThrow("must not overlap");
	});

	test("clones or fetches mirrors and enforces one issue and branch per worktree", async () => {
		const git = new InMemoryGitCustodyAdapter(custodyPaths());
		const custody = new WorktreeCustody(git);

		expect(await custody.createIssueWorktree(request)).toEqual({
			worktreeId: "project-one-issue-7",
			projectId: "project-one",
			issueNumber: 7,
			branch: "factory/issue-7",
			path: "/factory-data/worktrees/project-one/issue-7",
			created: true,
		});
		expect(await custody.createIssueWorktree(request)).toMatchObject({
			created: false,
			issueNumber: 7,
		});
		expect(git.operations).toEqual([
			"inspect:project-one",
			"clone:project-one:ExampleOrg/project-one",
			"list:project-one",
			"add:project-one:7:factory/issue-7:main",
			"inspect:project-one",
			"fetch:project-one",
			"list:project-one",
		]);

		await expect(
			custody.createIssueWorktree({
				...request,
				issueNumber: 8,
			}),
		).rejects.toBeInstanceOf(WorktreeInvariantError);
		await expect(
			custody.createIssueWorktree({
				...request,
				branch: "factory/different-branch",
			}),
		).rejects.toBeInstanceOf(WorktreeInvariantError);
	});

	test("uses only structurally allowlisted Git commands through the injected adapter", async () => {
		for (const kind of FORBIDDEN_GIT_OPERATION_KINDS) {
			expect(() => assertAllowedGitOperation({ kind })).toThrow(ForbiddenGitOperationError);
		}
		expect(() =>
			assertAllowedGitOperation({
				kind: "add-worktree",
				...request,
				push: true,
			}),
		).toThrow(ForbiddenGitOperationError);
		expect(
			assertAllowedGitOperation({
				kind: "worktree-add-detached",
				projectId: "project-one",
				path: "/factory-data/worktrees/project-one/.selection-execution-1",
				startPoint: "main",
			}).kind,
		).toBe("worktree-add-detached");
		expect(
			assertAllowedGitOperation({
				kind: "branch-show-current",
				projectId: "project-one",
				path: "/factory-data/worktrees/project-one/.selection-execution-1",
			}).kind,
		).toBe("branch-show-current");
		expect(
			assertAllowedGitOperation({
				kind: "worktree-move",
				projectId: "project-one",
				sourcePath: "/factory-data/worktrees/project-one/.selection-execution-1",
				destinationPath: "/factory-data/worktrees/project-one/issue-7",
			}).kind,
		).toBe("worktree-move");

		const commands = new ScriptedCommandAdapter([
			ok("", 128),
			ok(),
			ok(["worktree /factory-data/mirrors/project-one.git", "bare", ""].join("\n")),
			ok(),
			ok(),
		]);
		const tokens = new Tokens();
		const git = new GuardedGitCommandAdapter({
			commands,
			tokens,
			mirrorBaseDirectory: "/factory-data/mirrors",
			worktreeBaseDirectory: "/factory-data/worktrees",
			protectedCheckoutDirectories: ["/operator/checkout"],
		});
		const created = await new WorktreeCustody(git).createIssueWorktree(request);
		await git.fetchMirror("project-one");

		expect(created.created).toBe(true);
		expect(commands.requests.map((command) => command.executable)).toEqual([
			"git",
			"git",
			"git",
			"git",
			"git",
		]);
		expect(commands.requests[1]?.argv).toEqual([
			"clone",
			"--mirror",
			"https://github.com/ExampleOrg/project-one.git",
			"/factory-data/mirrors/project-one.git",
		]);
		expect(commands.requests[3]?.argv).toEqual([
			"--git-dir",
			"/factory-data/mirrors/project-one.git",
			"worktree",
			"add",
			"-b",
			"factory/issue-7",
			"--",
			"/factory-data/worktrees/project-one/issue-7",
			"main",
		]);
		expect(commands.requests[4]?.argv).toEqual([
			"--git-dir",
			"/factory-data/mirrors/project-one.git",
			"fetch",
			"--prune",
			"origin",
		]);
		const expectedAuthorization = `Authorization: Basic ${Buffer.from(
			"x-access-token:ghs_private-mirror-token",
		).toString("base64")}`;
		expect(commands.requests[1]?.env).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
			GIT_CONFIG_VALUE_0: expectedAuthorization,
			GIT_TERMINAL_PROMPT: "0",
		});
		expect(commands.requests[4]?.env).toEqual(commands.requests[1]?.env);
		expect(tokens.requests).toEqual(["project-one", "project-one"]);
		expect(
			commands.requests
				.filter((_, index) => index !== 1 && index !== 4)
				.every((command) => Object.keys(command.env).length === 0),
		).toBe(true);
		expect(commands.requests.flatMap((command) => command.argv)).not.toContain(
			"ghs_private-mirror-token",
		);
		expect(commands.requests[1]?.argv[2]).toBe("https://github.com/ExampleOrg/project-one.git");
		expect(commands.requests[1]?.argv.join(" ")).not.toContain("x-access-token");
		expect(
			commands.requests.some((command) =>
				command.argv.some((argument) => /^(?:push|rebase|reset|merge|commit)$/u.test(argument)),
			),
		).toBe(false);
		expect(commands.remaining()).toBe(0);
	});

	test("routes selection checkout operations through the local guarded Git allowlist", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-factory-selection-"));
		try {
			const mirrorBaseDirectory = join(directory, "mirrors");
			const worktreeBaseDirectory = join(directory, "worktrees");
			const commands = new ScriptedCommandAdapter([ok(), ok("factory/issue-7\n"), ok()]);
			const tokens = new Tokens();
			const git = new GuardedGitCommandAdapter({
				commands,
				tokens,
				mirrorBaseDirectory,
				worktreeBaseDirectory,
				protectedCheckoutDirectories: [],
			});
			const selections = new SelectionCheckoutCustody({
				git,
				worktreeDirectory: worktreeBaseDirectory,
			});

			const source = await selections.prepare(profile, "execution-1");
			expect(
				await selections.finalize({
					profile,
					executionId: "execution-1",
					issueNumber: 7,
					branch: "factory/issue-7",
				}),
			).toBe("lumen-notes-issue-7");
			const destination = join(worktreeBaseDirectory, "lumen-notes", "issue-7");

			expect(commands.requests.map((command) => command.argv)).toEqual([
				[
					"--git-dir",
					join(mirrorBaseDirectory, "lumen-notes.git"),
					"worktree",
					"add",
					"--detach",
					source,
					"trunk",
				],
				["-C", source, "branch", "--show-current"],
				[
					"--git-dir",
					join(mirrorBaseDirectory, "lumen-notes.git"),
					"worktree",
					"move",
					source,
					destination,
				],
			]);
			expect(commands.requests.every((command) => Object.keys(command.env).length === 0)).toBe(
				true,
			);
			expect(tokens.requests).toEqual([]);
			expect(commands.remaining()).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("worktree cleanup eligibility and safe removal", () => {
	const mergedAt = "2026-07-22T00:00:00.000Z";
	const exactBoundary = new Date(new Date(mergedAt).getTime() + MERGED_WORKTREE_RETENTION_MS);

	test("becomes eligible exactly at 24 hours and retains recovery state", () => {
		expect(
			assessWorktreeCleanup(
				{
					mergedAt,
					recoveryState: "none",
					explicitlyReleased: false,
				},
				new Date(exactBoundary.getTime() - 1),
			),
		).toEqual({
			eligible: false,
			reason: "merged-retention-active",
			eligibleAt: exactBoundary.toISOString(),
		});
		expect(
			assessWorktreeCleanup(
				{
					mergedAt,
					recoveryState: "none",
					explicitlyReleased: false,
				},
				exactBoundary,
			),
		).toEqual({
			eligible: true,
			reason: "merged-retention-elapsed",
			eligibleAt: exactBoundary.toISOString(),
		});
		expect(
			assessWorktreeCleanup(
				{
					mergedAt,
					recoveryState: "stalled",
					explicitlyReleased: false,
				},
				new Date(exactBoundary.getTime() + MERGED_WORKTREE_RETENTION_MS),
			),
		).toEqual({
			eligible: false,
			reason: "recovery-retained",
			eligibleAt: null,
		});
		expect(
			assessWorktreeCleanup(
				{
					mergedAt: null,
					recoveryState: "operator-required",
					explicitlyReleased: true,
				},
				exactBoundary,
			),
		).toEqual({
			eligible: true,
			reason: "explicit-release",
			eligibleAt: exactBoundary.toISOString(),
		});
	});

	test("removes only the exact eligible issue worktree without force", async () => {
		const git = new InMemoryGitCustodyAdapter(custodyPaths());
		const custody = new WorktreeCustody(git);
		await custody.createIssueWorktree(request);

		await expect(
			custody.removeEligible({
				projectId: request.projectId,
				issueNumber: request.issueNumber,
				branch: request.branch,
				cleanup: {
					mergedAt,
					recoveryState: "operator-required",
					explicitlyReleased: false,
				},
				now: exactBoundary,
			}),
		).rejects.toBeInstanceOf(WorktreeCleanupNotEligibleError);
		expect(
			await custody.removeEligible({
				projectId: request.projectId,
				issueNumber: request.issueNumber,
				branch: request.branch,
				cleanup: {
					mergedAt,
					recoveryState: "none",
					explicitlyReleased: false,
				},
				now: exactBoundary,
			}),
		).toMatchObject({
			removed: true,
			assessment: { eligible: true, reason: "merged-retention-elapsed" },
		});
		expect(git.operations.at(-1)).toBe("remove:project-one:7");
		expect(
			await custody.removeEligible({
				projectId: request.projectId,
				issueNumber: request.issueNumber,
				branch: request.branch,
				cleanup: {
					mergedAt,
					recoveryState: "none",
					explicitlyReleased: false,
				},
				now: exactBoundary,
			}),
		).toMatchObject({ removed: false });
	});

	test("builds safe removal without force for only the derived issue path", async () => {
		const commands = new ScriptedCommandAdapter([ok()]);
		const tokens = new Tokens();
		const git = new GuardedGitCommandAdapter({
			commands,
			tokens,
			mirrorBaseDirectory: "/factory-data/mirrors",
			worktreeBaseDirectory: "/factory-data/worktrees",
			protectedCheckoutDirectories: ["/operator/checkout"],
		});

		await git.removeWorktree("project-one", 7);
		expect(commands.requests[0]?.argv).toEqual([
			"--git-dir",
			"/factory-data/mirrors/project-one.git",
			"worktree",
			"remove",
			"/factory-data/worktrees/project-one/issue-7",
		]);
		expect(commands.requests[0]?.argv).not.toContain("--force");
		expect(commands.requests[0]?.env).toEqual({});
		expect(tokens.requests).toEqual([]);
	});
});
