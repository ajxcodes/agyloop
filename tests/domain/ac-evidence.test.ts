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

  test('AE5 a path:line citation of a delivered file is verified (issue #435)', () => {
    const report = parseAcEvidence(
      'AC_EVIDENCE:\n- AC1: met — `src/domain/constants.ts:42`'
    );
    const met = classifyAcEvidence(
      report.entries[0],
      { measured: true, paths: ['src/domain/constants.ts'] },
      process.cwd()
    );
    assert.strictEqual(met.status, 'met');
    assert.deepStrictEqual([...met.unverifiablePaths], []);
  });

  test('AE6 a line-suffixed excluded or undelivered citation stays unverifiable (issue #435)', () => {
    const changeSet = { measured: true, paths: ['src/domain/constants.ts'] };

    const excluded = classifyAcEvidence(
      parseAcEvidence(
        'AC_EVIDENCE:\n- AC2: met — `artifacts/plans/425-task-plan/implementation_plan.md:162`'
      ).entries[0],
      changeSet,
      process.cwd()
    );
    assert.strictEqual(excluded.status, 'unverifiable');
    assert.deepStrictEqual([...excluded.unverifiablePaths], [
      'artifacts/plans/425-task-plan/implementation_plan.md:162'
    ]);

    const undelivered = classifyAcEvidence(
      parseAcEvidence(
        'AC_EVIDENCE:\n- AC3: met — `src/domain/plan-deviation.ts:10-20`'
      ).entries[0],
      changeSet,
      process.cwd()
    );
    assert.strictEqual(undelivered.status, 'unverifiable');
  });

  test('AE7 a reported block with no parseable entry names every offending line (issue #435)', () => {
    const report = parseAcEvidence('AC_EVIDENCE:\n- AC1 looks good');
    assert.strictEqual(report.reported, true);
    assert.strictEqual(report.entries.length, 0);
    assert.strictEqual(report.issues[0].line, 2);
    assert.ok(report.issues[0].text.includes('AC1 looks good'));
  });

  test('AE8 the exclusion backstop strips a line suffix (issue #435)', () => {
    const found = findExcludedEvidenceInText(
      'Tier 2: the #425 plan risk row now reads the corrected premise (`artifacts/plans/425-task-plan/implementation_plan.md:162`).'
    );
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].path, 'artifacts/plans/425-task-plan/implementation_plan.md:162');
  });
});
