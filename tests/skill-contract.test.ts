import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Protect the delegated PR-feedback workflow contract from silent regression.
const SKILL_TEXT = readFileSync(
	join(import.meta.dir, "..", ".agents", "skills", "agent-factory-address-pr-feedback", "SKILL.md"),
	"utf8",
)
	.split(/\s+/u)
	.join(" ");

describe("PR-feedback skill contract", () => {
	test("requires every independent role", () => {
		const requiredContracts = [
			"read-only audit subagent",
			"scoped fix subagent",
			"repair subagent",
			"Standards reviewer",
			"Spec reviewer",
			"behavior-preserving simplification",
			"independent orchestrator acceptance",
		];
		for (const contract of requiredContracts) {
			expect(SKILL_TEXT).toContain(contract);
		}
	});

	test("orders acceptance before remote mutations", () => {
		const headings = [
			"## 2. Delegate the read-only feedback audit",
			"## 3. Revalidate and delegate scoped fixes",
			"## 4. Review, repair, and simplify on a stable tree",
			"## 5. Perform independent orchestrator acceptance",
			"## 6. Create and push commits without rewriting history",
			"## 7. Converge, reply, and resolve",
		];
		const positions = headings.map((heading) => SKILL_TEXT.indexOf(heading));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	test("requires stable-tree rechecks after material changes", () => {
		expect(SKILL_TEXT).toContain("against that same tree");
		expect(SKILL_TEXT).toContain("repeat both fresh independent reviews");
		expect(SKILL_TEXT).toContain("Never prime a repeated reviewer");
	});

	test("preserves commit and audited-thread boundaries", () => {
		expect(SKILL_TEXT).toContain("Create exactly one additional commit");
		expect(SKILL_TEXT).toContain("Do not resolve deferred, ambiguous, unaudited");
		expect(SKILL_TEXT).toContain("rootComment");
	});

	test("never rewrites history", () => {
		expect(SKILL_TEXT).toContain("Never merge, force-push, rebase, or amend any commit");
		expect(SKILL_TEXT).toContain("every correction is a new ordinary commit pushed without force");
		expect(SKILL_TEXT).toContain(
			"Never amend, rebase, or force-push any commit — including commits this workflow created",
		);
		expect(SKILL_TEXT).not.toContain("--force-with-lease");
	});

	test("requires explicit mutation authority and read-only inspection", () => {
		expect(SKILL_TEXT).toContain(
			"the repository mutations AGENTS.md requires explicit authority for",
		);
		expect(SKILL_TEXT).toContain("grants exactly that authority and no more");
		expect(SKILL_TEXT).toContain("stop after the read-only audit");
	});

	test("converges on feedback arriving during the run", () => {
		const requiredContracts = [
			"single shared budget of at most three",
			"unresolved and non-outdated when that item enters the audited plan",
			"including low-confidence suggestions",
			"PR conversation comments",
			"New or edited content and action-relevant state changes",
			"repeat the complete sequence: scoped fix or repair",
			"fresh independent Standards and Spec reviews",
			"behavior-preserving simplification",
			"orchestrator acceptance",
			"Finish only after a final complete fetch matches the expected head",
		];
		for (const contract of requiredContracts) {
			expect(SKILL_TEXT).toContain(contract);
		}
	});

	test("bounds convergence and late-round commits", () => {
		expect(SKILL_TEXT).toContain("If a fourth external-feedback wave appears");
		expect(SKILL_TEXT).toContain("leave only that excess delta untouched");
		expect(SKILL_TEXT).toContain("report its exact thread, review, or comment IDs");
		expect(SKILL_TEXT).toContain(
			"If a late round changes tracked files after a run-owned commit was already pushed",
		);
		expect(SKILL_TEXT).toContain("section 6's remote-head revalidation and non-force push path");
		expect(SKILL_TEXT).toContain("never rewrite pushed history");
	});

	test("waits for late-push checks before mutating feedback", () => {
		const checkGate =
			"For every late delta that requires a pushed commit, wait for required GitHub checks";
		expect(SKILL_TEXT).toContain(checkGate);
		expect(SKILL_TEXT).toContain(
			"do not reply to or resolve any item in that delta until those checks succeed",
		);
		expect(SKILL_TEXT.indexOf(checkGate)).toBeLessThan(
			SKILL_TEXT.indexOf("6. After a complete fetch finds no current unaudited delta"),
		);
		expect(SKILL_TEXT).toContain("Fetch after each addressed delta");
	});

	test("makes fallow part of acceptance and convergence", () => {
		const requiredContracts = [
			"../agent-factory-fallow/SKILL.md",
			"Fallow / changed-code audit",
			"failed Fallow check is actionable even when it posted no comment",
			"Every valid finding enters the same repair path",
			"new Fallow finding or newly failing Fallow check is an external delta",
			"the Fallow check succeeds",
		];
		for (const contract of requiredContracts) {
			expect(SKILL_TEXT).toContain(contract);
		}
	});

	test("audits top-level suggestions regardless of confidence", () => {
		expect(SKILL_TEXT).toContain(
			"Audit and classify every review body or PR conversation comment that contains a " +
				"suggestion or requested change",
		);
		expect(SKILL_TEXT).toContain("explicitly including low-confidence items");
		expect(SKILL_TEXT).toContain(
			"purely informational top-level entries may remain inventory-only",
		);
	});

	test("fingerprints all inline comments but bounds actions", () => {
		expect(SKILL_TEXT).toContain("every comment in every inline thread");
		expect(SKILL_TEXT).toContain("comments or edits on resolved or outdated threads");
		expect(SKILL_TEXT).toContain("is reply-eligible and requires its own disposition");
		expect(SKILL_TEXT).toContain(
			"never resolve or re-resolve older feedback solely because of the new item",
		);
	});

	test("separates reply from thread-resolution eligibility", () => {
		expect(SKILL_TEXT).toContain(
			"Record reply eligibility separately from thread-resolution eligibility",
		);
		expect(SKILL_TEXT).toContain(
			"every audited inline item containing a suggestion or requested change is " +
				"reply-eligible, regardless of thread state",
		);
		expect(SKILL_TEXT).toContain(
			"stays resolution-eligible for this run if the run's accepted fix later makes it outdated",
		);
		expect(SKILL_TEXT).toContain(
			"run-owned disposition reply for every reply-eligible audited inline feedback item",
		);
		expect(SKILL_TEXT).toContain(
			"never reopen or re-resolve it solely to dispose of a new or edited item",
		);
	});

	test("fingerprints complete snapshots against the immediate baseline", () => {
		expect(SKILL_TEXT).toContain("complete fingerprint set for every external feedback item");
		expect(SKILL_TEXT).toContain(
			"including resolved, outdated, and purely informational inventory entries",
		);
		expect(SKILL_TEXT).toContain(
			"Compare the complete fingerprint set only with the immediately preceding complete set",
		);
		expect(SKILL_TEXT).toContain(
			"Unchanged historical items and exact run-owned mutations do not consume a wave",
		);
		expect(SKILL_TEXT).not.toContain("compare those fingerprints with all prior audited rounds");
	});

	test("late reviews cover the cumulative change from the original head", () => {
		expect(SKILL_TEXT).toContain("original pre-workflow audited PR head");
		expect(SKILL_TEXT).toContain(
			"complete cumulative diff from that original head through the current worktree",
		);
		expect(SKILL_TEXT).toContain(
			"including committed, staged, unstaged, and pending late-feedback edits",
		);
		expect(SKILL_TEXT).toContain(
			"Every review, simplification pass, and acceptance pass must inspect the " +
				"complete cumulative change",
		);
		expect(SKILL_TEXT).toContain("never limit these passes to the uncommitted late diff");
	});

	test("owns one summary and excludes only run mutations", () => {
		expect(SKILL_TEXT).toContain("Exclude only the exact content or state transition");
		expect(SKILL_TEXT).toContain("Create it once, update that same comment");
		expect(SKILL_TEXT).not.toContain("Leave newly arrived or changed feedback");
		expect(SKILL_TEXT).not.toContain("Do not resolve deferred, ambiguous, newly arrived");
		expect(SKILL_TEXT).not.toContain("out-of-snapshot");
	});

	test("state-only reopen re-enters the audit", () => {
		expect(SKILL_TEXT).toContain("`isResolved` and `isOutdated` state");
		expect(SKILL_TEXT).toContain(
			"state-only transition back to unresolved and non-outdated re-enters the thread",
		);
		expect(SKILL_TEXT).toContain("makes it resolution-eligible");
		expect(SKILL_TEXT).toContain(
			"such as this run's own resolution or a thread made outdated by its verified push",
		);
		expect(SKILL_TEXT).toContain("Any later external edit or state-only reopen is a new delta");
	});

	test("pre-edit revalidation uses the shared wave budget", () => {
		expect(SKILL_TEXT).toContain(
			"Every later complete fetch uses this budget, including the post-plan revalidation",
		);
		expect(SKILL_TEXT).toContain("there is no separate or recursive pre-edit allowance");
		expect(SKILL_TEXT).toContain("consume one wave, audit that delta once");
		expect(SKILL_TEXT).toContain("do not recursively restart pre-edit revalidation");
	});

	test("one reply is updated after a late commit", () => {
		expect(SKILL_TEXT).toContain("upsert exactly one run-owned disposition reply");
		expect(SKILL_TEXT).toContain("feedback-item-to-reply mapping");
		expect(SKILL_TEXT).toContain("update the existing run-owned reply in place");
		expect(SKILL_TEXT).toContain("Never add a duplicate disposition reply");
		expect(SKILL_TEXT).toContain("pulls/comments/REPLY_COMMENT_DATABASE_ID");
		expect(SKILL_TEXT).toContain(
			"If a late commit changes commit or check evidence, update that existing summary in place",
		);
	});

	test("every fetch guards against external head movement", () => {
		expect(SKILL_TEXT).toContain(
			"For every convergence and final-handoff fetch, obtain PR metadata and `headRefOid`",
		);
		expect(SKILL_TEXT).toContain("Require `headRefOid` to equal the expected run-owned head");
		expect(SKILL_TEXT).toContain(
			"Unexpected external head movement stops further GitHub mutations immediately",
		);
		expect(SKILL_TEXT).toContain("do not push, reply, or resolve against stale code");
		expect(SKILL_TEXT).toContain("update that expectation to the verified pushed commit");
	});
});
