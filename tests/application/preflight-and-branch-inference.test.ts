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

  test('throws PreFlightHaltError when associated PR is MERGED and asserts delivery', async () => {
    // #226: a merged PR halts only when its BODY carries a closing keyword for the
    // issue. The head branch `task/55-merged` alone is no longer sufficient, so this
    // fixture keeps exercising the anti-duplicate halt for the *new*, stricter reason.
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
        body: 'Closes #55',
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
        assert(
          err.message.includes(
            'PR #200 for task #55 merged into phase/1-bridge and asserts delivery (closing keyword for #55), but the issue is still open.'
          )
        );
        assert.strictEqual(err.details.prNumber, 200);
        return true;
      }
    );
  });

  // #226 regression coverage: PR #228 was a one-line test-mock fix developed on
  // branch `task/226` whose body never mentions #226. Treating that as delivery
  // evidence made the OPEN, unimplemented issue #226 unstartable.
  const PR_228 = {
    number: 228,
    title: 'fix(tests): narrow git branch mock to listBranches command (#226)',
    url: 'https://github.com/org/repo/pull/228',
    headRefName: 'task/226',
    state: 'MERGED',
    merged: true,
    baseRefName: 'phase/6-codeloop',
    labels: [],
    body:
      '## Summary\n\nFixes Alpine CI failure in `tests/…`.\n\n### Fix\nNarrowed the mock…'
  } as const;

  function makePr228Github(bodyOverride?: string): GitHubGateway {
    return makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Phase 6 state contracts',
        body: '',
        labels: [],
        comments: [],
        state: 'OPEN'
      }),
      findPullRequest: async (): Promise<GitHubPullRequestData> => ({
        ...PR_228,
        body: bodyOverride !== undefined ? bodyOverride : PR_228.body
      })
    });
  }

  test('does NOT halt on a merged PR developed on task/<n> that does not assert delivery (#226)', async () => {
    const useCase = new RunPreFlightCheckUseCase(makePr228Github(), makeMockWorktree());
    const result = await useCase.execute({ issueNumber: 226 });

    assert.strictEqual(result.isHalt, false);
    assert.strictEqual(result.action, PREFLIGHT_ACTION_PROCEED);
  });

  test('warns loudly and names the PR, branch, OPEN state and operator action (#226)', async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    let result: any;
    try {
      const useCase = new RunPreFlightCheckUseCase(makePr228Github(), makeMockWorktree());
      result = await useCase.execute({ issueNumber: 226 });
    } finally {
      console.warn = originalWarn;
    }

    assert.strictEqual(warnings.length, 1, 'Expected exactly one loud warning');
    const warning = warnings[0];
    assert.ok(warning.includes('228'), 'warning must name the PR number');
    assert.ok(warning.includes(PR_228.title), 'warning must name the PR title');
    assert.ok(warning.includes('task/226'), 'warning must name the head branch');
    assert.ok(warning.includes('226'), 'warning must name the issue');
    assert.ok(warning.includes('OPEN'), 'warning must state the issue is still OPEN');
    assert.ok(warning.includes('close the issue'), 'warning must name the operator action');
    assert.ok(warning.split('\n').length >= 3, 'warning must be multi-line');
    assert.strictEqual(result.isHalt, false);
  });

  for (const keyword of ['Closes', 'Fixes', 'Resolves']) {
    test(`still halts when the merged PR body carries '${keyword} #226'`, async () => {
      const useCase = new RunPreFlightCheckUseCase(
        makePr228Github(`## Summary\n\nsomething\n\n${keyword} #226\n`),
        makeMockWorktree()
      );

      await assert.rejects(
        async () => {
          await useCase.execute({ issueNumber: 226 });
        },
        (err: any) => {
          assert(err instanceof PreFlightHaltError);
          assert(err.message.includes('merged into phase/6-codeloop'));
          assert(err.message.includes('226'));
          assert.strictEqual(err.details.prNumber, 228);
          return true;
        }
      );
    });
  }

  test('does NOT halt when the closing keyword names a different issue', async () => {
    const useCase = new RunPreFlightCheckUseCase(
      makePr228Github('Closes #227'),
      makeMockWorktree()
    );
    const result = await useCase.execute({ issueNumber: 226 });

    assert.strictEqual(result.isHalt, false);
  });

  test('still halts a CLOSED issue with haltType CLOSED regardless of the PR (#226 anti-duplicate intact)', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Already delivered',
        body: '',
        labels: [],
        comments: [],
        state: 'CLOSED'
      }),
      findPullRequest: async (): Promise<GitHubPullRequestData> => ({
        ...PR_228,
        merged: false,
        state: 'OPEN'
      })
    });

    const useCase = new RunPreFlightCheckUseCase(mockGithub, makeMockWorktree());
    await assert.rejects(
      async () => {
        await useCase.execute({ issueNumber: 226 });
      },
      (err: any) => {
        assert(err instanceof PreFlightHaltError);
        assert.strictEqual(err.haltType, 'CLOSED');
        assert(err.message.includes('Task #226 is already closed.'));
        return true;
      }
    );
  });

  test('disregards merged PR and proceeds when issue is OPEN but merged PR head branch does not match task convention', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Open Task 75',
        body: '',
        labels: [],
        comments: [],
        state: 'OPEN'
      }),
      findPullRequest: async (): Promise<GitHubPullRequestData> => ({
        number: 35,
        title: 'Merged Historical PR (#75)',
        state: 'MERGED',
        url: '',
        headRefName: '34-task-metrics',
        baseRefName: 'main',
        merged: true,
        labels: []
      })
    });

    const useCase = new RunPreFlightCheckUseCase(mockGithub, makeMockWorktree());
    const result = await useCase.execute({ issueNumber: 75 });

    assert.strictEqual(result.isHalt, false);
    assert.strictEqual(result.isResume, false);
    assert.strictEqual(result.action, PREFLIGHT_ACTION_PROCEED);
  });

  test('disregards merged PR and resumes existing branch when issue is OPEN but merged PR head branch does not match task convention', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Open Task 75',
        body: '',
        labels: [],
        comments: [],
        state: 'OPEN'
      }),
      findPullRequest: async (): Promise<GitHubPullRequestData> => ({
        number: 35,
        title: 'Merged Historical PR (#75)',
        state: 'MERGED',
        url: '',
        headRefName: '34-task-metrics',
        baseRefName: 'main',
        merged: true,
        labels: []
      })
    });

    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'task/75-implement-feature']
    });

    const useCase = new RunPreFlightCheckUseCase(mockGithub, mockWorktree);
    const result = await useCase.execute({ issueNumber: 75 });

    assert.strictEqual(result.isHalt, false);
    assert.strictEqual(result.isResume, true);
    assert.strictEqual(result.existingBranch, 'task/75-implement-feature');
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

  test('uses explicit explicitBaseBranch and infers fix prefix when issue has bug label on GitHub', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
        repo: 'org/repo',
        number: num,
        title: 'Fix issue on reopen',
        body: '',
        labels: ['bug'],
        comments: [],
        state: 'OPEN'
      })
    });

    const useCase = new InferBaseBranchUseCase(makeMockWorktree(), mockGithub);
    const result = await useCase.execute({
      explicitBaseBranch: 'phase/5-bug-fix',
      issueNumber: 82
    });

    assert.strictEqual(result.baseBranch, 'phase/5-bug-fix');
    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.branchType, 'fix');
    assert.strictEqual(result.taskBranchPrefix, 'fix/');
    assert(result.suggestedBranch.startsWith('fix/82-'));
    assert.strictEqual(result.isBug, true);
  });

  test('handles fetchIssue failure gracefully when explicitBaseBranch is provided', async () => {
    const mockGithub = makeMockGithub({
      fetchIssue: async () => {
        throw new Error('Network error');
      }
    });

    const useCase = new InferBaseBranchUseCase(makeMockWorktree(), mockGithub);
    const result = await useCase.execute({
      explicitBaseBranch: 'phase/5-bug-fix',
      issueNumber: 82
    });

    assert.strictEqual(result.baseBranch, 'phase/5-bug-fix');
    assert.strictEqual(result.branchType, 'task');
    assert.strictEqual(result.taskBranchPrefix, 'task/');
    assert(result.suggestedBranch.startsWith('task/82-'));
    assert.strictEqual(result.isBug, false);
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
