import { describe, expect, test } from "bun:test";
import { parseProjectProfile, parseProjectProfileYaml } from "@/contracts/project-profile.ts";
import {
	applyLabelMigration,
	approveLabelMigration,
	type GitHubAllowedMutation,
	type GitHubLabelGateway,
	GitHubMutationExecutor,
	LabelMigrationApprovalError,
	LabelMigrationDriftError,
	planLabelMigration,
	type RepositoryLabel,
	renderLabelMigrationPreview,
} from "@/github/index.ts";
import { FixedClockAdapter, InMemoryGitHubMutationLedger } from "@/testing/index.ts";

const profile = parseProjectProfileYaml(
	await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);
const fixtureLabels = (await Bun.file(
	new URL("fixtures/github/lumen-labels.json", import.meta.url),
).json()) as {
	readonly name: string;
	readonly color: string;
	readonly description: string | null;
}[];
const currentLabels: readonly RepositoryLabel[] = fixtureLabels.map((label) => ({
	name: label.name,
	color: label.color,
	description: label.description ?? "",
}));

class Ids {
	#next = 1;

	public nextMutationId(): string {
		const id = `migration-${this.#next}`;
		this.#next += 1;
		return id;
	}
}

class MigrationGateway implements GitHubLabelGateway {
	public labels: RepositoryLabel[];
	public readonly applied: GitHubAllowedMutation[] = [];

	public constructor(labels: readonly RepositoryLabel[]) {
		this.labels = labels.map((label) => ({ ...label }));
	}

	public async apply(input: unknown): Promise<void> {
		this.applied.push(input as GitHubAllowedMutation);
	}

	public async verify(): Promise<boolean> {
		return true;
	}

	public async readSubjectLabels(): Promise<readonly string[]> {
		return [];
	}

	public async listRepositoryLabels(): Promise<readonly RepositoryLabel[]> {
		return structuredClone(this.labels);
	}
}

function executor(gateway: MigrationGateway): GitHubMutationExecutor {
	return new GitHubMutationExecutor(
		new InMemoryGitHubMutationLedger(new FixedClockAdapter(), new Ids()),
		gateway,
	);
}

describe("target-scoped label migration", () => {
	test("renders deterministic previews and binds approval to exact plan content", () => {
		const first = planLabelMigration(profile, currentLabels);
		const second = planLabelMigration(profile, [...currentLabels].reverse());

		expect(second).toEqual(first);
		expect(renderLabelMigrationPreview(second)).toBe(renderLabelMigrationPreview(first));
		expect(first.operations).toHaveLength(11);
		expect(
			first.operations.some(
				(operation) =>
					operation.kind === "update" &&
					operation.current.name === profile.labels.implementationReady,
			),
		).toBe(true);
		expect(JSON.stringify(first.operations)).not.toContain('"feature"');
		expect(approveLabelMigration(first, first.hash)).toEqual(first);
		expect(() => approveLabelMigration(first, "0".repeat(64))).toThrow(LabelMigrationApprovalError);

		const tampered = {
			...first,
			repository: "ExampleOrg/other-target",
		};
		expect(() => approveLabelMigration(tampered, first.hash)).toThrow(LabelMigrationApprovalError);
	});

	test("rejects apply on source drift before executing any label mutation", async () => {
		const plan = planLabelMigration(profile, currentLabels);
		const gateway = new MigrationGateway([
			...currentLabels,
			{
				name: "drifted-after-preview",
				color: "ededed",
				description: "external change",
			},
		]);

		await expect(
			applyLabelMigration({
				profile,
				plan,
				approvedHash: plan.hash,
				mutations: executor(gateway),
			}),
		).rejects.toBeInstanceOf(LabelMigrationDriftError);
		expect(gateway.applied).toEqual([]);
	});

	test("rejects a valid plan/hash pair when applied against another target profile", async () => {
		const plan = planLabelMigration(profile, currentLabels);
		const otherProfile = parseProjectProfile({
			...profile,
			id: "other-target",
			repository: "ExampleOrg/other-target",
		});
		const gateway = new MigrationGateway(currentLabels);

		await expect(
			applyLabelMigration({
				profile: otherProfile,
				plan,
				approvedHash: plan.hash,
				mutations: executor(gateway),
			}),
		).rejects.toBeInstanceOf(LabelMigrationApprovalError);
		expect(gateway.applied).toEqual([]);
	});
});
