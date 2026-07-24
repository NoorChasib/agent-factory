from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import ModuleType


def load_fetcher() -> ModuleType:
    script_path = (
        Path(__file__).resolve().parents[1] / "scripts" / "fetch-pr-feedback.py"
    )
    spec = importlib.util.spec_from_file_location("fetch_pr_feedback", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load fetcher module from {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FETCHER = load_fetcher()


class SelectThreadRootCommentTests(unittest.TestCase):
    def test_selects_the_only_comment_without_a_parent(self) -> None:
        root = {"databaseId": 101, "replyTo": None}
        reply = {"databaseId": 102, "replyTo": {"databaseId": 101}}

        selected = FETCHER.select_thread_root_comment([root, reply])

        self.assertIs(selected, root)

    def test_rejects_a_thread_without_a_root(self) -> None:
        comments = [{"databaseId": 102, "replyTo": {"databaseId": 101}}]

        with self.assertRaisesRegex(RuntimeError, "found 0"):
            FETCHER.select_thread_root_comment(comments)

    def test_rejects_multiple_roots(self) -> None:
        comments = [
            {"databaseId": 101, "replyTo": None},
            {"databaseId": 102, "replyTo": None},
        ]

        with self.assertRaisesRegex(RuntimeError, "found 2"):
            FETCHER.select_thread_root_comment(comments)

    def test_rejects_a_response_without_reply_relationships(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "omitted.*replyTo"):
            FETCHER.select_thread_root_comment([{"databaseId": 101}])


if __name__ == "__main__":
    unittest.main()
