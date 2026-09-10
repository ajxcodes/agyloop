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
        `issue view ${issueNumber} ${repoFlag} --json number,title,body,labels,comments`,
        { cwd: options.cwd }
      );

      interface RawGhIssue {
        number?: number;
        title?: string;
        body?: string;
        labels?: Array<{ name?: string } | string>;
        comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
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
        labels,
        comments
      };
    } catch (err: unknown) {
      return {
        repo: repo || 'unknown',
        number: issueNumber,
        title: '',
        body: '',
        labels: [],
        comments: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public static formatIssueForPrompt(issueData: GitHubIssueData | null): string {
    return formatIssueForPrompt(issueData);
  }
}
