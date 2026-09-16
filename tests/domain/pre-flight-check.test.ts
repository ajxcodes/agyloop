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
});
