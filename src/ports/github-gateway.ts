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

export interface GitHubIssueData {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly GitHubComment[];
  readonly error?: string;
}

export interface GitHubGatewayOptions {
  readonly repo?: string;
  readonly cwd?: string;
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
}
