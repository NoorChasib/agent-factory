import { z } from "zod";

import type { GitCustodyAdapter, GitWorktreeObservation } from "@/adapters/interfaces.ts";
import { GitBranchSchema } from "@/contracts/git-worktree-output.ts";
import { projectId, repository } from "@/contracts/primitives.ts";

const issueNumber = z.number().int().positive();
const timestamp = z.iso.datetime({ offset: true });

export const WorktreeCustodyRequestSchema = z.strictObject({
	projectId,
	repository,
	issueNumber,
	branch: GitBranchSchema,
	startPoint: GitBranchSchema,
});

export type WorktreeCustodyRequest = z.infer<typeof WorktreeCustodyRequestSchema>;

export interface FactoryWorktree {
	readonly worktreeId: string;
	readonly projectId: string;
	readonly issueNumber: number;
	readonly branch: string;
	readonly path: string;
	readonly created: boolean;
}

export const WorktreeRecoveryStateSchema = z.enum(["none", "operator-required", "stalled"]);
export type WorktreeRecoveryState = z.infer<typeof WorktreeRecoveryStateSchema>;

export const WorktreeCleanupInputSchema = z.strictObject({
	mergedAt: timestamp.nullable(),
	recoveryState: WorktreeRecoveryStateSchema,
	explicitlyReleased: z.boolean(),
});
export type WorktreeCleanupInput = z.infer<typeof WorktreeCleanupInputSchema>;

export type WorktreeCleanupAssessment =
	| {
			readonly eligible: true;
			readonly reason: "explicit-release" | "merged-retention-elapsed";
			readonly eligibleAt: string;
	  }
	| {
			readonly eligible: false;
			readonly reason:
				| "clock-before-merge"
				| "merged-retention-active"
				| "not-merged"
				| "recovery-retained";
			readonly eligibleAt: string | null;
	  };

export const MERGED_WORKTREE_RETENTION_MS = 24 * 60 * 60 * 1_000;

export function assessWorktreeCleanup(input: unknown, now: Date): WorktreeCleanupAssessment {
	const cleanup = WorktreeCleanupInputSchema.parse(input);
	if (!Number.isFinite(now.getTime())) {
		throw new Error("worktree cleanup clock returned an invalid date");
	}
	if (cleanup.explicitlyReleased) {
		return {
			eligible: true,
			reason: "explicit-release",
			eligibleAt: now.toISOString(),
		};
	}
	if (cleanup.recoveryState !== "none") {
		return {
			eligible: false,
			reason: "recovery-retained",
			eligibleAt: null,
		};
	}
	if (cleanup.mergedAt === null) {
		return { eligible: false, reason: "not-merged", eligibleAt: null };
	}
	const mergedAt = new Date(cleanup.mergedAt);
	const eligibleAt = new Date(mergedAt.getTime() + MERGED_WORKTREE_RETENTION_MS);
	if (now.getTime() < mergedAt.getTime()) {
		return {
			eligible: false,
			reason: "clock-before-merge",
			eligibleAt: eligibleAt.toISOString(),
		};
	}
	if (now.getTime() < eligibleAt.getTime()) {
		return {
			eligible: false,
			reason: "merged-retention-active",
			eligibleAt: eligibleAt.toISOString(),
		};
	}
	return {
		eligible: true,
		reason: "merged-retention-elapsed",
		eligibleAt: eligibleAt.toISOString(),
	};
}

export class WorktreeInvariantError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "WorktreeInvariantError";
	}
}

export class WorktreeCleanupNotEligibleError extends Error {
	public readonly assessment: WorktreeCleanupAssessment;

	public constructor(assessment: WorktreeCleanupAssessment) {
		super(`worktree cleanup is not eligible: ${assessment.reason}`);
		this.name = "WorktreeCleanupNotEligibleError";
		this.assessment = assessment;
	}
}

export class WorktreeCustody {
	readonly #git: GitCustodyAdapter;

	public constructor(git: GitCustodyAdapter) {
		this.#git = git;
	}

	public async ensureMirror(
		projectIdValue: string,
		repositoryValue: string,
	): Promise<"cloned" | "fetched"> {
		const parsedProjectId = projectId.parse(projectIdValue);
		const parsedRepository = repository.parse(repositoryValue);
		if (await this.#git.mirrorExists(parsedProjectId)) {
			await this.#git.fetchMirror(parsedProjectId);
			return "fetched";
		}
		await this.#git.cloneMirror(parsedProjectId, parsedRepository);
		return "cloned";
	}

	public async createIssueWorktree(input: unknown): Promise<FactoryWorktree> {
		const request = WorktreeCustodyRequestSchema.parse(input);
		await this.ensureMirror(request.projectId, request.repository);
		const path = this.#git.worktreePath(request.projectId, request.issueNumber);
		const worktrees = await this.#git.listWorktrees(request.projectId);
		const existingAtPath = worktrees.find((worktree) => worktree.path === path);
		if (existingAtPath !== undefined && existingAtPath.branch !== request.branch) {
			throw new WorktreeInvariantError(
				`issue ${request.projectId}/${request.issueNumber} worktree has a different branch`,
			);
		}
		const branchOwner = worktrees.find(
			(worktree) => worktree.branch === request.branch && worktree.path !== path,
		);
		if (branchOwner !== undefined) {
			throw new WorktreeInvariantError(
				`branch '${request.branch}' is already owned by another worktree`,
			);
		}
		if (existingAtPath === undefined) {
			await this.#git.addWorktree({
				projectId: request.projectId,
				issueNumber: request.issueNumber,
				branch: request.branch,
				startPoint: request.startPoint,
			});
		}
		return {
			worktreeId: `${request.projectId}-issue-${request.issueNumber}`,
			projectId: request.projectId,
			issueNumber: request.issueNumber,
			branch: request.branch,
			path,
			created: existingAtPath === undefined,
		};
	}

	public async removeEligible(input: {
		readonly projectId: string;
		readonly issueNumber: number;
		readonly branch: string;
		readonly cleanup: unknown;
		readonly now: Date;
	}): Promise<{ readonly removed: boolean; readonly assessment: WorktreeCleanupAssessment }> {
		const parsedProjectId = projectId.parse(input.projectId);
		const parsedIssueNumber = issueNumber.parse(input.issueNumber);
		const parsedBranch = GitBranchSchema.parse(input.branch);
		const assessment = assessWorktreeCleanup(input.cleanup, input.now);
		if (!assessment.eligible) {
			throw new WorktreeCleanupNotEligibleError(assessment);
		}
		const expectedPath = this.#git.worktreePath(parsedProjectId, parsedIssueNumber);
		const worktrees = await this.#git.listWorktrees(parsedProjectId);
		const existing = worktrees.find((worktree) => worktree.path === expectedPath);
		if (existing === undefined) {
			return { removed: false, assessment };
		}
		this.#assertRemovalIdentity(existing, expectedPath, parsedBranch);
		await this.#git.removeWorktree(parsedProjectId, parsedIssueNumber);
		return { removed: true, assessment };
	}

	#assertRemovalIdentity(
		existing: GitWorktreeObservation,
		expectedPath: string,
		expectedBranch: string,
	): void {
		if (existing.path !== expectedPath || existing.branch !== expectedBranch) {
			throw new WorktreeInvariantError("safe removal refused a worktree identity mismatch");
		}
	}
}
