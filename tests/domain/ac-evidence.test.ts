/**
 * agyloop - AC evidence value object (issue #432, TR-32)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseAcEvidence,
  classifyAcEvidence
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

  test('AE9 the block parser ignores prose and bullets outside AC_EVIDENCE (issue #449)', () => {
    const report = parseAcEvidence(
      [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: the report is at `.agyloop/critique/445.json`',
        'AC_EVIDENCE:',
        '- AC1: met — `src/x.ts`',
        'CRITIQUE_REPORT: `.agyloop/critique/445.json`',
        '- AC2: met — `.agyloop/critique/445.json`'
      ].join('\n')
    );
    assert.deepStrictEqual(
      report.entries.map((entry: any) => entry.ac),
      ['AC1']
    );
  });

  test('AE10 a backticked literal beside delivered paths is note text, not evidence (issue #464)', () => {
    const report = parseAcEvidence(
      [
        'AC_EVIDENCE:',
        '- AC1: met — `src/app.ts`, `tests/app.test.ts` (SCD1 records `protocol-not-declared`)'
      ].join('\n')
    );
    const entry = report.entries[0];
    assert.deepStrictEqual([...entry.paths], ['src/app.ts', 'tests/app.test.ts']);
    assert.strictEqual(entry.note, '(SCD1 records `protocol-not-declared`)');

    const met = classifyAcEvidence(
      entry,
      { measured: true, paths: ['src/app.ts', 'tests/app.test.ts'] },
      process.cwd()
    );
    assert.strictEqual(met.status, 'met');
    assert.deepStrictEqual([...met.unverifiablePaths], []);
  });

  test('AE11 a backticked path-shaped citation absent from the set still escalates, naming it (issue #464)', () => {
    const report = parseAcEvidence(
      'AC_EVIDENCE:\n- AC1: met — `src/domain/missing.ts:42`'
    );
    const classified = classifyAcEvidence(
      report.entries[0],
      { measured: true, paths: ['src/app.ts'] },
      process.cwd()
    );
    assert.strictEqual(classified.status, 'unverifiable');
    assert.deepStrictEqual([...classified.unverifiablePaths], ['src/domain/missing.ts:42']);
  });

  test('AE12 a backticked commit-excluded path still escalates (issue #464)', () => {
    const report = parseAcEvidence(
      [
        'AC_EVIDENCE:',
        '- AC1: met — `artifacts/plans/464-task-plan/implementation_plan.md`',
        '- AC2: met — `.agyloop/critique/464.json`',
        '- AC3: met — `node_modules/left-pad/index.js`'
      ].join('\n')
    );
    const changeSet = { measured: true, paths: [] as string[] };
    for (const entry of report.entries) {
      const classified = classifyAcEvidence(entry, changeSet, process.cwd());
      assert.strictEqual(classified.status, 'unverifiable');
      assert.deepStrictEqual([...classified.unverifiablePaths], [...entry.paths]);
    }
  });

  test('AE13 shell fragments, flags and identifiers in backticks are never evidence (issue #464)', () => {
    const report = parseAcEvidence(
      'AC_EVIDENCE:\n- AC1: met — `src/app.ts`; literals: `--workspace`, `--help`, `--version`, `mktemp -d "$SANDBOX/smoke-464"`, `executable: true`, `AC4`'
    );
    assert.deepStrictEqual([...report.entries[0].paths], ['src/app.ts']);
    const met = classifyAcEvidence(
      report.entries[0],
      { measured: true, paths: ['src/app.ts'] },
      process.cwd()
    );
    assert.strictEqual(met.status, 'met');
  });
});
