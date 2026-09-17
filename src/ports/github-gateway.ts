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

export interface PullRequestReviewComment {
  readonly author: string;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly state?: string;
  readonly createdAt?: string;
}

export interface GitHubIssueData {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state?: string; // 'OPEN' | 'CLOSED'
  readonly labels: readonly string[];
  readonly comments: readonly GitHubComment[];
  readonly error?: string;
}

export interface GitHubPullRequestData {
  readonly number: number;
  readonly title: string;
  readonly state: string; // 'OPEN' | 'MERGED' | 'CLOSED'
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly url: string;
  readonly merged: boolean;
  readonly labels: readonly string[];
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
