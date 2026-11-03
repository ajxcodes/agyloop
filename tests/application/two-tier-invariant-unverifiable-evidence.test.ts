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

const DECLARATION =
  "Opening the real `phase/6-codeloop` PR during this run. AC4's label provisioning is an operator step (Step 11).";

function textOf(outcome: any): string {
  return [
    outcome.verdict.summary,
    ...outcome.verdict.unfulfilledCriteria,
    ...outcome.verdict.remediationGuidance
  ].join('\n');
}

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

  test('TUE4 a plan-declared operator-step AC is refused with a diagnostic naming out-of-scope and the declaration (#506 AC2)', () => {
    const outcome = applyTwoTierInvariant(
      approved(),
      null,
      undefined,
      ['AC4 — `ajxcodes/agyloop`'],
      [DECLARATION]
    );
    assert.strictEqual(outcome.escalatedBy, 'unverifiable-evidence');
    const text = textOf(outcome);
    assert.ok(text.includes('out-of-scope'), text);
    assert.ok(text.includes(DECLARATION), text);
  });

  test('TUE5 an undeclared or bare-path gap keeps the pre-#506 diagnostic (#506 AC2)', () => {
    const undeclared = applyTwoTierInvariant(
      approved(),
      null,
      undefined,
      ['AC4 — `ajxcodes/agyloop`'],
      []
    );
    assert.strictEqual(undeclared.escalatedBy, 'unverifiable-evidence');
    assert.ok(!textOf(undeclared).includes('out-of-scope'), textOf(undeclared));

    const barePath = applyTwoTierInvariant(
      approved(),
      null,
      undefined,
      ['src/domain/missing.ts'],
      [DECLARATION]
    );
    assert.strictEqual(barePath.escalatedBy, 'unverifiable-evidence');
    assert.ok(!textOf(barePath).includes('out-of-scope'), textOf(barePath));
  });
});
