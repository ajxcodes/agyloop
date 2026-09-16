/**
 * agyloop - WorktreeDescriptor Value Object Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  WorktreeDescriptor,
  DEFAULT_WORKTREES_DIR,
  DEFAULT_TASK_BRANCH_PREFIX,
  ValidationError,
  WorktreeError,
  WorktreeCreationError,
  WorktreeCleanupError,
  ERR_WORKTREE
} = require('../../dist/domain');

describe('WorktreeDescriptor Value Object', () => {
  test('creates valid WorktreeDescriptor with all required properties', () => {
    const wt = new WorktreeDescriptor({
      taskId: '87',
      worktreePath: '/repo/.worktrees/87',
      branch: 'task/87-git-worktree-isolation',
      baseBranch: 'main'
    });

    assert.strictEqual(wt.taskId, '87');
    assert.strictEqual(wt.worktreePath, '/repo/.worktrees/87');
    assert.strictEqual(wt.branch, 'task/87-git-worktree-isolation');
    assert.strictEqual(wt.baseBranch, 'main');
    assert.strictEqual(wt.slug, 'git-worktree-isolation');
    assert.strictEqual(wt.isIsolated, true);
  });

  test('converts numeric taskId to string cleanly', () => {
    const wt = new WorktreeDescriptor({
      taskId: 87,
      worktreePath: '/repo/.worktrees/87',
      branch: 'task/87-git-worktree-isolation',
      baseBranch: 'main'
    });

    assert.strictEqual(wt.taskId, '87');
  });

  test('rejects blank taskId, worktreePath, branch, or baseBranch', () => {
    assert.throws(
      () =>
        new WorktreeDescriptor({
          taskId: '',
          worktreePath: '/repo/.worktrees/87',
          branch: 'task/87',
          baseBranch: 'main'
        }),
      ValidationError
    );

    assert.throws(
      () =>
        new WorktreeDescriptor({
          taskId: '87',
          worktreePath: '  ',
          branch: 'task/87',
          baseBranch: 'main'
        }),
      ValidationError
    );

    assert.throws(
      () =>
        new WorktreeDescriptor({
          taskId: '87',
          worktreePath: '/repo/.worktrees/87',
          branch: '',
          baseBranch: 'main'
        }),
      ValidationError
    );

    assert.throws(
      () =>
        new WorktreeDescriptor({
          taskId: '87',
          worktreePath: '/repo/.worktrees/87',
          branch: 'task/87',
          baseBranch: ' '
        }),
      ValidationError
    );
  });

  test('slugify transforms title strings into URL and branch-safe slugs', () => {
    assert.strictEqual(
      WorktreeDescriptor.slugify('[Feature] agyloop: Git Worktree Isolation for Parallel Multi-Agent Task Execution'),
      'agyloop-git-worktree-isolation-for-parallel-multi-agent-task-execution'
    );
    assert.strictEqual(
      WorktreeDescriptor.slugify('Fix: Broken .git/index.lock contention!'),
      'fix-broken-git-index-lock-contention'
    );
    assert.strictEqual(WorktreeDescriptor.slugify(''), '');
  });

  test('formatBranchName formats deterministic branch names with prefix', () => {
    const branch1 = WorktreeDescriptor.formatBranchName('87', 'git-worktree-isolation');
    assert.strictEqual(branch1, 'task/87-git-worktree-isolation');

    const branch2 = WorktreeDescriptor.formatBranchName(87, '[Bug] lock collision');
    assert.strictEqual(branch2, 'task/87-lock-collision');

    const branch3 = WorktreeDescriptor.formatBranchName('87');
    assert.strictEqual(branch3, 'task/87');
  });

  test('formatWorktreePath formats standard relative path', () => {
    assert.strictEqual(WorktreeDescriptor.formatWorktreePath('87'), '.worktrees/87');
    assert.strictEqual(WorktreeDescriptor.formatWorktreePath(87, '.custom_worktrees/'), '.custom_worktrees/87');
  });

  test('equals returns true for identical descriptors', () => {
    const wt1 = new WorktreeDescriptor({
      taskId: '87',
      worktreePath: '/repo/.worktrees/87',
      branch: 'task/87',
      baseBranch: 'main'
    });
    const wt2 = new WorktreeDescriptor({
      taskId: '87',
      worktreePath: '/repo/.worktrees/87',
      branch: 'task/87',
      baseBranch: 'main'
    });
    const wt3 = new WorktreeDescriptor({
      taskId: '88',
      worktreePath: '/repo/.worktrees/88',
      branch: 'task/88',
      baseBranch: 'main'
    });

    assert.strictEqual(wt1.equals(wt2), true);
    assert.strictEqual(wt1.equals(wt3), false);
    assert.strictEqual(wt1.equals(null), false);
  });

  test('toJSON serializes descriptor fields cleanly', () => {
    const wt = new WorktreeDescriptor({
      taskId: '87',
      worktreePath: '/repo/.worktrees/87',
      branch: 'task/87-slug',
      baseBranch: 'main',
      slug: 'slug'
    });

    const json = wt.toJSON();
    assert.deepStrictEqual(json, {
      taskId: '87',
      worktreePath: '/repo/.worktrees/87',
      branch: 'task/87-slug',
      baseBranch: 'main',
      slug: 'slug',
      isIsolated: true
    });
  });

  test('Worktree errors preserve codes and cause details', () => {
    const err = new WorktreeCreationError('createWorktree', 'git index lock found', { taskId: '87' });
    assert.strictEqual(err.code, ERR_WORKTREE);
    assert.ok(err.message.includes('git index lock found'));
    assert.ok(err instanceof WorktreeError);

    const cleanupErr = new WorktreeCleanupError('removeWorktree', 'directory busy');
    assert.strictEqual(cleanupErr.code, ERR_WORKTREE);
    assert.ok(cleanupErr instanceof WorktreeError);
  });
});
