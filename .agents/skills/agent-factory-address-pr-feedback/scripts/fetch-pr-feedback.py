#!/usr/bin/env python3
"""Fetch complete, thread-aware feedback for one GitHub pull request."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Iterator
from typing import Any

JsonObject = dict[str, Any]

PR_QUERY = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      number
      url
      title
      state
      isDraft
      baseRefName
      headRefName
      headRefOid
      isCrossRepository
      maintainerCanModify
      headRepository {
        nameWithOwner
        url
        sshUrl
        viewerPermission
      }
      author { login }
    }
  }
}
"""

CONVERSATION_COMMENTS_QUERY = """
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          databaseId
          url
          body
          createdAt
          updatedAt
          author { login }
        }
      }
    }
  }
}
"""

REVIEWS_QUERY = """
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          databaseId
          state
          body
          submittedAt
          author { login }
          commit { oid }
        }
      }
    }
  }
}
"""

REVIEW_THREADS_QUERY = """
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          startLine
          startDiffSide
          originalLine
          originalStartLine
          resolvedBy { login }
        }
      }
    }
  }
}
"""

THREAD_COMMENTS_QUERY = """
query($thread: ID!, $cursor: String) {
  node(id: $thread) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          databaseId
          url
          body
          createdAt
          updatedAt
          author { login }
          replyTo { id databaseId }
          pullRequestReview { id state }
        }
      }
    }
  }
}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch PR comments, reviews, and complete inline review threads."
    )
    parser.add_argument("--repo", required=True, metavar="OWNER/REPO")
    parser.add_argument("--pr", required=True, type=int, metavar="NUMBER")
    return parser.parse_args()


def run(command: list[str], *, stdin: str | None = None) -> str:
    completed = subprocess.run(
        command,
        input=stdin,
        capture_output=True,
        check=False,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"Command failed: {' '.join(command)}\n{detail}")
    return completed.stdout


def graphql(query: str, variables: JsonObject) -> JsonObject:
    command = ["gh", "api", "graphql", "-F", "query=@-"]
    for name, value in variables.items():
        if value is None:
            continue
        command.extend(["-F", f"{name}={value}"])

    raw = run(command, stdin=query)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"GitHub returned invalid JSON: {error}") from error

    errors = payload.get("errors")
    if errors:
        raise RuntimeError(f"GitHub GraphQL errors:\n{json.dumps(errors, indent=2)}")
    return payload


def connection_pages(
    query: str,
    variables: JsonObject,
    connection_path: tuple[str, ...],
) -> Iterator[list[JsonObject]]:
    cursor: str | None = None
    while True:
        payload = graphql(query, {**variables, "cursor": cursor})
        connection: JsonObject = payload["data"]
        for part in connection_path:
            connection = connection[part]

        yield connection.get("nodes") or []
        page_info = connection["pageInfo"]
        if not page_info["hasNextPage"]:
            return
        cursor = page_info["endCursor"]


def fetch_connection(
    query: str,
    variables: JsonObject,
    connection_path: tuple[str, ...],
) -> list[JsonObject]:
    return [
        node
        for page in connection_pages(query, variables, connection_path)
        for node in page
    ]


def fetch_thread_comments(thread_id: str) -> list[JsonObject]:
    return fetch_connection(
        THREAD_COMMENTS_QUERY,
        {"thread": thread_id},
        ("node", "comments"),
    )


def select_thread_root_comment(comments: list[JsonObject]) -> JsonObject:
    try:
        root_comments = [comment for comment in comments if comment["replyTo"] is None]
    except KeyError as error:
        raise RuntimeError("GitHub response omitted a review comment's replyTo field") from error

    if len(root_comments) != 1:
        raise RuntimeError(
            "Expected exactly one top-level review comment in a thread, "
            f"found {len(root_comments)}"
        )
    return root_comments[0]


def split_repo(value: str) -> tuple[str, str]:
    parts = value.strip().split("/")
    if len(parts) != 2 or not all(parts):
        raise ValueError("--repo must use the OWNER/REPO format")
    return parts[0], parts[1]


def ensure_authenticated() -> None:
    try:
        run(["gh", "auth", "status"])
    except RuntimeError as error:
        raise RuntimeError("GitHub CLI authentication failed; run `gh auth login`") from error


def fetch_feedback(owner: str, repo: str, number: int) -> JsonObject:
    variables = {"owner": owner, "repo": repo, "number": number}
    pr_payload = graphql(PR_QUERY, variables)
    pull_request = pr_payload["data"]["repository"]["pullRequest"]
    if pull_request is None:
        raise RuntimeError(f"Pull request {owner}/{repo}#{number} was not found")

    conversation_comments = fetch_connection(
        CONVERSATION_COMMENTS_QUERY,
        variables,
        ("repository", "pullRequest", "comments"),
    )
    reviews = fetch_connection(
        REVIEWS_QUERY,
        variables,
        ("repository", "pullRequest", "reviews"),
    )
    review_threads = fetch_connection(
        REVIEW_THREADS_QUERY,
        variables,
        ("repository", "pullRequest", "reviewThreads"),
    )
    for thread in review_threads:
        comments = fetch_thread_comments(thread["id"])
        thread["rootComment"] = select_thread_root_comment(comments)
        thread["comments"] = comments

    return {
        "pull_request": pull_request,
        "conversation_comments": conversation_comments,
        "reviews": reviews,
        "review_threads": review_threads,
    }


def main() -> int:
    args = parse_args()
    try:
        owner, repo = split_repo(args.repo)
        ensure_authenticated()
        result = fetch_feedback(owner, repo, args.pr)
    except (KeyError, TypeError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
