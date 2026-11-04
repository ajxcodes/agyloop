/**
 * agyloop - AC evidence value object (issue #432, TR-32)
 *
 * AE17-AE19 pin issue #473: a backticked git ref (the reviewed base,
 * `origin/main`, a revision range) is prose, never evidence, while a genuine
 * missing path still escalates.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseAcEvidence,
  classifyAcEvidence,
  acLabelOfUnverifiableEntry,
  findOutOfScopeDeclarationForAc
} = require('../../dist/domain');

const DECLARATION =
  "Opening the real `phase/6-codeloop` PR during this run. AC4's label provisioning is an operator step (Step 11).";

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

  test('AE14 the plan-declared operator-step match is label-exact and advisory (#506 AC2)', () => {
    assert.strictEqual(acLabelOfUnverifiableEntry('AC4 — `ajxcodes/agyloop`'), 'AC4');
    assert.strictEqual(acLabelOfUnverifiableEntry('src/domain/missing.ts'), null);
    assert.strictEqual(findOutOfScopeDeclarationForAc('AC4', [DECLARATION]), DECLARATION);
    assert.strictEqual(findOutOfScopeDeclarationForAc('AC4', ['AC40 is a different criterion']), null);
  });

  test('AE15 an out-of-scope entry certifies nothing and escalates nothing, with or without a path (#506 AC3)', () => {
    const changeSet = { measured: true, paths: [] as string[] };
    const withoutPath = parseAcEvidence(
      'AC_EVIDENCE:\n- AC4: out-of-scope — the plan declares Step 11 an operator step'
    ).entries[0];
    const withPath = parseAcEvidence(
      'AC_EVIDENCE:\n- AC4: out-of-scope — `docs/legacy.md`'
    ).entries[0];

    for (const entry of [withoutPath, withPath]) {
      const classified = classifyAcEvidence(entry, changeSet, process.cwd());
      assert.deepStrictEqual([...classified.unverifiablePaths], []);
      assert.strictEqual(classified.status, 'out-of-scope');
    }
  });

  test('AE16 a declaration that merely mentions the AC is not a positive out-of-scope match (#512 AC1)', () => {
    const IN_SCOPE_MENTION =
      'Provisioning `release:*` labels from `codeloop init`. AC1 only requires the release path to provision-or-refuse; a startup validation in unrelated commands would make `status`/`next` depend on GitHub.';
    const IN_SCOPE_SEQUEL =
      'AC1 only requires that the detector sets the shape of verification.gates; it is not deferred.';
    const OPERATOR_STEP = 'AC4 is an operator step performed after the change merges.';

    assert.strictEqual(findOutOfScopeDeclarationForAc('AC1', [IN_SCOPE_MENTION]), null);
    assert.strictEqual(findOutOfScopeDeclarationForAc('AC1', [IN_SCOPE_SEQUEL]), null);
    assert.strictEqual(findOutOfScopeDeclarationForAc('AC4', [OPERATOR_STEP]), OPERATOR_STEP);
    assert.strictEqual(findOutOfScopeDeclarationForAc('AC4', [DECLARATION]), DECLARATION);
    assert.strictEqual(
      findOutOfScopeDeclarationForAc('AC4', ['AC4 is not out of scope; the handler must ship.']),
      null
    );
    assert.strictEqual(
      findOutOfScopeDeclarationForAc('AC1', [IN_SCOPE_MENTION, 'AC1 is an operator step.']),
      'AC1 is an operator step.'
    );
  });

  test('AE17 a backticked branch name beside delivered paths is note text, not evidence (#473 AC1)', () => {
    const report = parseAcEvidence(
      'AC_EVIDENCE:\n- AC1: met — `src/app.ts` (diff vs `phase/6-codeloop`)',
      { knownRefs: ['phase/6-codeloop'] }
    );
    const entry = report.entries[0];
    assert.deepStrictEqual([...report.entries[0].paths], ['src/app.ts']);
    assert.ok(entry.note.includes('`phase/6-codeloop`'), entry.note);
    const classified = classifyAcEvidence(
      entry,
      { measured: true, paths: ['src/app.ts'] },
      process.cwd()
    );
    assert.strictEqual(classified.status, 'met');
  });

  test('AE18 origin/main and revision ranges in backticks are never evidence (#473 AC2)', () => {
    for (const ref of ['origin/main', 'main..phase/6-codeloop', 'HEAD~2', 'main@{upstream}']) {
      const block = 'AC_EVIDENCE:\n- AC1: met — `src/app.ts` (against `' + ref + '`)';
      const withoutRefs = parseAcEvidence(block);
      assert.deepStrictEqual([...withoutRefs.entries[0].paths], ['src/app.ts'], ref);
      const withRefs = parseAcEvidence(block, { knownRefs: ['phase/6-codeloop'] });
      assert.deepStrictEqual([...withRefs.entries[0].paths], ['src/app.ts'], ref);
    }
  });

  test('AE19 a path-shaped citation absent from the delivered set still escalates, naming it (#473 AC3)', () => {
    const changeSet = { measured: true, paths: ['src/app.ts'] };
    const classified = classifyAcEvidence(
      parseAcEvidence('AC_EVIDENCE:\n- AC1: met — `src/domain/missing.ts`').entries[0],
      changeSet,
      process.cwd()
    );
    assert.deepStrictEqual([...classified.unverifiablePaths], ['src/domain/missing.ts']);
    assert.strictEqual(classified.status, 'unverifiable');

    const outside = classifyAcEvidence(
      parseAcEvidence('AC_EVIDENCE:\n- AC1: met — `../outside.ts`').entries[0],
      changeSet,
      process.cwd()
    );
    assert.deepStrictEqual([...outside.unverifiablePaths], ['../outside.ts']);

    assert.deepStrictEqual(
      [...parseAcEvidence('AC_EVIDENCE:\n- AC1: met — `main/index.ts`').entries[0].paths],
      ['main/index.ts']
    );
  });
});
