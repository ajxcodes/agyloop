/**
 * agyloop - MilestoneReleaseUseCase Application Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { MilestoneReleaseUseCase } = require('../../dist/application');
const {
  MilestoneReleaseError,
  RELEASE_BUMP_MINOR,
  RELEASE_LABEL_MINOR
} = require('../../dist/domain');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

import type {
  GitHubGateway,
  WorktreeManagerPort,
  ConfigRepository,
  AgyLoopConfig,
  CommandExecutorPort,
  CommandExecutionResult,
  CreatePullRequestOptions,
  FindPullRequestOptions,
  GitHubPullRequestData,
  GitHubIssueData
} from '../../src/ports';

function makeMockConfig(config: AgyLoopConfig = DEFAULT_CONFIG): ConfigRepository {
  return {
    loadConfig: () => config,
    resolveModel: () => ({ configured: 'inherit', tier: 'inherit' as const, apiModel: 'gemini-2.5-flash' }),
    mapModelToTier: () => 'inherit' as const
  };
}

function makeMockExecutor(): CommandExecutorPort {
  return {
    execute: async (cmd: string): Promise<CommandExecutionResult> => ({
      command: cmd,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 5,
      combinedOutput: ''
    })
  };
}

function makeMockWorktree(overrides: Partial<WorktreeManagerPort> = {}): WorktreeManagerPort {
  return {
    resolveTaskWorktreePath: async () => '/repo/.worktrees/1',
    resolveTaskBranchName: () => 'task/1-slug',
    ensureGitIgnore: async () => true,
    createWorktree: async () => ({} as any),
    removeWorktree: async () => {},
    listWorktrees: async () => [],
    cleanOrphanedWorktrees: async () => 0,
    listBranches: async () => ['main'],
    createBranch: async () => {},
    getCommitsBetween: async () => [],
    isAncestor: async () => false,
    resolveBaseBranch: async () => 'main',
    pruneWorktrees: async () => {},
    ...overrides
  };
}

describe('MilestoneReleaseUseCase', () => {
  test('fails if no active phase branch exists or is provided', async () => {
    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main'],
      resolveBaseBranch: async () => 'main'
    });

    const useCase = new MilestoneReleaseUseCase(
      mockWorktree,
      {} as any,
      makeMockConfig(),
      makeMockExecutor()
    );

    await assert.rejects(
      async () => {
        await useCase.execute({});
      },
      (err: any) => {
        assert(err instanceof MilestoneReleaseError);
        assert(err.message.includes('Cannot release from'));
        return true;
      }
    );
  });

  test('fails if 0 commits exist between base and phase branch', async () => {
    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge'],
      getCommitsBetween: async () => []
    });

    const useCase = new MilestoneReleaseUseCase(
      mockWorktree,
      {} as any,
      makeMockConfig(),
      makeMockExecutor()
    );

    await assert.rejects(
      async () => {
        await useCase.execute({ phaseBranch: 'phase/1-bridge' });
      },
      (err: any) => {
        assert(err instanceof MilestoneReleaseError);
        assert(err.message.includes('has no new commits'));
        return true;
      }
    );
  });

  test('dryRun evaluates SemVer and changelog without creating PR', async () => {
    const commits = [
      'feat(bridge): implement websocket handler',
      'fix: handle connection drop'
    ];

    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge'],
      getCommitsBetween: async () => commits
    });

    const mockGithub: GitHubGateway = {
      getCurrentRepo: () => 'org/repo',
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Issue',
        body: '',
        labels: [],
        comments: []
      }),
      findPullRequest: async () => null,
      createPullRequest: async () => {
        throw new Error('Should not call createPullRequest in dry-run mode');
      },
      applyLabels: async () => {},
      commentOnIssue: async () => {},
      closeIssue: async () => {}
    };

    const useCase = new MilestoneReleaseUseCase(
      mockWorktree,
      mockGithub,
      makeMockConfig(),
      makeMockExecutor()
    );

    const result = await useCase.execute({
      phaseBranch: 'phase/1-bridge',
      dryRun: true
    });

    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.pullRequest, undefined);
    assert.strictEqual(result.evaluation.bump, RELEASE_BUMP_MINOR);
    assert.strictEqual(result.evaluation.releaseLabel, RELEASE_LABEL_MINOR);
    assert(result.evaluation.changelog.includes('### Features'));
  });

  test('creates Milestone PR and applies release label successfully', async () => {
    const commits = [
      'feat(bridge): implement websocket handler',
      'fix: handle connection drop'
    ];

    let prCreatedWith: any = null;

    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge'],
      getCommitsBetween: async () => commits
    });

    const mockGithub: GitHubGateway = {
      getCurrentRepo: () => 'org/repo',
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Issue',
        body: '',
        labels: [],
        comments: []
      }),
      findPullRequest: async () => null,
      createPullRequest: async (options: CreatePullRequestOptions): Promise<GitHubPullRequestData> => {
        prCreatedWith = options;
        return {
          number: 105,
          title: options.title,
          url: 'https://github.com/org/repo/pull/105',
          state: 'OPEN',
          headRefName: options.headBranch,
          baseRefName: options.baseBranch,
          merged: false,
          labels: options.labels || []
        };
      },
      applyLabels: async () => {},
      commentOnIssue: async () => {},
      closeIssue: async () => {}
    };

    const useCase = new MilestoneReleaseUseCase(
      mockWorktree,
      mockGithub,
      makeMockConfig(),
      makeMockExecutor()
    );

    const result = await useCase.execute({
      phaseBranch: 'phase/1-bridge'
    });

    assert.strictEqual(result.dryRun, false);
    assert.ok(result.pullRequest);
    assert.strictEqual(result.pullRequest.number, 105);
    assert.strictEqual(prCreatedWith.baseBranch, 'main');
    assert.strictEqual(prCreatedWith.headBranch, 'phase/1-bridge');
    assert(prCreatedWith.labels.includes(RELEASE_LABEL_MINOR));
  });

  test('detects open in-flight PRs targeting the collector branch and counts them', async () => {
    const commits = ['feat: initial feature'];

    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge'],
      getCommitsBetween: async () => commits
    });

    const mockGithub: GitHubGateway = {
      getCurrentRepo: () => 'org/repo',
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Issue',
        body: '',
        labels: [],
        comments: []
      }),
      findPullRequest: async (opts: FindPullRequestOptions): Promise<GitHubPullRequestData | null> => {
        // If searching for milestone PR from phase to main -> none
        if (opts.headBranch === 'phase/1-bridge') return null;
        // If checking open child PRs into phase/1-bridge -> found 1
        if (opts.baseBranch === 'phase/1-bridge') {
          return {
            number: 99,
            title: 'Task 99 in flight',
            state: 'OPEN',
            url: '',
            headRefName: 'task/99',
            baseRefName: 'phase/1-bridge',
            merged: false,
            labels: []
          };
        }
        return null;
      },
      createPullRequest: async (options: CreatePullRequestOptions): Promise<GitHubPullRequestData> => ({
        number: 106,
        title: options.title,
        url: 'https://github.com/org/repo/pull/106',
        state: 'OPEN',
        headRefName: options.headBranch,
        baseRefName: options.baseBranch,
        merged: false,
        labels: options.labels || []
      }),
      applyLabels: async () => {},
      commentOnIssue: async () => {},
      closeIssue: async () => {}
    };

    const useCase = new MilestoneReleaseUseCase(
      mockWorktree,
      mockGithub,
      makeMockConfig(),
      makeMockExecutor()
    );

    const result = await useCase.execute({
      phaseBranch: 'phase/1-bridge'
    });

    assert.strictEqual(result.openInFlightPrsCount, 1);
  });
});
