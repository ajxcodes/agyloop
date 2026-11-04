/**
 * agyloop - ONE canonical GitHubGateway double (issue #544 / AC2)
 *
 * Retires `GitHubGatewayDouble` / `GitHubGatewayDouble`. Recording is always on:
 * every port method records into `calls[method]`, and the returned values are
 * configurable per suite via `options.*` (stub maps instead of closure
 * families). Lenient methods return the configured values or defaults;
 * `fetchIssueStrict` mirrors the fail-closed contract (throws
 * GitHubContextError when no issue is configured).
 */

import type { GitHubGateway } from '../../../src/ports';

interface FakeGitHubGatewayOptions {
  /** `getCurrentRepo()` body. Default 'ajxcodes/agyloop'. */
  currentRepo?: string | null;
  /** `fetchIssue()`/`fetchIssueStrict()` body. Default a minimal OPEN issue. */
  issue?: Record<string, unknown> | null;
  strictIssue?: Record<string, unknown>;
  /** `gh issue view` fails even with a configured issue (fail-closed fixtures). */
  strictFails?: Error | boolean;
  /** head branch/issue -> PR data map for findPullRequest. */
  pullRequests?: Record<string, Record<string, unknown>> | null;
  createdPullRequest?: Record<string, unknown>;
  labels?: string[];
  labelExistsMap?: Record<string, boolean>;
  comments?(): Record<string, unknown>[];
  reviewComments?: Record<string, unknown>[];
  reviewThreads?: Record<string, unknown>[];
  /** Post-failure mode: every write THROWS (write-guard fixtures). */
  throwsOnWrite?: Error;
}

const { GitHubContextError } = require('../../../dist/domain');

class FakeGitHubGateway implements GitHubGateway {
  public calls: Record<string, unknown[]> = {
    getCurrentRepo: [],
    fetchIssue: [],
    fetchIssueStrict: [],
    findPullRequest: [],
    createPullRequest: [],
    applyLabels: [],
    labelExists: [],
    createLabel: [],
    commentOnIssue: [],
    closeIssue: [],
    fetchPullRequestComments: [],
    listReviewThreads: []
  };

  public currentRepo: string | null;
  public issueData: Record<string, unknown> | null;
  public strictIssueData: Record<string, unknown> | undefined;
  public strictFails: Error | boolean;
  public pullRequests: Record<string, Record<string, unknown>> | null;
  public createdPullRequest: Record<string, unknown> | undefined;
  public appliedLabels: Array<{ number: unknown; labels: string[] }> = [];
  public labelExistsMap: Record<string, boolean>;
  public postedComments: Array<{ number: unknown; comment: string }> = [];
  public closedIssues: unknown[] = [];
  public createdLabels: string[] = [];
  public reviewComments: Record<string, unknown>[];
  public reviewThreads: Record<string, unknown>[];
  public throwsOnWrite: Error | undefined;

  constructor(options: FakeGitHubGatewayOptions = {}) {
    this.currentRepo = options.currentRepo === undefined ? 'ajxcodes/agyloop' : options.currentRepo;
    this.issueData =
      options.issue === undefined
        ? ({ repo: 'ajxcodes/agyloop', number: 999, title: 'test issue', body: 'body', state: 'OPEN' } as Record<string, unknown>)
        : options.issue;
    this.strictIssueData = options.strictIssue;
    this.strictFails = options.strictFails ?? false;
    this.pullRequests = options.pullRequests ?? null;
    this.createdPullRequest = options.createdPullRequest;
    this.appliedLabels = [];
    this.labelExistsMap = options.labelExistsMap ?? {};
    this.postedComments = [];
    this.closedIssues = [];
    this.createdLabels = [];
    this.reviewComments = options.reviewComments ?? [];
    this.reviewThreads = options.reviewThreads ?? [];
    this.throwsOnWrite = options.throwsOnWrite;
  }

  public async getCurrentRepo(): Promise<string | null> {
    this.calls.getCurrentRepo.push([]);
    return this.currentRepo;
  }

  public async fetchIssue(issueNumber: number): Promise<any> {
    this.calls.fetchIssue.push([issueNumber]);
    if (this.issueData === null) return null;
    return { ...this.issueData, number: issueNumber } as never;
  }

  public async fetchIssueStrict(issueNumber: number): Promise<never> {
    this.calls.fetchIssueStrict.push([issueNumber]);
    if (this.strictFails) {
      const error = this.strictFails instanceof Error ? this.strictFails : new Error('gh issue view failed');
      throw error;
    }
    const source = this.strictIssueData ?? this.issueData;
    const state = source ? source.state : undefined;
    if (!source || (state !== 'OPEN' && state !== 'CLOSED')) {
      throw new GitHubContextError('no recognisable OPEN/CLOSED state');
    }
    return { ...source, number: issueNumber } as never;
  }

  public async findPullRequest(options: never): Promise<any> {
    this.calls.findPullRequest.push([options]);
    if (!this.pullRequests) return null;
    const byIssue = String((options as Record<string, unknown>).issueNumber ?? '');
    const byHead = String((options as Record<string, unknown>).headBranch ?? '');
    return (this.pullRequests[byIssue] ?? this.pullRequests[byHead] ?? null) as never;
  }

  public async createPullRequest(options: never): Promise<any> {
    this.calls.createPullRequest.push([options]);
    if (this.throwsOnWrite) throw this.throwsOnWrite;
    const opt = options as Record<string, unknown>;
    const pr = this.createdPullRequest ?? {
      number: 101,
      url: 'https://github.com/ajxcodes/agyloop/pull/101',
      state: 'OPEN',
      title: opt.title ?? '',
      headBranch: opt.headBranch ?? '',
      baseBranch: opt.baseBranch ?? ''
    };
    return pr as never;
  }

  public async applyLabels(targetNumber: number, labels: readonly string[], _options?: never): Promise<void> {
    this.calls.applyLabels.push([targetNumber, labels]);
    if (this.throwsOnWrite) throw this.throwsOnWrite;
    this.appliedLabels.push({ number: targetNumber, labels: [...labels] });
  }

  public async labelExists(name: string, _options?: never): Promise<boolean> {
    this.calls.labelExists.push([name]);
    if (this.throwsOnWrite) throw this.throwsOnWrite;
    return this.labelExistsMap[name] ?? true;
  }

  public async createLabel(name: string, _options?: never): Promise<void> {
    this.calls.createLabel.push([name]);
    if (this.throwsOnWrite) throw this.throwsOnWrite;
    this.createdLabels.push(name);
  }

  public async commentOnIssue(issueNumber: number, comment: string, _options?: never): Promise<void> {
    this.calls.commentOnIssue.push([issueNumber, comment]);
    if (this.throwsOnWrite) throw this.throwsOnWrite;
    this.postedComments.push({ number: issueNumber, comment });
  }

  public async closeIssue(issueNumber: number, _options?: never): Promise<void> {
    this.calls.closeIssue.push([issueNumber]);
    if (this.throwsOnWrite) throw this.throwsOnWrite;
    this.closedIssues.push(issueNumber);
  }

  public async fetchPullRequestComments(prNumber: number, _options?: never): Promise<any> {
    this.calls.fetchPullRequestComments.push([prNumber]);
    return this.reviewComments as never;
  }

  public async listReviewThreads(prNumber: number, _options?: never): Promise<any> {
    this.calls.listReviewThreads.push([prNumber]);
    return this.reviewThreads as never;
  }
}

function createFakeGitHubGateway(options?: FakeGitHubGatewayOptions): FakeGitHubGateway {
  return new FakeGitHubGateway(options ?? {});
}

module.exports = { FakeGitHubGateway, createFakeGitHubGateway };
