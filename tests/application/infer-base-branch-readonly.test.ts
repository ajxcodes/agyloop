/**
 * agyloop - `InferBaseBranchUseCase` must be able to run WITHOUT writing (issue #250)
 *
 * `branch-info` is a diagnostic. It used to reach the checkpoint through TWO
 * hidden writes: the CLI's own "write the inferred issue back" block, and this
 * use case's persistence of the inferred base branch. A read-only command that
 * mutates state is the defect (AC A4), and the mutation was swallowed by the
 * `/tmp` isolation guard — so the behaviour depended on the cwd.
 *
 * The `persist: false` switch is the call-based half of the fix: it is
 * cwd-independent, and it covers the persistence this use case performs even
 * when the CLI's own write-back is already gone.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { InferBaseBranchUseCase } = require('../../dist/application');

/** A worktree manager double that never touches the filesystem. */
function worktreeManagerDouble(): any {
  return {
    resolveBaseBranch: async () => 'main',
    listBranches: async () => [],
    isAncestor: async () => false
  };
}

/** A state repository double that counts every load and save. */
function stateRepoDouble(): any {
  const calls = { load: 0, save: 0 };
  const repo: any = {
    calls,
    load: () => {
      calls.load++;
      return {
        version: '1.0.0',
        currentStage: 'IMPLEMENT',
        mode: 'standard',
        issue: null,
        createdAt: '2026-10-19T09:00:00.000Z',
        updatedAt: '2026-10-19T09:00:00.000Z',
        history: []
      };
    },
    save: () => {
      calls.save++;
    },
    reset: () => undefined,
    getStateFilePath: () => '/repo/.agyloop/state.json'
  };
  return repo;
}

describe('InferBaseBranchUseCase persistence switch (#250)', () => {
  test('persist: false performs NO checkpoint write at all', async () => {
    const stateRepo = stateRepoDouble();
    const useCase = new InferBaseBranchUseCase(worktreeManagerDouble(), undefined, stateRepo);

    const result = await useCase.execute({ issueNumber: 51, persist: false });

    assert.ok(result.baseBranch, 'the inference itself must still be computed');
    assert.strictEqual(stateRepo.calls.save, 0, 'a read-only caller must never save');
    assert.strictEqual(stateRepo.calls.load, 0, 'a read-only caller must not even load');
  });

  test('the default keeps the existing behaviour (the inference IS persisted)', async () => {
    const stateRepo = stateRepoDouble();
    const useCase = new InferBaseBranchUseCase(worktreeManagerDouble(), undefined, stateRepo);

    await useCase.execute({ issueNumber: 51 });

    assert.strictEqual(stateRepo.calls.save, 1, 'every existing caller keeps its behaviour');
  });

  test('persist: false also suppresses the explicit-base-branch write path', async () => {
    const stateRepo = stateRepoDouble();
    const useCase = new InferBaseBranchUseCase(worktreeManagerDouble(), undefined, stateRepo);

    await useCase.execute({ issueNumber: 51, explicitBaseBranch: 'phase/6-codeloop', persist: false });

    assert.strictEqual(stateRepo.calls.save, 0, 'a read-only caller must never save');
    assert.strictEqual(stateRepo.calls.load, 0, 'a read-only caller must not even load');
  });
});
