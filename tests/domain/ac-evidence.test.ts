/**
 * agyloop - AC evidence value object (issue #432, TR-32)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseAcEvidence,
  classifyAcEvidence,
  findExcludedEvidenceInText
} = require('../../dist/domain');

const VERDICT = [
  'REVIEW_STATUS: APPROVED',
  'REVIEW_SUMMARY: ok',
  'AC_EVIDENCE:',
  '- AC1: met — `src/domain/plan-deviation.ts`, `tests/domain/plan-deviation.test.ts`',
  '- AC2: unverifiable — `artifacts/plans/425-task-plan/implementation_plan.md`',
  '- AC3: out-of-scope — `docs/legacy.md`'
].join('\n');

describe('AC evidence (issue #432)', () => {
  test('AE1 parses met, unverifiable and out-of-scope', () => {
    const report = parseAcEvidence(VERDICT);
    assert.strictEqual(report.reported, true);
    assert.deepStrictEqual(
      report.entries.map((entry: any) => entry.status),
      ['met', 'unverifiable', 'out-of-scope']
    );
    assert.deepStrictEqual([...report.entries[0].paths], [
      'src/domain/plan-deviation.ts',
      'tests/domain/plan-deviation.test.ts'
    ]);
  });

  test('AE2 classifies excluded, unchanged and delivered paths', () => {
    const report = parseAcEvidence(VERDICT);
    const changeSet = { measured: true, paths: ['src/domain/plan-deviation.ts'] };

    const met = classifyAcEvidence(report.entries[0], changeSet, '/repo');
    assert.strictEqual(met.status, 'unverifiable');
    assert.ok(met.unverifiablePaths.includes('tests/domain/plan-deviation.test.ts'));

    const excluded = classifyAcEvidence(report.entries[1], changeSet, '/repo');
    assert.strictEqual(excluded.status, 'unverifiable');
    assert.ok(
      excluded.unverifiablePaths.includes('artifacts/plans/425-task-plan/implementation_plan.md')
    );

    const outOfScope = classifyAcEvidence(report.entries[2], changeSet, '/repo');
    assert.strictEqual(outOfScope.status, 'out-of-scope');
  });

  test('AE3 the backstop sweep names an excluded path anywhere in the verdict', () => {
    const found = findExcludedEvidenceInText(
      'Tier 2: the #425 plan risk row now reads the corrected premise (`artifacts/plans/425-task-plan/implementation_plan.md`).'
    );
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].path, 'artifacts/plans/425-task-plan/implementation_plan.md');
  });

  test('AE4 an absent block is unreported (legacy verdict)', () => {
    assert.deepStrictEqual(parseAcEvidence('REVIEW_STATUS: APPROVED\n'), {
      reported: false,
      entries: []
    });
  });
});
