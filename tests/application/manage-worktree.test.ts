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
  NOTE_WORKTREE_PRUNED,
  NOTE_WORKTREE_CHECKPOINT_CLEARED,
  NOTE_WORKTREE_CHECKPOINT_CLEARED_SCOPE,
  NOTE_WORKTREE_CHECKPOINT_UNCHANGED,
  NOTE_WORKTREE_CHECKPOINT_UNREADABLE,
  NOTE_WORKTREE_STALE_PRUNED,
  NOTE_WORKTREE_STALE_ABSENT
} = require('../../dist/domain');
const { ManageWorktreeUseCase } = require('../../dist/application');

import type {
  WorktreeManagerPort,
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  PruneWorktreesOptions,
  ListWorktreesOptions,
  EnsureGitIgnoreOptions,
  CleanOrphanedOptions,
  StateRepository
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

  public async resolveTaskWorktreePath(workspaceDir: string, taskId: string | number, worktreesDir?: string): Promise<string> {
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

/**
 * In-memory `StateRepository` for the descriptor-clearing tests (#282).
 *
 * Shared across the per-issue repositories `forIssue()` hands out, so a write
 * through one scope is observable through the store — exactly like the file
 * adapter's `tasks/<issue>.json`.
 */
class MockStateStore {
  public readonly snapshots = new Map<string, any>();
  public readonly saves: Array<{ filePath: string; snapshot: any }> = [];
  public readonly corrupt = new Set<string>();

  public repo(filePath = ROOT_STATE_PATH): StateRepository {
    return new MockStateRepository(this, filePath);
  }
}

class MockStateRepository implements StateRepository {
  private readonly store: MockStateStore;
  private readonly filePath: string;

  constructor(store: MockStateStore, filePath: string) {
    this.store = store;
    this.filePath = filePath;
  }

  public getStateFilePath(): string {
    return this.filePath;
  }

  public load(): any {
    if (this.store.corrupt.has(this.filePath)) {
      throw new Error(`Failed to parse state checkpoint at ${this.filePath}`);
    }
    return this.store.snapshots.has(this.filePath) ? this.store.snapshots.get(this.filePath) : null;
  }

  public save(snapshot: any): void {
    this.store.snapshots.set(this.filePath, snapshot);
    this.store.saves.push({ filePath: this.filePath, snapshot });
  }

  public reset(): void {
    this.store.snapshots.delete(this.filePath);
  }

  public forIssue(issue: number | string): StateRepository {
    return new MockStateRepository(this.store, taskStatePath(issue));
  }

  public listAllStates(): any[] {
    return Array.from(this.store.snapshots.values());
  }
}

const ROOT_STATE_PATH = '/repo/.agyloop/state.json';
const NOW = '2026-10-23T09:00:00.000Z';

function taskStatePath(issue: number | string): string {
  return `/repo/.agyloop/tasks/${issue}.json`;
}

function worktreeSnapshot(issue: number, worktreePath: string): any {
  return {
    version: '1.0.0',
    currentStage: 'IMPLEMENT',
    mode: 'standard',
    issue,
    baseBranch: 'main',
    worktree: {
      taskId: String(issue),
      worktreePath,
      branch: `task/${issue}-probe`,
      baseBranch: 'main',
      isIsolated: true
    },
    createdAt: NOW,
    updatedAt: NOW,
    history: []
  };
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
    // #339 (item 5 / T5.4): the list message names the prunable count — a
    // registration git calls `prunable` can no longer be reported as active.
    assert.ok(result.message.includes('Found 2 isolated worktree(s) (0 prunable).'), result.message);
  });

  test('list reports the prunable count when a registration is prunable (T5.4)', async () => {
    const mock = new MockWorktreeManager();
    mock.mockWorktrees = [
      new WorktreeDescriptor({
        taskId: '1',
        branch: 'task/1-first',
        worktreePath: '/repo/.worktrees/1',
        baseBranch: 'main'
      }),
      new WorktreeDescriptor({
        taskId: '2',
        branch: 'task/2-second',
        worktreePath: '/repo/.worktrees/2',
        baseBranch: 'main',
        prunable: true
      })
    ];

    const useCase = new ManageWorktreeUseCase(mock);
    const result = await useCase.list({ workspaceDir: '/repo' });

    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Found 2 isolated worktree(s) (1 prunable).'), result.message);
    assert.strictEqual(result.data?.[1].prunable, true);
    assert.strictEqual(result.data?.[0].prunable, false);
  });

  test('list forwards includeExternal to manager', async () => {
    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock);

    await useCase.list({ workspaceDir: '/repo', includeExternal: true });

    assert.strictEqual(mock.listWorktreesCalls.length, 1);
    assert.strictEqual(mock.listWorktreesCalls[0].includeExternal, true);
    assert.strictEqual(mock.listWorktreesCalls[0].workspaceDir, '/repo');
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

  test('clean forwards subagents and all flags to worktreeManager', async () => {
    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock);

    await useCase.clean({ workspaceDir: '/repo', subagents: true, all: true });

    assert.strictEqual(mock.cleanOrphanedCalls.length, 1);
    assert.strictEqual(mock.cleanOrphanedCalls[0].subagents, true);
    assert.strictEqual(mock.cleanOrphanedCalls[0].all, true);
    assert.strictEqual(mock.cleanOrphanedCalls[0].workspaceDir, '/repo');
  });

  // -------------------------------------------------------------------------
  // Issue #282 (absorbs #273): a successful teardown clears the checkpoint
  // descriptor that named the removed path — scoped by PATH, never by token.
  // -------------------------------------------------------------------------

  test('T-A1 teardown clears the matching descriptor and reports it (AC-6, AC-7)', async () => {
    const store = new MockStateStore();
    store.snapshots.set(taskStatePath(87), worktreeSnapshot(87, '/repo/.worktrees/87'));

    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock, store.repo());

    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo',
      issue: 87
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.descriptorCleared, true);
    assert.strictEqual(result.data?.descriptorStatus, 'cleared');
    assert.ok(
      result.message.includes(NOTE_WORKTREE_CHECKPOINT_CLEARED),
      `unexpected message: ${result.message}`
    );

    const saved = store.saves.find((s) => s.filePath === taskStatePath(87));
    assert.ok(saved, 'the task checkpoint must be written');
    assert.strictEqual(saved?.snapshot.worktree, null);
  });

  test("T-A2 teardown leaves another task's descriptor untouched (AC-6)", async () => {
    const store = new MockStateStore();
    store.snapshots.set(taskStatePath(87), worktreeSnapshot(87, '/repo/.worktrees/87'));
    const sibling = worktreeSnapshot(88, '/repo/.worktrees/88');
    store.snapshots.set(taskStatePath(88), sibling);

    const useCase = new ManageWorktreeUseCase(new MockWorktreeManager(), store.repo());
    await useCase.teardown({ worktreePath: '/repo/.worktrees/87', workspaceDir: '/repo', issue: 87 });

    assert.strictEqual(
      store.saves.some((s) => s.filePath === taskStatePath(88)),
      false,
      'the sibling checkpoint must never be written'
    );
    assert.deepStrictEqual(store.snapshots.get(taskStatePath(88)), sibling);
  });

  test('T-A3 teardown does not clear a descriptor for a different path (AC-6, AC-7)', async () => {
    const store = new MockStateStore();
    store.snapshots.set(taskStatePath(87), worktreeSnapshot(87, '/repo/.worktrees/999'));

    const useCase = new ManageWorktreeUseCase(new MockWorktreeManager(), store.repo());
    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo',
      issue: 87
    });

    assert.strictEqual(result.data?.descriptorCleared, false);
    assert.strictEqual(result.data?.descriptorStatus, 'not-found');
    assert.ok(result.message.includes(NOTE_WORKTREE_CHECKPOINT_UNCHANGED));
    assert.strictEqual(store.saves.length, 0, 'nothing may be written');
  });

  test('T-A4 tolerateMissing is forwarded and a missing worktree still clears the descriptor (AC-12)', async () => {
    const store = new MockStateStore();
    store.snapshots.set(taskStatePath(87), worktreeSnapshot(87, '/repo/.worktrees/87'));

    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock, store.repo());

    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo',
      issue: 87,
      tolerateMissing: true
    });

    assert.strictEqual(mock.removeWorktreeCalls.length, 1);
    assert.strictEqual(mock.removeWorktreeCalls[0].tolerateMissing, true);
    assert.strictEqual(result.data?.descriptorCleared, true);
  });

  test('T-A5 without a state repository the result is unchanged and no clear is attempted', async () => {
    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock);

    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.descriptorCleared, false);
    assert.strictEqual(result.data?.descriptorStatus, 'unavailable');
    assert.strictEqual(result.message, `${NOTE_WORKTREE_REMOVED} at /repo/.worktrees/87`);
  });

  test('T-A6 scans checkpoints by path when no issue is supplied (AC-6)', async () => {
    const store = new MockStateStore();
    store.snapshots.set(taskStatePath(87), worktreeSnapshot(87, '/repo/.worktrees/87'));

    const useCase = new ManageWorktreeUseCase(new MockWorktreeManager(), store.repo());
    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo'
    });

    assert.strictEqual(result.data?.descriptorStatus, 'cleared');
    assert.strictEqual(store.saves.length, 1);
    assert.strictEqual(store.saves[0].filePath, taskStatePath(87));
    assert.strictEqual(store.saves[0].snapshot.worktree, null);
  });

  test('T-A7 a corrupt checkpoint does not fail a successful removal (AC-7)', async () => {
    const store = new MockStateStore();
    store.corrupt.add(taskStatePath(87));

    const useCase = new ManageWorktreeUseCase(new MockWorktreeManager(), store.repo());
    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo',
      issue: 87
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.descriptorStatus, 'corrupt');
    assert.ok(result.message.includes(NOTE_WORKTREE_CHECKPOINT_UNREADABLE));
  });

  test('T-A8 forwards force/prune/tolerateMissing/allowExternal defaults', async () => {
    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock);

    await useCase.teardown({ worktreePath: '/repo/.worktrees/87', workspaceDir: '/repo' });

    assert.strictEqual(mock.removeWorktreeCalls[0].force, true);
    assert.strictEqual(mock.removeWorktreeCalls[0].prune, true);
    assert.strictEqual(mock.removeWorktreeCalls[0].tolerateMissing, undefined);
    assert.strictEqual(mock.removeWorktreeCalls[0].allowExternal, undefined);
  });

  test('T-A9 clears EVERY checkpoint naming the removed path, root state included (AC-6, AC-8)', async () => {
    // Legacy layout: the SAME descriptor in the root checkpoint AND the task
    // checkpoint. Stopping at the first match left `tasks/87.json` advertising
    // the removed path while the command announced a full clear.
    const store = new MockStateStore();
    store.snapshots.set(ROOT_STATE_PATH, worktreeSnapshot(87, '/repo/.worktrees/87'));
    store.snapshots.set(taskStatePath(87), worktreeSnapshot(87, '/repo/.worktrees/87'));

    const useCase = new ManageWorktreeUseCase(new MockWorktreeManager(), store.repo());
    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo',
      issue: 87
    });

    assert.strictEqual(result.data?.descriptorStatus, 'cleared');
    assert.strictEqual(result.data?.descriptorCleared, true);
    assert.deepStrictEqual(
      [...(result.data?.clearedCheckpoints ?? [])].sort(),
      [ROOT_STATE_PATH, taskStatePath(87)].sort()
    );
    assert.strictEqual(store.snapshots.get(ROOT_STATE_PATH).worktree, null);
    assert.strictEqual(store.snapshots.get(taskStatePath(87)).worktree, null);
    assert.ok(result.message.includes(NOTE_WORKTREE_CHECKPOINT_CLEARED), result.message);
    assert.ok(result.message.includes(ROOT_STATE_PATH), result.message);
    assert.ok(result.message.includes(taskStatePath(87)), result.message);
  });

  test('T-A10 a root-only match reports the cleared scope, not "this task" (AC-7)', async () => {
    const store = new MockStateStore();
    store.snapshots.set(ROOT_STATE_PATH, worktreeSnapshot(87, '/repo/.worktrees/87'));

    const useCase = new ManageWorktreeUseCase(new MockWorktreeManager(), store.repo());
    const result = await useCase.teardown({
      worktreePath: '/repo/.worktrees/87',
      workspaceDir: '/repo',
      issue: 87
    });

    assert.strictEqual(result.data?.descriptorStatus, 'cleared');
    assert.strictEqual(result.message.includes(NOTE_WORKTREE_CHECKPOINT_CLEARED), false, result.message);
    assert.ok(result.message.includes(NOTE_WORKTREE_CHECKPOINT_CLEARED_SCOPE), result.message);
    assert.ok(result.message.includes(ROOT_STATE_PATH), result.message);
  });

  test('T-A11 clearStaleDescriptor repairs a descriptor without a live directory (AC-9)', async () => {
    const store = new MockStateStore();
    store.snapshots.set(ROOT_STATE_PATH, worktreeSnapshot(42, '/repo/.worktrees/42'));
    store.snapshots.set(taskStatePath(42), worktreeSnapshot(42, '/repo/.worktrees/42'));

    const mock = new MockWorktreeManager();
    const useCase = new ManageWorktreeUseCase(mock, store.repo());
    const result = await useCase.clearStaleDescriptor({
      worktreePath: '/repo/.worktrees/42',
      issue: 42
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(mock.removeWorktreeCalls.length, 0, 'no removal may be attempted');
    assert.ok(result.message.includes(NOTE_WORKTREE_STALE_PRUNED), result.message);
    assert.strictEqual(store.snapshots.get(ROOT_STATE_PATH).worktree, null);
    assert.strictEqual(store.snapshots.get(taskStatePath(42)).worktree, null);
  });

  test('T-A12 clearStaleDescriptor is an idempotent no-op when nothing matches (AC-9)', async () => {
    const store = new MockStateStore();
    const useCase = new ManageWorktreeUseCase(new MockWorktreeManager(), store.repo());

    const result = await useCase.clearStaleDescriptor({
      worktreePath: '/repo/.worktrees/42',
      issue: 42
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.data?.descriptorStatus, 'not-found');
    assert.ok(result.message.includes(NOTE_WORKTREE_STALE_ABSENT), result.message);
    assert.strictEqual(store.saves.length, 0);
  });

  test('T-A13 clearStaleDescriptor fails on an unreadable checkpoint (AC-9)', async () => {
    const store = new MockStateStore();
    store.corrupt.add(taskStatePath(42));

    const useCase = new ManageWorktreeUseCase(new MockWorktreeManager(), store.repo());
    const result = await useCase.clearStaleDescriptor({
      worktreePath: '/repo/.worktrees/42',
      issue: 42
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.data?.descriptorStatus, 'corrupt');
    assert.ok(result.message.includes(NOTE_WORKTREE_CHECKPOINT_UNREADABLE), result.message);
  });
});


// #339 (item 5 / T5.4): the list message names the prunable count (pinned
// above), and the CLEAN message shapes for 0 / 1 / N are unchanged.
describe('clean message shapes are unchanged (#339 T5.4)', () => {
  for (const [count, shape] of [
    [0, 'Would remove 0 orphaned worktree directories and prune dangling git registrations.'],
    [1, 'Would remove 1 orphaned worktree directory and prune dangling git registrations.'],
    [4, 'Would remove 4 orphaned worktree directories and prune dangling git registrations.']
  ] as const) {
    test(`dry-run count ${count} keeps its exact wording`, async () => {
      const mock = new MockWorktreeManager();
      mock.cleanCount = count;
      const useCase = new ManageWorktreeUseCase(mock);
      const result = await useCase.clean({ workspaceDir: '/repo', dryRun: true });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, shape);
      assert.strictEqual(result.data?.count, count);
    });
  }

  for (const [count, shape] of [
    [0, 'Cleaned 0 orphaned worktree(s) and metadata lock(s).'],
    [1, 'Cleaned 1 orphaned worktree(s) and metadata lock(s).'],
    [4, 'Cleaned 4 orphaned worktree(s) and metadata lock(s).']
  ] as const) {
    test(`real-run count ${count} keeps its exact wording`, async () => {
      const mock = new MockWorktreeManager();
      mock.cleanCount = count;
      const useCase = new ManageWorktreeUseCase(mock);
      const result = await useCase.clean({ workspaceDir: '/repo' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, shape);
      assert.strictEqual(result.data?.count, count);
    });
  }
});
