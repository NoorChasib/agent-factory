import { z } from "zod";
import {
  githubCheckName,
  gitObjectId,
  looseBranch,
  looseGithubLogin,
  looseLabelName,
} from "../contracts/primitives";
import type { ProjectProfile } from "../contracts/project-profile";
import { type GitHubProjectObservation, GitHubProjectObservationSchema } from "../controller/model";
import type { GitHubApiClient, GitHubReadResult } from "./client";

const labelConnection = z.strictObject({
  totalCount: z.number().int().nonnegative(),
  nodes: z.array(z.strictObject({ name: looseLabelName })),
});

const pageInfo = z.strictObject({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

const issueNode = z.strictObject({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED"]),
  labels: labelConnection,
});

const reviewNode = z.strictObject({
  author: z.strictObject({ login: looseGithubLogin }).nullable(),
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
  commit: z.strictObject({ oid: gitObjectId }).nullable(),
});

const checkRunNode = z.strictObject({
  __typename: z.literal("CheckRun"),
  name: githubCheckName,
  status: z.enum(["QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "REQUESTED", "PENDING"]),
  conclusion: z
    .enum([
      "ACTION_REQUIRED",
      "CANCELLED",
      "FAILURE",
      "NEUTRAL",
      "SKIPPED",
      "STALE",
      "STARTUP_FAILURE",
      "SUCCESS",
      "TIMED_OUT",
    ])
    .nullable(),
  app: z.strictObject({ slug: looseGithubLogin }).nullable(),
});

const statusContextNode = z.strictObject({
  __typename: z.literal("StatusContext"),
  context: githubCheckName,
  state: z.enum(["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"]),
});

const pullRequestNode = z.strictObject({
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefName: looseBranch,
  headRefOid: gitObjectId,
  updatedAt: z.iso.datetime({ offset: true }),
  mergedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  labels: labelConnection,
  closingIssuesReferences: z.strictObject({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(z.strictObject({ number: z.number().int().positive() })),
  }),
  comments: z.strictObject({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(z.strictObject({ updatedAt: z.iso.datetime({ offset: true }) })),
  }),
  reviews: z.strictObject({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(reviewNode),
  }),
  reviewThreads: z.strictObject({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(
      z.strictObject({
        isResolved: z.boolean(),
        isOutdated: z.boolean(),
      }),
    ),
  }),
  commits: z.strictObject({
    nodes: z
      .array(
        z.strictObject({
          commit: z.strictObject({
            oid: gitObjectId,
            statusCheckRollup: z
              .strictObject({
                contexts: z.strictObject({
                  totalCount: z.number().int().nonnegative(),
                  nodes: z.array(
                    z.discriminatedUnion("__typename", [checkRunNode, statusContextNode]),
                  ),
                }),
              })
              .nullable(),
          }),
        }),
      )
      .max(1),
  }),
});

const branchProtectionNode = z.strictObject({
  pattern: z.string().min(1).max(255),
  requiredStatusCheckContexts: z.array(githubCheckName),
});

export const GitHubObservationResponseSchema = z.strictObject({
  data: z.strictObject({
    repository: z
      .strictObject({
        issues: z.strictObject({ nodes: z.array(issueNode), pageInfo }),
        pullRequests: z.strictObject({ nodes: z.array(pullRequestNode), pageInfo }),
        branchProtectionRules: z.strictObject({
          nodes: z.array(branchProtectionNode),
          pageInfo,
        }),
      })
      .nullable(),
  }),
});

export type GitHubObservationResponse = z.infer<typeof GitHubObservationResponseSchema>;
type GitHubRepositoryResponse = NonNullable<GitHubObservationResponse["data"]["repository"]>;
export type GitHubReviewState = z.infer<typeof reviewNode>["state"];
export type GitHubCheckConclusion = NonNullable<z.infer<typeof checkRunNode>["conclusion"]>;

export interface GitHubReviewSnapshot {
  readonly login: string;
  readonly state: GitHubReviewState;
  readonly submittedAt: string | null;
  readonly headSha: string | null;
}

export interface GitHubCheckSnapshot {
  readonly name: string;
  readonly appSlug: string | null;
  readonly status: "queued" | "in-progress" | "completed";
  readonly conclusion:
    | GitHubCheckConclusion
    | "ERROR"
    | "EXPECTED"
    | "FAILURE"
    | "PENDING"
    | "SUCCESS"
    | null;
  readonly headSha: string;
}

export interface GitHubPullRequestSnapshot {
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly linkedIssueNumber: number | null;
  readonly branch: string;
  readonly headSha: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly mergeability: "mergeable" | "conflicting" | "unknown";
  readonly reviewDecision: "approved" | "changes-requested" | "review-required" | null;
  readonly commentCount: number;
  readonly latestCommentAt: string | null;
  readonly reviews: readonly GitHubReviewSnapshot[];
  readonly unresolvedThreads: number;
  readonly checks: readonly GitHubCheckSnapshot[];
}

export interface GitHubIssueSnapshot {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly branch: string | null;
  readonly worktreeId: string | null;
  readonly pullRequestNumber: number | null;
}

export interface GitHubProjectSnapshot {
  readonly projectId: string;
  readonly repository: string;
  readonly issues: readonly GitHubIssueSnapshot[];
  readonly pullRequests: readonly GitHubPullRequestSnapshot[];
  readonly requiredCheckNames: readonly string[];
}

export interface GitHubObservationAssociations {
  readonly worktreeIds?: Readonly<Record<string, string>>;
}

export const GITHUB_OBSERVATION_QUERY = `
  query AgentFactoryObservation(
    $owner: String!
    $name: String!
    $issueCursor: String
    $pullRequestCursor: String
    $protectionCursor: String
  ) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $issueCursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes { number state labels(first: 100) { totalCount nodes { name } } }
        pageInfo { hasNextPage endCursor }
      }
      pullRequests(
        first: 100
        after: $pullRequestCursor
        orderBy: {field: CREATED_AT, direction: ASC}
      ) {
        nodes {
          number state isDraft headRefName headRefOid updatedAt mergedAt mergeable reviewDecision
          labels(first: 100) { totalCount nodes { name } }
          closingIssuesReferences(first: 10) { totalCount nodes { number } }
          comments(last: 100) { totalCount nodes { updatedAt } }
          reviews(last: 100) {
            totalCount
            nodes { author { login } state submittedAt commit { oid } }
          }
          reviewThreads(first: 100) { totalCount nodes { isResolved isOutdated } }
          commits(last: 1) {
            nodes {
              commit {
                oid
                statusCheckRollup {
                  contexts(first: 100) {
                    totalCount
                    nodes {
                      __typename
                      ... on CheckRun { name status conclusion app { slug } }
                      ... on StatusContext { context state }
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
      branchProtectionRules(first: 100, after: $protectionCursor) {
        nodes { pattern requiredStatusCheckContexts }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

const PULL_REQUEST_STATES = { OPEN: "open", CLOSED: "closed", MERGED: "merged" } as const;

const MERGEABILITY = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
} as const;

const REVIEW_DECISIONS = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
} as const;

function labels(connection: z.infer<typeof labelConnection>): readonly string[] {
  if (connection.totalCount !== connection.nodes.length) {
    throw new Error("GitHub label connection exceeded its validated observation bound");
  }
  return connection.nodes.map((label) => label.name).sort(compareText);
}

function latest(values: readonly string[]): string | null {
  return [...values].sort(compareText).at(-1) ?? null;
}

function mapCheckStatus(
  status: z.infer<typeof checkRunNode>["status"],
): GitHubCheckSnapshot["status"] {
  if (status === "COMPLETED") {
    return "completed";
  }
  if (status === "IN_PROGRESS") {
    return "in-progress";
  }
  return "queued";
}

function linkedIssue(node: z.infer<typeof pullRequestNode>): number | null {
  if (node.closingIssuesReferences.totalCount !== node.closingIssuesReferences.nodes.length) {
    throw new Error(
      `pull request ${node.number} closing-issue references exceeded the observation bound`,
    );
  }
  const issueNumbers = [
    ...new Set(node.closingIssuesReferences.nodes.map((issue) => issue.number)),
  ];
  if (issueNumbers.length > 1) {
    throw new Error(
      `pull request ${node.number} has ambiguous closing-issue references: ${issueNumbers.sort((a, b) => a - b).join(", ")}`,
    );
  }
  return issueNumbers[0] ?? null;
}

function mapPullRequest(node: z.infer<typeof pullRequestNode>): GitHubPullRequestSnapshot {
  if (node.reviews.totalCount !== node.reviews.nodes.length) {
    throw new Error(`pull request ${node.number} reviews exceeded the observation bound`);
  }
  if (node.reviewThreads.totalCount !== node.reviewThreads.nodes.length) {
    throw new Error(`pull request ${node.number} review threads exceeded the observation bound`);
  }
  const commit = node.commits.nodes[0]?.commit;
  if (commit !== undefined && commit.oid !== node.headRefOid) {
    throw new Error(`pull request ${node.number} latest commit does not match its head`);
  }
  const checkConnection = commit?.statusCheckRollup?.contexts;
  if (
    checkConnection !== undefined &&
    checkConnection !== null &&
    checkConnection.totalCount !== checkConnection.nodes.length
  ) {
    throw new Error(`pull request ${node.number} checks exceeded the observation bound`);
  }
  const checks = (checkConnection?.nodes ?? []).map(
    (check): GitHubCheckSnapshot =>
      check.__typename === "CheckRun"
        ? {
            name: check.name,
            appSlug: check.app?.slug ?? null,
            status: mapCheckStatus(check.status),
            conclusion: check.conclusion,
            headSha: node.headRefOid,
          }
        : {
            name: check.context,
            appSlug: null,
            status:
              check.state === "PENDING" || check.state === "EXPECTED" ? "queued" : "completed",
            conclusion: check.state,
            headSha: node.headRefOid,
          },
  );

  return {
    number: node.number,
    state: PULL_REQUEST_STATES[node.state],
    draft: node.isDraft,
    labels: labels(node.labels),
    linkedIssueNumber: linkedIssue(node),
    branch: node.headRefName,
    headSha: node.headRefOid,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt,
    mergeability: MERGEABILITY[node.mergeable],
    reviewDecision: node.reviewDecision === null ? null : REVIEW_DECISIONS[node.reviewDecision],
    commentCount: node.comments.totalCount,
    latestCommentAt: latest(node.comments.nodes.map((comment) => comment.updatedAt)),
    reviews: node.reviews.nodes
      .flatMap((review): GitHubReviewSnapshot[] =>
        review.author === null
          ? []
          : [
              {
                login: review.author.login,
                state: review.state,
                submittedAt: review.submittedAt,
                headSha: review.commit?.oid ?? null,
              },
            ],
      )
      .sort((left, right) =>
        compareText(
          `${left.login}\u0000${left.submittedAt ?? ""}`,
          `${right.login}\u0000${right.submittedAt ?? ""}`,
        ),
      ),
    unresolvedThreads: node.reviewThreads.nodes.filter(
      (thread) => !thread.isResolved && !thread.isOutdated,
    ).length,
    checks: checks.sort((left, right) =>
      compareText(
        `${left.appSlug ?? ""}\u0000${left.name}`,
        `${right.appSlug ?? ""}\u0000${right.name}`,
      ),
    ),
  };
}

export function mapGitHubObservation(
  profile: ProjectProfile,
  input: unknown,
  associations: GitHubObservationAssociations = {},
): GitHubProjectSnapshot {
  const parsed = GitHubObservationResponseSchema.parse(input);
  const repository = parsed.data.repository;
  if (repository === null) {
    throw new Error(`GitHub repository '${profile.repository}' is unavailable`);
  }

  const pullRequests = repository.pullRequests.nodes.map(mapPullRequest);
  const pullRequestByIssue = new Map<number, GitHubPullRequestSnapshot>();
  for (const pullRequest of pullRequests) {
    if (pullRequest.linkedIssueNumber === null) {
      continue;
    }
    if (pullRequestByIssue.has(pullRequest.linkedIssueNumber)) {
      throw new Error(
        `issue ${pullRequest.linkedIssueNumber} is linked to more than one pull request`,
      );
    }
    pullRequestByIssue.set(pullRequest.linkedIssueNumber, pullRequest);
  }

  const defaultProtection = repository.branchProtectionRules.nodes.find(
    (rule) => rule.pattern === profile.defaultBranch,
  );
  return {
    projectId: profile.id,
    repository: profile.repository,
    issues: repository.issues.nodes
      .map((issue): GitHubIssueSnapshot => {
        const pullRequest = pullRequestByIssue.get(issue.number);
        return {
          number: issue.number,
          state: issue.state === "OPEN" ? "open" : "closed",
          labels: labels(issue.labels),
          branch: pullRequest?.branch ?? null,
          worktreeId: associations.worktreeIds?.[`${profile.id}:${issue.number}`] ?? null,
          pullRequestNumber: pullRequest?.number ?? null,
        };
      })
      .sort((left, right) => left.number - right.number),
    pullRequests: pullRequests.sort((left, right) => left.number - right.number),
    requiredCheckNames: [...(defaultProtection?.requiredStatusCheckContexts ?? [])].sort(
      compareText,
    ),
  };
}

export function toControllerObservation(snapshot: GitHubProjectSnapshot): GitHubProjectObservation {
  return GitHubProjectObservationSchema.parse({
    projectId: snapshot.projectId,
    issues: snapshot.issues.map((issue) => ({
      number: issue.number,
      state: issue.state,
      labels: issue.labels,
      branch: issue.branch,
      worktreeId: issue.worktreeId,
      pullRequestNumber: issue.pullRequestNumber,
    })),
    pullRequests: snapshot.pullRequests.map((pullRequest) => ({
      number: pullRequest.number,
      state: pullRequest.state,
      labels: pullRequest.labels,
      linkedIssueNumber: pullRequest.linkedIssueNumber,
      branch: pullRequest.branch,
      headSha: pullRequest.headSha,
      mergedAt: pullRequest.mergedAt,
    })),
  });
}

export async function readGitHubObservation(
  client: GitHubApiClient,
  profile: ProjectProfile,
  token: string,
  conditional = true,
  associations: GitHubObservationAssociations = {},
): Promise<GitHubReadResult<GitHubProjectSnapshot>> {
  const [owner, name] = profile.repository.split("/");
  if (owner === undefined || name === undefined) {
    throw new Error(`invalid repository '${profile.repository}'`);
  }
  const issueNodes: z.infer<typeof issueNode>[] = [];
  const pullRequestNodes: z.infer<typeof pullRequestNode>[] = [];
  const protectionNodes: z.infer<typeof branchProtectionNode>[] = [];
  let issueCursor: string | null = null;
  let pullRequestCursor: string | null = null;
  let protectionCursor: string | null = null;
  let changed = false;
  let etag: string | null = null;
  let page = 1;
  let hasNextPage = true;
  while (hasNextPage) {
    if (page > 100) {
      throw new Error(`GitHub observation for '${profile.id}' exceeded 100 pages`);
    }
    const result: GitHubReadResult<GitHubObservationResponse> = await client.readGraphql({
      projectId: profile.id,
      cacheKey: `${profile.id}:observation:${page}`,
      token,
      query: GITHUB_OBSERVATION_QUERY,
      variables: {
        owner,
        name,
        issueCursor,
        pullRequestCursor,
        protectionCursor,
      },
      schema: GitHubObservationResponseSchema,
      conditional,
    });
    const repository: GitHubRepositoryResponse | null = result.value.data.repository;
    if (repository === null) {
      throw new Error(`GitHub repository '${profile.repository}' is unavailable`);
    }
    issueNodes.push(...repository.issues.nodes);
    pullRequestNodes.push(...repository.pullRequests.nodes);
    protectionNodes.push(...repository.branchProtectionRules.nodes);
    changed ||= result.changed;
    etag ??= result.etag;

    for (const connection of [
      repository.issues.pageInfo,
      repository.pullRequests.pageInfo,
      repository.branchProtectionRules.pageInfo,
    ]) {
      if (connection.hasNextPage && connection.endCursor === null) {
        throw new Error("GitHub pagination reported another page without a cursor");
      }
    }
    issueCursor = repository.issues.pageInfo.endCursor ?? issueCursor;
    pullRequestCursor = repository.pullRequests.pageInfo.endCursor ?? pullRequestCursor;
    protectionCursor = repository.branchProtectionRules.pageInfo.endCursor ?? protectionCursor;
    hasNextPage =
      repository.issues.pageInfo.hasNextPage ||
      repository.pullRequests.pageInfo.hasNextPage ||
      repository.branchProtectionRules.pageInfo.hasNextPage;
    page += 1;
  }
  const combined = GitHubObservationResponseSchema.parse({
    data: {
      repository: {
        issues: {
          nodes: [...new Map(issueNodes.map((node) => [node.number, node])).values()],
          pageInfo: { hasNextPage: false, endCursor: issueCursor },
        },
        pullRequests: {
          nodes: [...new Map(pullRequestNodes.map((node) => [node.number, node])).values()],
          pageInfo: { hasNextPage: false, endCursor: pullRequestCursor },
        },
        branchProtectionRules: {
          nodes: [...new Map(protectionNodes.map((node) => [node.pattern, node])).values()],
          pageInfo: { hasNextPage: false, endCursor: protectionCursor },
        },
      },
    },
  });
  return {
    value: mapGitHubObservation(profile, combined, associations),
    changed,
    etag,
    status: changed ? 200 : 304,
  };
}
