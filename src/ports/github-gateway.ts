/**
 * agyloop - GitHubGateway Port Interface
 *
 * Inversion of control interface for discovering repository and issue context via GitHub CLI.
 */

export interface GitHubComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt?: string;
}

import {
  PR_CATEGORY_ERROR,
  PR_CATEGORY_SUGGESTION,
  PR_CATEGORY_QUESTION,
  PR_CATEGORY_GENERAL
} from '../domain';

/**
 * The categories a PR review comment can be classified into. The values live in
 * the domain so the classifier and the port contract cannot drift apart.
 */
export type PRCommentCategory =
  | typeof PR_CATEGORY_ERROR
  | typeof PR_CATEGORY_SUGGESTION
  | typeof PR_CATEGORY_QUESTION
  | typeof PR_CATEGORY_GENERAL;

/**
 * The GitHub surface a PR comment was fetched from.
 *
 * - `conversation`: a PR conversation comment (`issues/{n}/comments`)
 * - `review`: a submitted PR review body (`pulls/{n}/reviews`)
 * - `inline`: an inline diff review comment (`pulls/{n}/comments`)
 */
export type PRCommentSurface = 'conversation' | 'review' | 'inline';

export interface PullRequestReviewComment {
  /**
   * REST database id. GitHub assigns every comment row its own database id, so
   * the ids observed in the wild do not overlap across surfaces — but the API
   * does not document that guarantee, so an id is only ever used within its own
   * surface: inline ids are matched against review threads, conversation ids
   * identify the comment a dismissal reply answers.
   */
  readonly id?: number;
  /**
   * Which GitHub surface the comment came from. Absent means `inline`, the
   * historical meaning of `id`.
   */
  readonly surface?: PRCommentSurface;
  readonly author: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly state?: string;
  readonly createdAt?: string;
  readonly category?: PRCommentCategory;
  readonly severity?: string;
}

export interface UnresolvedReviewThread {
  readonly id: string;
  readonly commentIds: readonly number[];
}

export interface GitHubIssueMilestone {
  readonly title: string;
}

export interface GitHubIssueData {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state?: string; // 'OPEN' | 'CLOSED'
  readonly labels: readonly string[];
  readonly comments: readonly GitHubComment[];
  readonly milestone?: GitHubIssueMilestone;
  readonly error?: string;
}

export interface GitHubPullRequestData {
  readonly number: number;
  readonly title: string;
  /** PR description; the only place a GitHub closing keyword (`Closes #n`) is asserted. */
  readonly body?: string;
  readonly state: string; // 'OPEN' | 'MERGED' | 'CLOSED'
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly url: string;
  readonly merged: boolean;
  readonly labels: readonly string[];
  readonly mergeStateStatus?: string;
  readonly mergeable?: string;
}

export interface GitHubGatewayOptions {
  readonly repo?: string;
  readonly cwd?: string;
}

export interface FindPullRequestOptions extends GitHubGatewayOptions {
  readonly issueNumber?: number | string;
  readonly headBranch?: string;
  readonly baseBranch?: string;
  readonly state?: string;
}

export interface CreatePullRequestOptions extends GitHubGatewayOptions {
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly labels?: readonly string[];
  readonly draft?: boolean;
}

export interface GitHubGateway {
  /**
   * Resolves the active GitHub repository slug ('owner/repo') from git remotes or manifest.
   */
  getCurrentRepo(cwd?: string): Promise<string | null> | string | null;

  /**
   * Fetches structured issue details from GitHub.
   */
  fetchIssue(
    issueNumber: number,
    options?: GitHubGatewayOptions
  ): Promise<GitHubIssueData | null> | GitHubIssueData | null;

  /**
   * Searches for a pull request by head branch or associated issue number.
   */
  findPullRequest?(
    options: FindPullRequestOptions
  ): Promise<GitHubPullRequestData | null> | GitHubPullRequestData | null;

  /**
   * Opens a pull request on GitHub via gh CLI.
   */
  createPullRequest?(
    options: CreatePullRequestOptions
  ): Promise<GitHubPullRequestData> | GitHubPullRequestData;

  /**
   * Applies labels to an issue or pull request.
   */
  applyLabels?(
    targetNumber: number,
    labels: readonly string[],
    options?: GitHubGatewayOptions
  ): Promise<void> | void;

  /**
   * Posts a comment on an issue or pull request.
   */
  commentOnIssue?(
    issueNumber: number,
    comment: string,
    options?: GitHubGatewayOptions
  ): Promise<void> | void;

  /**
   * Closes an issue on GitHub.
   */
  closeIssue?(
    issueNumber: number,
    options?: GitHubGatewayOptions
  ): Promise<void> | void;

  /**
   * Fetches review comments and reviews for a pull request.
   */
  fetchPullRequestComments?(
    prNumber: number,
    options?: GitHubGatewayOptions
  ): Promise<PullRequestReviewComment[]> | PullRequestReviewComment[];

  /**
   * Lists unresolved review threads on a pull request, with the database ids
   * of the comments each thread contains.
   */
  listUnresolvedReviewThreads?(
    prNumber: number,
    options?: GitHubGatewayOptions
  ): Promise<UnresolvedReviewThread[]> | UnresolvedReviewThread[];

  /**
   * Posts a reply on a review thread (by GraphQL node ID).
   */
  replyToThread?(
    threadId: string,
    body: string,
    options?: GitHubGatewayOptions
  ): Promise<void> | void;

  /**
   * Resolves a review thread via GraphQL `resolveReviewThread`.
   */
  resolveReviewThread?(
    threadId: string,
    options?: GitHubGatewayOptions
  ): Promise<void> | void;

  /**
   * Posts a reply on the PR conversation surface, answering one conversation
   * comment. GitHub has no "resolve" affordance for conversation comments, so
   * a dismissal answers them with a comment instead.
   */
  replyToConversationComment?(
    prNumber: number,
    commentId: number,
    body: string,
    options?: GitHubGatewayOptions
  ): Promise<void> | void;
}

/**
 * Pure formatting function to transform structured GitHub issue data into markdown prompt context.
 */
export function formatIssueForPrompt(issueData: GitHubIssueData | null): string {
  if (!issueData) return '';
  if (issueData.error) {
    return `### Associated GitHub Issue: #${issueData.number} (Repository: ${issueData.repo})\n*(Warning: Unable to fetch live issue details: ${issueData.error})*\n`;
  }

  const labelBadge = issueData.labels.length > 0 ? issueData.labels.join(', ') : 'None';
  let formatted = `### Active Issue: #${issueData.number} - ${issueData.title}\n`;
  formatted += `- **Repository:** \`${issueData.repo}\`\n`;
  formatted += `- **Labels:** ${labelBadge}\n\n`;
  formatted += `#### Description:\n${issueData.body || '*(No description provided)*'}\n`;

  if (issueData.comments && issueData.comments.length > 0) {
    formatted += `\n#### Discussion & Comments (${issueData.comments.length}):\n`;
    issueData.comments.forEach((c) => {
      formatted += `> **@${c.author}** (${c.createdAt || 'recent'}):\n`;
      const quotedBody = (c.body || '').split('\n').map((line) => `> ${line}`).join('\n');
      formatted += `${quotedBody}\n\n`;
    });
  }

  return formatted.trim();
}
