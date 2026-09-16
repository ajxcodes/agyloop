/**
 * agyloop - BranchInferenceEngine Value Object Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  BranchInferenceEngine,
  MilestoneSealedError,
  DEFAULT_MAIN_BRANCH,
  DEFAULT_TASK_BRANCH_PREFIX,
  DEFAULT_FIX_BRANCH_PREFIX,
  DEFAULT_PHASE_BRANCH_PREFIX
} = require('../../dist/domain');

describe('BranchInferenceEngine Value Object', () => {
  test('infers phase collector branch from phase label (e.g. phase:1)', () => {
    const result = BranchInferenceEngine.inferBaseBranch({
      labels: ['phase:1', 'enhancement'],
      title: 'Implement bridge architecture',
      issueNumber: '88',
      existingBranches: ['main', 'phase/1-bridge-arch']
    });

    assert.strictEqual(result.baseBranch, 'phase/1-bridge-arch');
    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.autoCreateBaseBranch, false);
    assert.strictEqual(result.branchType, 'task');
    assert.strictEqual(result.suggestedTaskBranch, 'task/88-implement-bridge-architecture');
  });

  test('infers phase collector branch from title regex fallback [Phase 1]', () => {
    const result = BranchInferenceEngine.inferBaseBranch({
      labels: [],
      title: '[Phase 1] Setup Core Storage',
      issueNumber: '42',
      existingBranches: ['main', 'phase/1-setup-core-storage']
    });

    assert.strictEqual(result.baseBranch, 'phase/1-setup-core-storage');
    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.autoCreateBaseBranch, false);
  });

  test('flags autoCreateBaseBranch = true when collector branch does not exist yet', () => {
    const result = BranchInferenceEngine.inferBaseBranch({
      labels: ['phase:2'],
      title: 'Phase 2: Add Realtime WebSockets',
      issueNumber: '50',
      existingBranches: ['main']
    });

    assert.strictEqual(result.baseBranch, 'phase/2-phase-2-add-realtime-websockets');
    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.autoCreateBaseBranch, true);
  });

  test('routes bug against unmerged collector branch to fix/ prefix targeting collector branch', () => {
    const result = BranchInferenceEngine.inferBaseBranch({
      labels: ['bug', 'phase:1'],
      title: 'Fix bridge timeout on reconnect',
      issueNumber: '92',
      existingBranches: ['main', 'phase/1-bridge-arch'],
      isAncestorOfMain: () => false // phase/1 is not merged into main
    });

    assert.strictEqual(result.baseBranch, 'phase/1-bridge-arch');
    assert.strictEqual(result.isCollectorBranch, true);
    assert.strictEqual(result.branchType, 'fix');
    assert.strictEqual(result.suggestedTaskBranch, 'fix/92-fix-bridge-timeout-on-reconnect');
  });

  test('routes bug against already merged collector branch as production hotfix targeting main', () => {
    const result = BranchInferenceEngine.inferBaseBranch({
      labels: ['bug', 'phase:1'],
      title: 'Fix crash in production bridge',
      issueNumber: '95',
      existingBranches: ['main', 'phase/1-bridge-arch'],
      isAncestorOfMain: (branch: string) => branch === 'phase/1-bridge-arch' // already merged
    });

    assert.strictEqual(result.baseBranch, 'main');
    assert.strictEqual(result.isCollectorBranch, false);
    assert.strictEqual(result.branchType, 'fix');
    assert.strictEqual(result.suggestedTaskBranch, 'fix/95-fix-crash-in-production-bridge');
  });

  test('throws MilestoneSealedError when normal feature task is filed against an already merged phase', () => {
    assert.throws(
      () =>
        BranchInferenceEngine.inferBaseBranch({
          labels: ['phase:1', 'feature'],
          title: 'Add new bridge protocol',
          issueNumber: '99',
          existingBranches: ['main', 'phase/1-bridge-arch'],
          isAncestorOfMain: (branch: string) => branch === 'phase/1-bridge-arch'
        }),
      (err: any) => {
        assert(err instanceof MilestoneSealedError);
        assert(err.message.includes('has already been merged into main'));
        return true;
      }
    );
  });

  test('falls back cleanly to main when no phase or feature label/title is present', () => {
    const result = BranchInferenceEngine.inferBaseBranch({
      labels: ['chore'],
      title: 'Update readme and badges',
      issueNumber: '10',
      existingBranches: ['main']
    });

    assert.strictEqual(result.baseBranch, 'main');
    assert.strictEqual(result.isCollectorBranch, false);
    assert.strictEqual(result.autoCreateBaseBranch, false);
    assert.strictEqual(result.branchType, 'task');
    assert.strictEqual(result.suggestedTaskBranch, 'task/10-update-readme-and-badges');
  });

  test('suggests fix/ prefix for bugs even when targeting main', () => {
    const result = BranchInferenceEngine.inferBaseBranch({
      labels: ['bug'],
      title: 'Null pointer exception on startup',
      issueNumber: '11',
      existingBranches: ['main']
    });

    assert.strictEqual(result.baseBranch, 'main');
    assert.strictEqual(result.branchType, 'fix');
    assert.strictEqual(result.suggestedTaskBranch, 'fix/11-null-pointer-exception-on-startup');
  });
});
