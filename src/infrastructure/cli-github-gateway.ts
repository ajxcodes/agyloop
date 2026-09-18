/**
 * agyloop - CliGitHubGateway Infrastructure Adapter
 *
 * Implements GitHubGateway by invoking the GitHub CLI (`gh`).
 * Strictly prefixes all invocations with `env GITHUB_TOKEN=''` to use the authenticated local keyring.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  GitHubGateway,
  GitHubGatewayOptions,
  GitHubIssueData,
  GitHubComment,
  PullRequestReviewComment,
  GitHubPullRequestData,
  FindPullRequestOptions,
  CreatePullRequestOptions,
  formatIssueForPrompt
} from '../ports';
import { GitHubContextError } from '../domain';

export class CliGitHubGateway implements GitHubGateway {
  /**
   * Executes a `gh` command prefixed with `env GITHUB_TOKEN=''`.
   */
  public runGh(commandArgs: string, options: { cwd?: string } = {}): string {
    const cwd = options.cwd || process.cwd();
    const cmd = `env GITHUB_TOKEN='' gh ${commandArgs}`;

    try {
      return execSync(cmd, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GITHUB_TOKEN: ''
        }
      }).trim();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new GitHubContextError(`runGh: ${commandArgs}`, { commandArgs, cwd }, err);
    }
  }

  public getCurrentRepo(cwd: string = process.cwd()): string | null {
    // 1. Try git remote get-url origin
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
      if (match) {
        return `${match[1]}/${match[2]}`;
      }
    } catch {
      // Remote fetch failed, fall through to package.json
    }

    // 2. Try package.json repository field
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const repoUrl =
          typeof pkg.repository === 'string'
            ? pkg.repository
            : pkg.repository && pkg.repository.url;
        if (repoUrl) {
          const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
          if (match) {
            return `${match[1]}/${match[2]}`;
          }
        }
      } catch {
        // Ignore read/parse error
      }
    }

    return null;
  }

  public fetchIssue(
    issueNumber: number,
    options: GitHubGatewayOptions = {}
  ): GitHubIssueData | null {
    if (!issueNumber || issueNumber <= 0) {
      return null;
    }

    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';

    try {
      const rawJson = this.runGh(
        `issue view ${issueNumber} ${repoFlag} --json number,title,body,labels,state,comments,milestone`,
        { cwd: options.cwd }
      );

      interface RawGhIssue {
        number?: number;
        title?: string;
        body?: string;
        state?: string;
        labels?: Array<{ name?: string } | string>;
        comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
        milestone?: { title?: string } | null;
      }

      const parsed = JSON.parse(rawJson) as RawGhIssue;
      const labels = (parsed.labels || []).map((l) => (typeof l === 'string' ? l : l.name || ''));
      const comments: GitHubComment[] = (parsed.comments || []).map((c) => ({
        author: (c.author && c.author.login) || 'unknown',
        body: c.body || '',
        createdAt: c.createdAt
      }));

      return {
        repo: repo || 'unknown',
        number: parsed.number || issueNumber,
        title: parsed.title || '',
        body: parsed.body || '',
        state: (parsed.state || 'OPEN').toUpperCase(),
        labels,
        comments,
        milestone: parsed.milestone?.title ? { title: parsed.milestone.title } : undefined
      };
    } catch (err: unknown) {
      return {
        repo: repo || 'unknown',
        number: issueNumber,
        title: '',
        body: '',
        state: 'UNKNOWN',
        labels: [],
        comments: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public findPullRequest(options: FindPullRequestOptions): GitHubPullRequestData | null {
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const state = options.state || 'all';

    try {
      let cmd: string;
      if (options.headBranch) {
        cmd = `pr list ${repoFlag} --head "${options.headBranch}" --state ${state} --json number,title,state,baseRefName,headRefName,url,mergedAt,labels --limit 1`;
      } else if (options.issueNumber) {
        cmd = `pr list ${repoFlag} --search "${options.issueNumber}" --state ${state} --json number,title,state,baseRefName,headRefName,url,mergedAt,labels --limit 10`;
      } else {
        return null;
      }

      const raw = this.runGh(cmd, { cwd: options.cwd });
      interface RawGhPr {
        number?: number;
        title?: string;
        state?: string;
        baseRefName?: string;
        headRefName?: string;
        url?: string;
        mergedAt?: string | null;
        labels?: Array<{ name?: string } | string>;
      }

      const parsed = JSON.parse(raw) as RawGhPr[];
      if (!parsed || parsed.length === 0) {
        return null;
      }

      let pr: RawGhPr | undefined;
      if (options.issueNumber) {
        const numStr = String(options.issueNumber);
        const branchPattern = new RegExp(
          `^(?:task|fix|feature|issue|bugfix)?[-_/]?${numStr}(?:[-_/]|$)`,
          'i'
        );

        // 1. Prefer head branch matching over title matching
        pr = parsed.find((p) => branchPattern.test(p.headRefName || ''));

        // 2. Fallback to title matching if no head branch match found
        if (!pr) {
          const titlePattern = new RegExp(`(^|\\s|[\\[(])#${numStr}([\\])\\s,.:;]|$)`, 'i');
          const branchIssuePattern = /^(?:task|fix|feature|issue|bugfix)?[-_/]?(\d+)(?:[-_/]|$)/i;

          pr = parsed.find((p) => {
            const head = p.headRefName || '';
            const title = p.title || '';

            if (!titlePattern.test(title)) {
              return false;
            }

            // Reject title matches if head branch explicitly points to a different issue number
            const branchIssueMatch = head.match(branchIssuePattern);
            if (branchIssueMatch && branchIssueMatch[1] !== numStr) {
              return false;
            }

            return true;
          });
        }

        if (!pr) {
          return null;
        }
      } else {
        pr = parsed[0];
      }

      const prLabels = (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name || ''));
      const isMerged = Boolean(pr.mergedAt || (pr.state || '').toUpperCase() === 'MERGED');

      return {
        number: pr.number || 0,
        title: pr.title || '',
        state: isMerged ? 'MERGED' : (pr.state || 'OPEN').toUpperCase(),
        baseRefName: pr.baseRefName || '',
        headRefName: pr.headRefName || '',
        url: pr.url || '',
        merged: isMerged,
        labels: prLabels
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      // Distinguish critical auth, credential, and network/repo failures from simply "no pull requests found"
      if (
        lower.includes('authentication') ||
        lower.includes('bad credentials') ||
        lower.includes('could not resolve to a repository') ||
        lower.includes('permission to') ||
        (lower.includes('graphql') && !lower.includes('deprecated'))
      ) {
        throw new GitHubContextError(`GitHub CLI failure in findPullRequest: ${msg}`);
      }
      return null;
    }
  }

  public fetchPullRequestComments(
    prNumber: number,
    options: GitHubGatewayOptions = {}
  ): PullRequestReviewComment[] {
    if (!prNumber || prNumber <= 0) {
      return [];
    }

    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';

    try {
      const rawJson = this.runGh(
        `pr view ${prNumber} ${repoFlag} --json comments,reviews`,
        { cwd: options.cwd }
      );

      interface RawReviewComment {
        author?: { login?: string };
        body?: string;
        path?: string;
        line?: number;
        createdAt?: string;
      }

      interface RawReview {
        author?: { login?: string };
        body?: string;
        state?: string;
        submittedAt?: string;
        createdAt?: string;
        comments?: RawReviewComment[];
      }

      interface RawGhPrView {
        comments?: Array<{
          author?: { login?: string };
          body?: string;
          createdAt?: string;
        }>;
        reviews?: RawReview[];
      }

      const parsed = JSON.parse(rawJson) as RawGhPrView;
      const results: PullRequestReviewComment[] = [];

      if (parsed.comments) {
        for (const c of parsed.comments) {
          if (c.body && c.body.trim()) {
            results.push({
              author: (c.author && c.author.login) || 'unknown',
              body: c.body,
              createdAt: c.createdAt
            });
          }
        }
      }

      if (parsed.reviews) {
        for (const r of parsed.reviews) {
          if (r.body && r.body.trim()) {
            results.push({
              author: (r.author && r.author.login) || 'unknown',
              body: r.body,
              state: r.state,
              createdAt: r.submittedAt || r.createdAt
            });
          }
          if (r.comments) {
            for (const rc of r.comments) {
              if (rc.body && rc.body.trim()) {
                results.push({
                  author: (rc.author && rc.author.login) || 'unknown',
                  body: rc.body,
                  path: rc.path,
                  line: rc.line,
                  state: r.state,
                  createdAt: rc.createdAt
                });
              }
            }
          }
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  public createPullRequest(options: CreatePullRequestOptions): GitHubPullRequestData {
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const draftFlag = options.draft ? '--draft' : '';
    const labelsFlag =
      options.labels && options.labels.length > 0
        ? `--label "${options.labels.join(',')}"`
        : '';

    const titleEscaped = options.title.replace(/"/g, '\\"');
    const bodyEscaped = options.body.replace(/"/g, '\\"');

    const cmd = `pr create ${repoFlag} --base "${options.baseBranch}" --head "${options.headBranch}" --title "${titleEscaped}" --body "${bodyEscaped}" ${draftFlag} ${labelsFlag}`;

    const url = this.runGh(cmd, { cwd: options.cwd });

    // Parse PR number from created URL if available (e.g. .../pull/42)
    const match = url.match(/\/pull\/(\d+)/);
    const prNumber = match ? parseInt(match[1], 10) : 0;

    return {
      number: prNumber,
      title: options.title,
      state: 'OPEN',
      baseRefName: options.baseBranch,
      headRefName: options.headBranch,
      url,
      merged: false,
      labels: options.labels || []
    };
  }

  public applyLabels(
    targetNumber: number,
    labels: readonly string[],
    options: GitHubGatewayOptions = {}
  ): void {
    if (!labels || labels.length === 0 || !targetNumber) return;
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const labelArgs = labels.map((l) => `--add-label "${l}"`).join(' ');

    this.runGh(`issue edit ${targetNumber} ${repoFlag} ${labelArgs}`, { cwd: options.cwd });
  }

  public commentOnIssue(
    issueNumber: number,
    comment: string,
    options: GitHubGatewayOptions = {}
  ): void {
    if (!issueNumber || !comment) return;
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const commentEscaped = comment.replace(/"/g, '\\"');

    this.runGh(`issue comment ${issueNumber} ${repoFlag} --body "${commentEscaped}"`, {
      cwd: options.cwd
    });
  }

  public closeIssue(
    issueNumber: number,
    options: GitHubGatewayOptions = {}
  ): void {
    if (!issueNumber) return;
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';

    this.runGh(`issue close ${issueNumber} ${repoFlag}`, { cwd: options.cwd });
  }

  public static formatIssueForPrompt(issueData: GitHubIssueData | null): string {
    return formatIssueForPrompt(issueData);
  }
}
