/**
 * agyloop - gate target coverage (issue #408, D2)
 *
 * A `PASSED` gate report certifies the plan's declared `### Quality Gate
 * Targets`: this matcher is the ONE place that decides whether the report's
 * executed commands actually cover them. The defects it guards:
 *
 *  - a one-command PASSED block certified a four-command plan (lint included);
 *  - a smoke-check LABEL could stand in for a command (#325 AC-17);
 *  - a legacy block carries commands only in `commandResults`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { assessGateTargetCoverage } = require('../../dist/domain');

const FOUR_TARGETS = ['npm run build', 'npm run typecheck', 'npm run lint', 'npm test'];

/** The report fields coverage is decided from. */
function report(executed: string[], results: Array<{ command: string }> = []) {
  return { executedCommands: executed, commandResults: results };
}

describe('assessGateTargetCoverage (issue #408)', () => {
  test('T-COV-1: full coverage passes and reports nothing missing', () => {
    const coverage = assessGateTargetCoverage(FOUR_TARGETS, report(FOUR_TARGETS));

    assert.strictEqual(coverage.covered, true);
    assert.deepStrictEqual(coverage.missing, []);
    assert.strictEqual(coverage.declared.length, 4);
  });

  test('T-COV-2: one missing command is named', () => {
    const coverage = assessGateTargetCoverage(
      FOUR_TARGETS,
      report(['npm run build', 'npm run typecheck', 'npm test'])
    );

    assert.strictEqual(coverage.covered, false);
    assert.deepStrictEqual(coverage.missing, ['npm run lint']);
  });

  test('T-COV-3: empty evidence misses every target IN PLAN ORDER', () => {
    const coverage = assessGateTargetCoverage(FOUR_TARGETS, report([]));

    assert.strictEqual(coverage.covered, false);
    assert.deepStrictEqual(coverage.missing, FOUR_TARGETS);
  });

  test('T-COV-4: a plan with no declared targets is trivially covered', () => {
    const coverage = assessGateTargetCoverage([], report([]));

    assert.strictEqual(coverage.covered, true);
    assert.deepStrictEqual(coverage.missing, []);
  });

  test('T-COV-5: a smoke-check label is not a command (#325 AC-17)', () => {
    const coverage = assessGateTargetCoverage(
      ['npm run lint'],
      report(['smoke-check-1: lint PASSED'])
    );

    assert.deepStrictEqual(coverage.missing, ['npm run lint']);
  });

  test('T-COV-6: the full suite covers a targeted test command', () => {
    const coverage = assessGateTargetCoverage(
      ['node --test tests/a.test.ts'],
      report(['npm test'])
    );

    assert.strictEqual(coverage.covered, true);
  });

  test('T-COV-7: commandResults-only evidence still covers', () => {
    const coverage = assessGateTargetCoverage(
      ['npm run build'],
      report([], [{ command: 'npm run build' }])
    );

    assert.strictEqual(coverage.covered, true);
  });

  test('T-COV-8: commands are compared after normalisation', () => {
    const coverage = assessGateTargetCoverage(['npm  run build'], report([' NPM RUN BUILD ']));

    assert.strictEqual(coverage.covered, true);
  });

  test('T-COV-9: duplicate and blank entries are deduped', () => {
    const coverage = assessGateTargetCoverage(
      ['npm run build', '  ', 'npm run build'],
      report(['npm test', 'npm test', ''])
    );

    assert.deepStrictEqual(coverage.declared, ['npm run build']);
    assert.deepStrictEqual(coverage.executed, ['npm test']);
  });
});
