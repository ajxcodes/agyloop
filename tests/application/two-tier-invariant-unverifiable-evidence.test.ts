/**
 * agyloop - Two-tier invariant: delivered AC evidence (issue #464)
 *
 * A backticked literal in an AC_EVIDENCE entry is note text, not evidence, so
 * the list `applyTwoTierInvariant` receives stays empty and an APPROVED verdict
 * is not rewritten. A genuine path-shaped gap must still escalate.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { applyTwoTierInvariant } = require('../../dist/application');
const {
  ReviewVerdict,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  classifyAcEvidence,
  parseAcEvidence
} = require('../../dist/domain');

const CHANGE_SET = { measured: true, paths: ['src/app.ts', 'tests/app.test.ts'] };

function approved() {
  return new ReviewVerdict({
    status: VERDICT_APPROVED,
    summary: 'reviewer summary',
    confidenceLevel: 'High'
  });
}

function unverifiableFor(block: string): string[] {
  const entry = parseAcEvidence(block).entries[0];
  const classified = classifyAcEvidence(entry, CHANGE_SET, process.cwd());
  return [...classified.unverifiablePaths];
}

describe('applyTwoTierInvariant - delivered AC evidence (issue #464)', () => {
  test('TUE1 a backticked literal keeps an APPROVED verdict APPROVED (issue #464)', () => {
    const unverifiable = unverifiableFor(
      'AC_EVIDENCE:\n- AC1: met — `src/app.ts`, `tests/app.test.ts` (SCD1 records `protocol-not-declared`)'
    );
    assert.deepStrictEqual(unverifiable, []);

    const outcome = applyTwoTierInvariant(approved(), null, undefined, unverifiable);
    assert.strictEqual(outcome.escalatedBy, null);
    assert.strictEqual(outcome.verdict.status, VERDICT_APPROVED);
  });

  test('TUE2 a backticked path-shaped file absent from the set still escalates (issue #464)', () => {
    const unverifiable = unverifiableFor('AC_EVIDENCE:\n- AC1: met — `src/domain/missing.ts`');
    assert.deepStrictEqual(unverifiable, ['src/domain/missing.ts']);

    const outcome = applyTwoTierInvariant(approved(), null, undefined, unverifiable);
    assert.strictEqual(outcome.escalatedBy, 'unverifiable-evidence');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(
      outcome.verdict.unfulfilledCriteria.some((criterion: string) =>
        criterion.includes('src/domain/missing.ts')
      )
    );
  });

  test('TUE3 a backticked commit-excluded path still escalates (issue #464)', () => {
    const unverifiable = unverifiableFor(
      'AC_EVIDENCE:\n- AC1: met — `node_modules/left-pad/index.js`'
    );
    assert.deepStrictEqual(unverifiable, ['node_modules/left-pad/index.js']);

    const outcome = applyTwoTierInvariant(approved(), null, undefined, unverifiable);
    assert.strictEqual(outcome.escalatedBy, 'unverifiable-evidence');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
  });
});
