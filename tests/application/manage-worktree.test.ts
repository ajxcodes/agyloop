/**
 * agyloop - ManageWorktreeUseCase Unit Tests (Application Layer)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  WorktreeDescriptor,
  DEFAULT_WORKTREES_DIR,
  NOTE_WORKTREE_CREATED,
  NOTE_WORKTREE_REMOVED,
  NOTE_WORKTREE_PRUNED
} = require('../../dist/domain');
const { ManageWorktreeUseCase } = require('../../dist/application');

import type {
  WorktreeManagerPort,
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  PruneWorktreesOptions,
  ListWorktreesOptions,
  EnsureGitIgnoreOptions,
  CleanOrphanedOptions
} from '../../src/ports';

class MockWorktreeManager implements WorktreeManagerPort {
  public createWorktreeCalls: CreateWorktreeOptions[] = [];
  public removeWorktreeCalls: RemoveWorktreeOptions[] = [];
  public pruneWorktreesCalls: PruneWorktreesOptions[] = [];
  public listWorktreesCalls: ListWorktreesOptions[] = [];
  public cleanOrphanedCalls: CleanOrphanedOptions[] = [];

  public mockDescriptor: any = new WorktreeDescriptor({
    taskId: '87',
    branch: 'task/87-worktree-isolation',
    worktreePath: '/repo/.worktrees/87',
    baseBranch: 'main'
  });

  public mockWorktrees: any[] = [];
  public cleanCount = 3;

  public resolveTaskWorktreePath(workspaceDir: string, taskId: string | number, worktreesDir?: string): string {
    return `${workspaceDir}/${worktreesDir || '.worktrees'}/${taskId}`;
  }

  public resolveTaskBranchName(taskId: string | number, slug?: string | null, prefix?: string): string {
    return `${prefix || 'task/'}${taskId}-${slug || 'task'}`;
  }

  public async ensureGitIgnore(_options?: EnsureGitIgnoreOptions): Promise<boolean> {
    return true;
  }

  public async resolveBaseBranch(_workspaceDir?: string): Promise<string> {
    return 'main';
  }

  public async createWorktree(options: CreateWorktreeOptions): Promise<any> {
    this.createWorktreeCalls.push(options);
    return this.mockDescriptor;
  }

  public async removeWorktree(options: RemoveWorktreeOptions): Promise<void> {
    this.removeWorktreeCalls.push(options);
  }

  public async pruneWorktrees(options?: PruneWorktreesOptions): Promise<void> {
    this.pruneWorktreesCalls.push(options || {});
  }

  public async listWorktrees(options?: ListWorktreesOptions): Promise<any> {
    this.listWorktreesCalls.push(options || {});
    return this.mockWorktrees;
  }

  public async cleanOrphanedWorktrees(options?: CleanOrphanedOptions): Promise<number> {
    this.cleanOrphanedCalls.push(options || {});
    return this.cleanCount;
  }
}

describe('ManageWorktreeUseCase (Application Layer)', () => {
  test('provision calls worktreeManager.createWorktree with resolved parameters', async () => {
    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock);

    const result = await useCase.provision({
      taskId: 87,
      baseBranch: 'main',
      title: 'Git Worktree Isolation',
      workspaceDir: '/test/repo',
      linkNodeModules: true
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes(NOTE_WORKTREE_CREATED));
    assert.strictEqual(result.data?.taskId, '87');
    assert.strictEqual(result.data?.branch, 'task/87-worktree-isolation');
    assert.strictEqual(result.data?.worktreePath, '/repo/.worktrees/87');

    assert.strictEqual(mock.createWorktreeCalls.length, 1);
    assert.strictEqual(mock.createWorktreeCalls[0].taskId, 87);
    assert.strictEqual(mock.createWorktreeCalls[0].baseBranch, 'main');
    assert.strictEqual(mock.createWorktreeCalls[0].title, 'Git Worktree Isolation');
    assert.strictEqual(mock.createWorktreeCalls[0].worktreesDir, DEFAULT_WORKTREES_DIR);
  });

  test('teardown calls worktreeManager.removeWorktree with defaults', async () => {
    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock);

    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo'
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes(NOTE_WORKTREE_REMOVED));
    assert.strictEqual(mock.removeWorktreeCalls.length, 1);
    assert.strictEqual(mock.removeWorktreeCalls[0].worktreePath, '/repo/.worktrees/87');
    assert.strictEqual(mock.removeWorktreeCalls[0].force, true);
    assert.strictEqual(mock.removeWorktreeCalls[0].prune, true);
  });

  test('prune calls worktreeManager.pruneWorktrees', async () => {
    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock);

    const result = await useCase.prune({ workspaceDir: '/repo', expire: 'now' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.message, NOTE_WORKTREE_PRUNED);
    assert.strictEqual(mock.pruneWorktreesCalls.length, 1);
    assert.strictEqual(mock.pruneWorktreesCalls[0].expire, 'now');
  });

  test('list returns active worktrees from manager', async () => {
    const mock = new MockWorktreeManager();
    const descriptor1 = new WorktreeDescriptor({
      taskId: '1',
      branch: 'task/1-first',
      worktreePath: '/repo/.worktrees/1',
      baseBranch: 'main'
    });
    const descriptor2 = new WorktreeDescriptor({
      taskId: '2',
      branch: 'task/2-second',
      worktreePath: '/repo/.worktrees/2',
      baseBranch: 'main'
    });
    mock.mockWorktrees = [descriptor1, descriptor2];

    const useCase = new ManageWorktreeUseCase(mock);
    const result = await useCase.list({ workspaceDir: '/repo' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.length, 2);
    assert.strictEqual(result.data?.[0].taskId, '1');
    assert.strictEqual(result.data?.[1].taskId, '2');
    assert.ok(result.message.includes('2 active isolated worktree(s)'));
  });

  test('clean cleans orphaned worktrees and returns count', async () => {
    const mock = new MockWorktreeManager();
    mock.cleanCount = 4;
    const useCase = new ManageWorktreeUseCase(mock);

    const result = await useCase.clean({ workspaceDir: '/repo' });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.count, 4);
    assert.ok(result.message.includes('Cleaned 4 orphaned worktree(s)'));
    assert.strictEqual(mock.cleanOrphanedCalls.length, 1);
  });
});
