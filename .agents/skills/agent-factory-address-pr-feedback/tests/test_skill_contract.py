"""Protect the delegated PR-feedback workflow contract from silent regression."""

from __future__ import annotations

import unittest
from pathlib import Path


SKILL_TEXT = " ".join(
    (Path(__file__).resolve().parents[1] / "SKILL.md")
    .read_text(encoding="utf-8")
    .split()
)


class DelegationContractTests(unittest.TestCase):
    def test_requires_every_independent_role(self) -> None:
        required_contracts = (
            "read-only audit subagent",
            "scoped fix subagent",
            "repair subagent",
            "Standards reviewer",
            "Spec reviewer",
            "behavior-preserving simplification",
            "independent orchestrator acceptance",
        )

        for contract in required_contracts:
            with self.subTest(contract=contract):
                self.assertIn(contract, SKILL_TEXT)

    def test_orders_acceptance_before_remote_mutations(self) -> None:
        headings = (
            "## 2. Delegate the read-only feedback audit",
            "## 3. Revalidate and delegate scoped fixes",
            "## 4. Review, repair, and simplify on a stable tree",
            "## 5. Perform independent orchestrator acceptance",
            "## 6. Create and push commits without rewriting history",
            "## 7. Converge, reply, and resolve",
        )
        positions = [SKILL_TEXT.index(heading) for heading in headings]
        self.assertEqual(sorted(positions), positions)

    def test_requires_stable_tree_rechecks_after_material_changes(self) -> None:
        self.assertIn("against that same tree", SKILL_TEXT)
        self.assertIn("repeat both fresh independent reviews", SKILL_TEXT)
        self.assertIn("Never prime a repeated reviewer", SKILL_TEXT)

    def test_preserves_commit_and_audited_thread_boundaries(self) -> None:
        self.assertIn("Create exactly one additional commit", SKILL_TEXT)
        self.assertIn("Do not resolve deferred, ambiguous, unaudited", SKILL_TEXT)
        self.assertIn("rootComment", SKILL_TEXT)

    def test_never_rewrites_history(self) -> None:
        self.assertIn("Never merge, force-push, rebase, or amend any commit", SKILL_TEXT)
        self.assertIn(
            "every correction is a new ordinary commit pushed without force", SKILL_TEXT
        )
        self.assertIn(
            "Never amend, rebase, or force-push any commit — including commits this workflow "
            "created",
            SKILL_TEXT,
        )
        self.assertNotIn("--force-with-lease", SKILL_TEXT)

    def test_converges_on_feedback_arriving_during_the_run(self) -> None:
        required_contracts = (
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
        )

        for contract in required_contracts:
            with self.subTest(contract=contract):
                self.assertIn(contract, SKILL_TEXT)

    def test_bounds_convergence_and_late_round_commits(self) -> None:
        self.assertIn("If a fourth external-feedback wave appears", SKILL_TEXT)
        self.assertIn("leave only that excess delta untouched", SKILL_TEXT)
        self.assertIn("report its exact thread, review, or comment IDs", SKILL_TEXT)
        self.assertIn(
            "If a late round changes tracked files after a run-owned commit was already pushed",
            SKILL_TEXT,
        )
        self.assertIn(
            "section 6's remote-head revalidation and non-force push path", SKILL_TEXT
        )
        self.assertIn("never rewrite pushed history", SKILL_TEXT)

    def test_waits_for_late_push_checks_before_mutating_feedback(self) -> None:
        check_gate = (
            "For every late delta that requires a pushed commit, wait for required GitHub "
            "checks"
        )
        self.assertIn(check_gate, SKILL_TEXT)
        self.assertIn(
            "do not reply to or resolve any item in that delta until those checks succeed",
            SKILL_TEXT,
        )
        self.assertLess(
            SKILL_TEXT.index(check_gate),
            SKILL_TEXT.index("6. After a complete fetch finds no current unaudited delta"),
        )
        self.assertIn("Fetch after each addressed delta", SKILL_TEXT)

    def test_fallow_is_part_of_acceptance_and_convergence(self) -> None:
        required_contracts = (
            "../agent-factory-fallow/SKILL.md",
            "Fallow / changed-code audit",
            "failed Fallow check is actionable even when it posted no comment",
            "Every valid finding enters the same repair path",
            "new Fallow finding or newly failing Fallow check is an external delta",
            "the Fallow check succeeds",
        )

        for contract in required_contracts:
            with self.subTest(contract=contract):
                self.assertIn(contract, SKILL_TEXT)

    def test_audits_top_level_suggestions_regardless_of_confidence(self) -> None:
        self.assertIn(
            "Audit and classify every review body or PR conversation comment that contains a "
            "suggestion or requested change",
            SKILL_TEXT,
        )
        self.assertIn("explicitly including low-confidence items", SKILL_TEXT)
        self.assertIn(
            "purely informational top-level entries may remain inventory-only", SKILL_TEXT
        )

    def test_fingerprints_all_inline_comments_but_bounds_actions(self) -> None:
        self.assertIn("every comment in every inline thread", SKILL_TEXT)
        self.assertIn("comments or edits on resolved or outdated threads", SKILL_TEXT)
        self.assertIn("is reply-eligible and requires its own disposition", SKILL_TEXT)
        self.assertIn(
            "never resolve or re-resolve older feedback solely because of the new item",
            SKILL_TEXT,
        )

    def test_separates_reply_from_thread_resolution_eligibility(self) -> None:
        self.assertIn(
            "Record reply eligibility separately from thread-resolution eligibility",
            SKILL_TEXT,
        )
        self.assertIn(
            "every audited inline item containing a suggestion or requested change is "
            "reply-eligible, regardless of thread state",
            SKILL_TEXT,
        )
        self.assertIn(
            "stays resolution-eligible for this run if the run's accepted fix later makes it "
            "outdated",
            SKILL_TEXT,
        )
        self.assertIn(
            "run-owned disposition reply for every reply-eligible audited inline feedback item",
            SKILL_TEXT,
        )
        self.assertIn(
            "never reopen or re-resolve it solely to dispose of a new or edited item",
            SKILL_TEXT,
        )

    def test_fingerprints_complete_snapshots_against_immediate_baseline(self) -> None:
        self.assertIn(
            "complete fingerprint set for every external feedback item",
            SKILL_TEXT,
        )
        self.assertIn(
            "including resolved, outdated, and purely informational inventory entries",
            SKILL_TEXT,
        )
        self.assertIn(
            "Compare the complete fingerprint set only with the immediately preceding complete "
            "set",
            SKILL_TEXT,
        )
        self.assertIn(
            "Unchanged historical items and exact run-owned mutations do not consume a wave",
            SKILL_TEXT,
        )
        self.assertNotIn("compare those fingerprints with all prior audited rounds", SKILL_TEXT)

    def test_late_reviews_cover_cumulative_change_from_original_head(self) -> None:
        self.assertIn("original pre-workflow audited PR head", SKILL_TEXT)
        self.assertIn(
            "complete cumulative diff from that original head through the current worktree",
            SKILL_TEXT,
        )
        self.assertIn(
            "including committed, staged, unstaged, and pending late-feedback edits",
            SKILL_TEXT,
        )
        self.assertIn(
            "Every review, simplification pass, and acceptance pass must inspect the "
            "complete cumulative change",
            SKILL_TEXT,
        )
        self.assertIn("never limit these passes to the uncommitted late diff", SKILL_TEXT)

    def test_owns_one_summary_and_excludes_only_run_mutations(self) -> None:
        self.assertIn("Exclude only the exact content or state transition", SKILL_TEXT)
        self.assertIn("Create it once, update that same comment", SKILL_TEXT)
        self.assertNotIn("Leave newly arrived or changed feedback", SKILL_TEXT)
        self.assertNotIn("Do not resolve deferred, ambiguous, newly arrived", SKILL_TEXT)
        self.assertNotIn("out-of-snapshot", SKILL_TEXT)

    def test_state_only_reopen_reenters_audit(self) -> None:
        self.assertIn("`isResolved` and `isOutdated` state", SKILL_TEXT)
        self.assertIn(
            "state-only transition back to unresolved and non-outdated re-enters the thread",
            SKILL_TEXT,
        )
        self.assertIn("makes it resolution-eligible", SKILL_TEXT)
        self.assertIn(
            "such as this run's own resolution or a thread made outdated by its verified push",
            SKILL_TEXT,
        )
        self.assertIn("Any later external edit or state-only reopen is a new delta", SKILL_TEXT)

    def test_pre_edit_revalidation_uses_shared_wave_budget(self) -> None:
        self.assertIn(
            "Every later complete fetch uses this budget, including the post-plan revalidation",
            SKILL_TEXT,
        )
        self.assertIn("there is no separate or recursive pre-edit allowance", SKILL_TEXT)
        self.assertIn("consume one wave, audit that delta once", SKILL_TEXT)
        self.assertIn("do not recursively restart pre-edit revalidation", SKILL_TEXT)

    def test_one_reply_is_updated_after_late_commit(self) -> None:
        self.assertIn("upsert exactly one run-owned disposition reply", SKILL_TEXT)
        self.assertIn("feedback-item-to-reply mapping", SKILL_TEXT)
        self.assertIn("update the existing run-owned reply in place", SKILL_TEXT)
        self.assertIn("Never add a duplicate disposition reply", SKILL_TEXT)
        self.assertIn("pulls/comments/REPLY_COMMENT_DATABASE_ID", SKILL_TEXT)
        self.assertIn(
            "If a late commit changes commit or check evidence, update that existing summary "
            "in place",
            SKILL_TEXT,
        )

    def test_every_fetch_guards_against_external_head_movement(self) -> None:
        self.assertIn(
            "For every convergence and final-handoff fetch, obtain PR metadata and `headRefOid`",
            SKILL_TEXT,
        )
        self.assertIn("Require `headRefOid` to equal the expected run-owned head", SKILL_TEXT)
        self.assertIn(
            "Unexpected external head movement stops further GitHub mutations immediately",
            SKILL_TEXT,
        )
        self.assertIn("do not push, reply, or resolve against stale code", SKILL_TEXT)
        self.assertIn("update that expectation to the verified pushed commit", SKILL_TEXT)


if __name__ == "__main__":
    unittest.main()
