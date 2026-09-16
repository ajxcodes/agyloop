/**
 * agyloop - Dual-Branch Inference & Remote Push Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { InferBaseBranchUseCase } = require('../../dist/application');
const { StateMachine, WorktreeDescriptor } = require('../../dist/domain');

import type {
  GitHubGateway,
  WorktreeManagerPort,
  GitHubIssueData,
  StateRepository,
  PushBranchOptions
} from '../../src/ports';
import type { StateMachineSnapshot } from '../../src/domain';

function makeMockGithub(overrides: Partial<GitHubGateway> = {}): GitHubGateway {
  return {
    getCurrentRepo: () => 'ajxcodes/agydeck',
    fetchIssue: async (num: number): Promise<GitHubIssueData> => ({
      repo: 'ajxcodes/agydeck',
      number: num,
      title: 'Phase 1: Bridge Architecture',
      body: 'Task specifications',
      labels: ['phase:1'],
      comments: [],
      state: 'OPEN'
    }),
    findPullRequest: async () => null,
    createPullRequest: async () => {
      throw new Error('Not implemented');
    },
    applyLabels: async () => {},
    commentOnIssue: async () => {},
    closeIssue: async () => {},
    ...overrides
  };
}

function makeMockWorktree(overrides: Partial<WorktreeManagerPort> = {}): WorktreeManagerPort {
  return {
    resolveTaskWorktreePath: (_dir: string, taskId: string | number) => `/repo/.worktrees/${taskId}`,
    resolveTaskBranchName: (taskId: string | number, slug?: string | null, prefix?: string) =>
      `${prefix || 'task'}/${taskId}-${slug ? slug.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'work'}`,
    ensureGitIgnore: async () => false,
    resolveBaseBranch: async () => 'main',
    createWorktree: async (opts) =>
      WorktreeDescriptor.create({
        worktreePath: `/repo/.worktrees/${opts.taskId}`,
        branch: `task/${opts.taskId}-work`,
        baseBranch: opts.baseBranch || 'phase/1-bridge-arch',
        createdAt: new Date().toISOString()
      }),
    removeWorktree: async () => {},
    pruneWorktrees: async () => {},
    listWorktrees: async () => [],
    cleanOrphanedWorktrees: async () => 0,
    listBranches: async () => ['main'],
    createBranch: async () => {},
    isAncestor: async () => false,
    getCommitsBetween: async () => [],
    pushBranch: async () => true,
    ...overrides
  };
}

class MockStateRepo implements StateRepository {
  public savedSnapshot: StateMachineSnapshot | null = null;

  constructor(initial: StateMachineSnapshot | null = null) {
    this.savedSnapshot = initial;
  }

  async load(): Promise<StateMachineSnapshot | null> {
    return this.savedSnapshot;
  }

  async save(snapshot: StateMachineSnapshot): Promise<void> {
    this.savedSnapshot = snapshot;
  }

  async reset(): Promise<void> {
    this.savedSnapshot = null;
  }

  getStateFilePath(): string {
    return '/repo/.agyloop/state.json';
  }
}

describe('Dual-Branch Lifecycle & Remote Push Inference', () => {
  test('auto-creates collector branch and invokes pushBranch to remote best-effort', async () => {
    let createdBranch = '';
    let pushedBranch = '';
    let pushedRemote = '';

    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main'],
      createBranch: async ({ branchName }: { branchName: string }) => {
        createdBranch = branchName;
      },
      pushBranch: async (opts: PushBranchOptions): Promise<boolean> => {
        pushedBranch = opts.branchName;
        pushedRemote = opts.remote || '';
        return true;
      }
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, makeMockGithub());
    const result = await useCase.execute({
      issueNumber: '5',
      title: 'Phase 1: Bridge Arch',
      labels: ['phase:1']
    });

    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.autoCreatedBaseBranch, true);
    assert.ok(result.baseBranch.startsWith('phase/1-'));
    assert.strictEqual(createdBranch, result.baseBranch);
    assert.strictEqual(pushedBranch, result.baseBranch);
    assert.strictEqual(pushedRemote, 'origin');
  });

  test('survives pushBranch failure cleanly when remote is offline (best effort)', async () => {
    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main'],
      createBranch: async () => {},
      pushBranch: async () => {
        throw new Error('fatal: Could not read from remote repository.');
      }
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, makeMockGithub());
    const result = await useCase.execute({
      issueNumber: '5',
      title: 'Phase 1: Bridge Arch',
      labels: ['phase:1']
    });

    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.autoCreatedBaseBranch, true);
    assert.ok(result.baseBranch.startsWith('phase/1-'));
  });

  test('persists inferred baseBranch into state repository if provided', async () => {
    const sm = StateMachine.createInitial({ issue: 5 });
    const stateRepo = new MockStateRepo(sm.toSnapshot());

    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge-arch']
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, makeMockGithub(), stateRepo);
    const result = await useCase.execute({
      issueNumber: '5',
      labels: ['phase:1']
    });

    assert.strictEqual(result.baseBranch, 'phase/1-bridge-arch');
    assert.strictEqual(stateRepo.savedSnapshot?.baseBranch, 'phase/1-bridge-arch');
  });

  test('roots task branch on collector branch and formats deterministic branch name', async () => {
    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge-arch']
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, makeMockGithub());
    const result = await useCase.execute({
      issueNumber: '5',
      title: 'Bridge Connector Protocol',
      labels: ['phase:1']
    });

    assert.strictEqual(result.baseBranch, 'phase/1-bridge-arch');
    assert.strictEqual(result.branchType, 'task');
    assert.strictEqual(result.suggestedBranch, 'task/5-bridge-connector-protocol');
  });

  test('roots bug branch on collector branch when phase is unmerged', async () => {
    const mockWorktree = makeMockWorktree({
      listBranches: async () => ['main', 'phase/1-bridge-arch'],
      isAncestor: async () => false
    });

    const useCase = new InferBaseBranchUseCase(mockWorktree, makeMockGithub());
    const result = await useCase.execute({
      issueNumber: '12',
      title: 'Socket Disconnect Bug',
      labels: ['phase:1', 'bug']
    });

    assert.strictEqual(result.baseBranch, 'phase/1-bridge-arch');
    assert.strictEqual(result.branchType, 'fix');
    assert.strictEqual(result.suggestedBranch, 'fix/12-socket-disconnect-bug');
  });
});
