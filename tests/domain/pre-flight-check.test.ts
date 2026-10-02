/**
 * agyloop - PreFlightCheckEngine Value Object Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  PreFlightCheckEngine,
  PREFLIGHT_ACTION_PROCEED,
  PREFLIGHT_ACTION_RESUME,
  PREFLIGHT_ACTION_HALT_CLOSED,
  PREFLIGHT_ACTION_HALT_PR_MERGED
} = require('../../dist/domain');

describe('PreFlightCheckEngine Value Object', () => {
  test('returns HALT_CLOSED when issue state is CLOSED', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'CLOSED',
      issueNumber: '42'
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_HALT_CLOSED);
    assert.strictEqual(check.canProceed, false);
    assert.strictEqual(check.isHalt, true);
    assert.strictEqual(check.isResume, false);
    assert(check.message.includes('Task #42 is already closed.'));
  });

  test('returns HALT_PR_MERGED when associated PR is MERGED', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '42',
      associatedPr: {
        number: 101,
        title: 'Implement Task #42',
        state: 'MERGED',
        baseRefName: 'phase/1-bridge-arch'
      }
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_HALT_PR_MERGED);
    assert.strictEqual(check.canProceed, false);
    assert.strictEqual(check.isHalt, true);
    assert.strictEqual(check.isResume, false);
    assert(check.message.includes('PR for task #42 is already merged into phase/1-bridge-arch.'));
  });

  test('returns RESUME_EXISTING when associated PR is OPEN', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '42',
      associatedPr: {
        number: 102,
        title: 'Work in progress Task #42',
        state: 'OPEN',
        headRefName: 'task/42-feature-spec',
        baseRefName: 'phase/1-bridge-arch'
      }
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_RESUME);
    assert.strictEqual(check.canProceed, true);
    assert.strictEqual(check.isHalt, false);
    assert.strictEqual(check.isResume, true);
    assert.strictEqual(check.existingBranch, 'task/42-feature-spec');
    assert(check.message.includes('Found active PR #102'));
  });

  test('returns RESUME_EXISTING when existing task or fix branch is present locally/remotely', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '88',
      existingBranches: ['main', 'phase/1-bridge', 'task/88-implement-phase-workflow']
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_RESUME);
    assert.strictEqual(check.canProceed, true);
    assert.strictEqual(check.isResume, true);
    assert.strictEqual(check.existingBranch, 'task/88-implement-phase-workflow');
    assert(check.message.includes('Found existing branch task/88-implement-phase-workflow'));
  });

  test('returns RESUME_EXISTING when existing fix branch is present', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '89',
      existingBranches: ['main', 'fix/89-resolve-null-pointer']
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_RESUME);
    assert.strictEqual(check.canProceed, true);
    assert.strictEqual(check.isResume, true);
    assert.strictEqual(check.existingBranch, 'fix/89-resolve-null-pointer');
  });

  test('returns PROCEED for fresh open issue with no branches or PRs', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '99',
      existingBranches: ['main', 'phase/1-bridge']
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_PROCEED);
    assert.strictEqual(check.canProceed, true);
    assert.strictEqual(check.isHalt, false);
    assert.strictEqual(check.isResume, false);
  });

  test('returns PROCEED when issueNumber is null or not provided', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: null
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_PROCEED);
    assert.strictEqual(check.canProceed, true);
  });

  // Conflict detection tests
  test('detects merge conflicts when mergeStateStatus is DIRTY on RESUME', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '49',
      associatedPr: {
        number: 200,
        state: 'OPEN',
        headRefName: 'fix/49-conflict-detection',
        baseRefName: 'main',
        mergeStateStatus: 'DIRTY'
      }
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_RESUME);
    assert.strictEqual(check.hasMergeConflicts, true);
    assert.ok(check.candidateBaseBranch, 'candidateBaseBranch should be set');
    assert.ok(
      check.candidateBaseBranch?.includes('main'),
      `expected candidateBaseBranch to include 'main', got: ${check.candidateBaseBranch}`
    );
  });

  test('detects merge conflicts when mergeable is CONFLICTING on RESUME', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '49',
      associatedPr: {
        number: 201,
        state: 'OPEN',
        headRefName: 'fix/49-conflict-detection',
        baseRefName: 'phase/5-quality',
        mergeable: 'CONFLICTING'
      }
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_RESUME);
    assert.strictEqual(check.hasMergeConflicts, true);
    assert.ok(check.candidateBaseBranch?.includes('phase/5-quality'));
  });

  test('does not flag merge conflicts when mergeStateStatus is CLEAN', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '49',
      associatedPr: {
        number: 202,
        state: 'OPEN',
        headRefName: 'fix/49-no-conflict',
        baseRefName: 'main',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE'
      }
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_RESUME);
    assert.strictEqual(check.hasMergeConflicts, false);
    assert.strictEqual(check.candidateBaseBranch, undefined);
  });

  test('detects merge conflicts on PROCEED path when context flags hasMergeConflicts directly', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '50',
      hasMergeConflicts: true,
      candidateBaseBranch: 'origin/main'
    });

    assert.strictEqual(check.action, PREFLIGHT_ACTION_PROCEED);
    assert.strictEqual(check.hasMergeConflicts, true);
    assert.strictEqual(check.candidateBaseBranch, 'origin/main');
  });

  test('candidateBaseBranch falls back to origin/main when PR has no baseRefName', () => {
    const check = PreFlightCheckEngine.evaluate({
      issueState: 'OPEN',
      issueNumber: '51',
      associatedPr: {
        number: 203,
        state: 'OPEN',
        headRefName: 'fix/51-conflict',
        mergeStateStatus: 'DIRTY'
      }
    });

    assert.strictEqual(check.hasMergeConflicts, true);
    assert.strictEqual(check.candidateBaseBranch, 'origin/main');
  });
});
