/**
 * agyloop - PreFlight & BaseBranch Inference Use Cases Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  RunPreFlightCheckUseCase,
  InferBaseBranchUseCase
} = require('../../dist/application');
const {
  PreFlightHaltError,
  MilestoneSealedError,
  PREFLIGHT_ACTION_HALT_CLOSED,
  PREFLIGHT_ACTION_HALT_PR_MERGED,
  PREFLIGHT_ACTION_RESUME,
  PREFLIGHT_ACTION_PROCEED
} = require('../../dist/domain');

import type {
  GitHubGateway,
  WorktreeManagerPort,
  GitHubIssueData,
  GitHubPullRequestData,
  CreatePullRequestOptions
} from '../../src/ports';

function makeMockGithub(overrides: Partial<GitHubGateway> = {}): GitHubGateway {
  return {
    getCurrentRepo: () => 'org/repo',
    fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
      repo: 'org/repo',
      number: num,
      title: 'Mock Issue',
      body: '',
      labels: [],
      comments: [],
      state: 'OPEN'
    }),
    findPullRequest: async () => null,
    createPullRequest: async (options: CreatePullRequestOptions): Promise<GitHubPullRequestData> => ({
      number: 1,
      title: options.title,
      url: 'https://github.com/org/repo/pull/1',
      state: 'OPEN',
      headRefName: options.headBranch,
      baseRefName: options.baseBranch,
      merged: false,
      labels: options.labels || []
    }),
    applyLabels: async () => {},
    commentOnIssue: async () => {},
    closeIssue: async () => {},
    ...overrides
  };
}

function makeMockWorktree(overrides: Partial<WorktreeManagerPort> = {}): WorktreeManagerPort {
  return {
    resolveTaskWorktreePath: () => '/repo/.worktrees/1',
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

describe('RunPreFlightCheckUseCase', () => {
  test('throws PreFlightHaltError when issue is CLOSED on GitHub', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Closed Task',
        body: '',
        labels: [],
        comments: [],
        state: 'CLOSED'
      })
    });

    const useCase = new RunPreFlightCheckUseCase(mockGithub, makeMockWorktree());
    await assert.rejects(
      async () => {
        await useCase.execute({ issueNumber: 42 });
      },
      (err: any) => {
        assert(err instanceof PreFlightHaltError);
        assert(err.message.includes('Task #42 is already closed.'));
        return true;
      }
    );
  });

  test('throws PreFlightHaltError when associated PR is MERGED', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Merged Task',
        body: '',
        labels: [],
        comments: [],
        state: 'OPEN'
      }),
      findPullRequest: async (): Promise<GitHubPullRequestData> => ({
        number: 200,
        title: 'Task 55 PR',
        state: 'MERGED',
        url: '',
        headRefName: 'task/55-merged',
        baseRefName: 'phase/1-bridge',
        merged: true,
        labels: []
      })
    });

    const useCase = new RunPreFlightCheckUseCase(mockGithub, makeMockWorktree());
    await assert.rejects(
      async () => {
        await useCase.execute({ issueNumber: 55 });
      },
      (err: any) => {
        assert(err instanceof PreFlightHaltError);
        assert(err.message.includes('PR for task #55 is already merged into phase/1-bridge.'));
        return true;
      }
    );
  });

  test('returns RESUME evaluation when PR is OPEN', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Open Task',
        body: '',
        labels: [],
        comments: [],
        state: 'OPEN'
      }),
      findPullRequest: async (): Promise<GitHubPullRequestData> => ({
        number: 201,
        title: 'Task 60 PR',
        state: 'OPEN',
        url: '',
        headRefName: 'task/60-open-feature',
        baseRefName: 'phase/1-bridge',
        merged: false,
        labels: []
      })
    });

    const useCase = new RunPreFlightCheckUseCase(mockGithub, makeMockWorktree());
    const result = await useCase.execute({ issueNumber: 60 });

    assert.strictEqual(result.isHalt, false);
    assert.strictEqual(result.isResume, true);
    assert.strictEqual(result.resumeBranch, 'task/60-open-feature');
  });

  test('fetches PR comments and sets prHasChangesRequested when PR has CHANGES_REQUESTED review', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Open Task with Review Comments',
        body: '',
        labels: [],
        comments: [],
        state: 'OPEN'
      }),
      findPullRequest: async (): Promise<GitHubPullRequestData> => ({
        number: 202,
        title: 'Task 61 PR',
        state: 'OPEN',
        url: '',
        headRefName: 'task/61-open-feature',
        baseRefName: 'main',
        merged: false,
        labels: []
      }),
      fetchPullRequestComments: () => [
        {
          author: 'reviewer',
          body: 'Please address memory leak',
          state: 'CHANGES_REQUESTED'
        }
      ]
    });

    const useCase = new RunPreFlightCheckUseCase(mockGithub, makeMockWorktree());
    const result = await useCase.execute({ issueNumber: 61 });

    assert.strictEqual(result.isResume, true);
    assert.strictEqual(result.prHasChangesRequested, true);
    assert.strictEqual(result.prReviewComments?.length, 1);
    assert.strictEqual(result.prReviewComments?.[0].author, 'reviewer');
  });

  test('returns PROCEED for fresh open issue with no active branches or PRs', async () => {
    const useCase = new RunPreFlightCheckUseCase(makeMockGithub(), makeMockWorktree());
    const result = await useCase.execute({ issueNumber: 77 });

    assert.strictEqual(result.isHalt, false);
    assert.strictEqual(result.isResume, false);
    assert.strictEqual(result.action, PREFLIGHT_ACTION_PROCEED);
  });
});

describe('InferBaseBranchUseCase', () => {
  test('uses explicit explicitBaseBranch if provided', async () => {
    const useCase = new InferBaseBranchUseCase(makeMockWorktree(), makeMockGithub());
    const result = await useCase.execute({
      explicitBaseBranch: 'custom/dev-branch',
      issueNumber: '88'
    });

    assert.strictEqual(result.baseBranch, 'custom/dev-branch');
    assert.strictEqual(result.isCollectorBranch, false);
    assert.strictEqual(result.branchType, 'task');
  });

  test('infers phase branch from issue labels and fetches GitHub issue if needed', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Bridge Connector Architecture',
        body: '',
        labels: ['phase:1'],
        comments: [],
        state: 'OPEN'
      })
    });

    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge-arch']
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, mockGithub);
    const result = await useCase.execute({ issueNumber: 88 });

    assert.strictEqual(result.baseBranch, 'phase/1-bridge-arch');
    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.branchType, 'task');
    assert.strictEqual(result.autoCreatedBaseBranch, false);
  });

  test('auto-creates missing collector branch from main', async () => {
    let createdBranch = '';
    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main'],
      createBranch: async ({ branchName }: { branchName: string }) => {
        createdBranch = branchName;
      }
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, makeMockGithub());
    const result = await useCase.execute({
      issueNumber: '90',
      title: 'Phase 2: Database Persistence',
      labels: ['phase:2']
    });

    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.autoCreatedBaseBranch, true);
    assert(result.baseBranch.startsWith('phase/2-'));
    assert.strictEqual(createdBranch, result.baseBranch);
  });

  test('routes bug to fix/ prefix targeting collector branch if unmerged', async () => {
    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge'],
      isAncestor: async () => false
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, makeMockGithub());
    const result = await useCase.execute({
      issueNumber: '91',
      title: 'Fix bridge timeout',
      labels: ['bug', 'phase:1']
    });

    assert.strictEqual(result.baseBranch, 'phase/1-bridge');
    assert.strictEqual(result.branchType, 'fix');
    assert(result.suggestedBranch.startsWith('fix/91-'));
  });

  test('throws MilestoneSealedError if task is added to an already merged collector branch', async () => {
    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge'],
      isAncestor: async () => true // phase/1 is ancestor of main (already merged)
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, makeMockGithub());
    await assert.rejects(
      async () => {
        await useCase.execute({
          issueNumber: '92',
          title: 'Add new feature to phase 1',
          labels: ['phase:1', 'feature']
        });
      },
      MilestoneSealedError
    );
  });
});
