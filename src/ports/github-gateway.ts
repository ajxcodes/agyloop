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
