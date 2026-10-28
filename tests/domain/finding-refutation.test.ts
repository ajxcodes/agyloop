/**
 * agyloop - Operator refutations (issue #349 / #242 AC4)
 *
 * `--refute '<path>:<line>[#<severity>]=<reason>'` is the ONLY mechanism that
 * can release a FACTUAL false claim: "actions/checkout@v7 does not exist"
 * genuinely requests a change, so content-aware blocking will never exempt it.
 *
 * P1-P7  - parsing (reason mandatory, first `=` wins, last `:`/`#` split)
 * X1-X11 - resolution against a report (deterministic targeting, fail closed,
 *          never silent, ordered consumption)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  AiReviewFinding,
  AiReviewReport,
  ReviewConfidence,
  FindingRefutation,
  resolveFindingRefutations,
  ValidationError,
  NOTE_REFUTATION_ALREADY_NON_BLOCKING,
  NOTE_REFUTATION_ALREADY_REFUTED,
  NOTE_REFUTATION_AMBIGUOUS,
  NOTE_REFUTATION_NO_MATCH,
  NOTE_REFUTATION_NO_REPORT,
  NOTE_REFUTATION_SEVERITY_MISMATCH
} = require('../../dist/domain');

function finding(props: any) {
  return new AiReviewFinding(props);
}

function report(findings: any, bypassed = false) {
  return new AiReviewReport({
    summary: 'critique summary',
    confidence: ReviewConfidence.high('static scan'),
    findings,
    bypassed
  });
}

/** The literal prefix of a refusal constant (everything before its first placeholder). */
function head(constant: string) {
  return constant.split('{')[0];
}

function assertUses(refusal: string, constant: string) {
  assert.ok(
    refusal.startsWith(head(constant)),
    `expected the refusal to start with ${JSON.stringify(head(constant))}, got: ${refusal}`
  );
}

const V7_BODY = 'actions/checkout@v7 does not exist. Revert to @v4.';

describe('FindingRefutation.parse (issue #349 AC4.1)', () => {
  test('P1: a bare location parses into path/line and a null severity', () => {
    const refutation = FindingRefutation.parse('src/app.ts:10=tag v7 exists');

    assert.strictEqual(refutation.path, 'src/app.ts');
    assert.strictEqual(refutation.line, 10);
    assert.strictEqual(refutation.severity, null);
    assert.strictEqual(refutation.reason, 'tag v7 exists');
    assert.strictEqual(refutation.target, 'src/app.ts:10');
    assert.ok(Object.isFrozen(refutation));
  });

  test('P2: a #severity selector is normalised into the target', () => {
    const refutation = FindingRefutation.parse('src/app.ts:10#error=tag v7 exists');

    assert.strictEqual(refutation.severity, 'error');
    assert.strictEqual(refutation.target, 'src/app.ts:10#error');
    assert.strictEqual(FindingRefutation.parse('src/app.ts:10#critical=x').target, 'src/app.ts:10#critical');
  });

  test('P3: a token with no "=" is refused (the reason is mandatory)', () => {
    assert.throws(
      () => FindingRefutation.parse('src/app.ts:10'),
      (err: any) => err instanceof ValidationError && /reason/i.test(err.message)
    );
  });

  test('P4: an empty or whitespace-only reason is refused', () => {
    for (const spec of ['src/app.ts:10=', 'src/app.ts:10=   ']) {
      assert.throws(
        () => FindingRefutation.parse(spec),
        (err: any) => err instanceof ValidationError && /reason/i.test(err.message),
        spec
      );
    }
  });

  test('P5: a malformed location is refused', () => {
    for (const spec of [
      'src/app.ts=reason',
      'src/app.ts:abc=reason',
      ':10=reason',
      'src/app.ts:-1=reason'
    ]) {
      assert.throws(() => FindingRefutation.parse(spec), ValidationError, spec);
    }
  });

  test('P6: only the two blocking severities may narrow a target', () => {
    for (const spec of ['src/app.ts:10#fatal=reason', 'src/app.ts:10#warning=reason']) {
      assert.throws(() => FindingRefutation.parse(spec), ValidationError, spec);
    }
  });

  test('P7: the reason may contain every "=" after the first', () => {
    const refutation = FindingRefutation.parse('src/a.ts:1=v7 exists (tag == 2026-07-20)=yes');

    assert.strictEqual(refutation.path, 'src/a.ts');
    assert.strictEqual(refutation.line, 1);
    assert.strictEqual(refutation.reason, 'v7 exists (tag == 2026-07-20)=yes');
  });
});

describe('resolveFindingRefutations (issue #349 AC4.2/AC4.3/AC4.4)', () => {
  test('X1: an exact target refutes one finding and names it (AC4.4)', () => {
    const resolution = resolveFindingRefutations(report([finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY })]), [
      FindingRefutation.parse('src/app.ts:10#error=actions/checkout@v7 exists (v7.0.1)')
    ]);

    assert.strictEqual(resolution.refusals.length, 0);
    assert.strictEqual(resolution.applied.length, 1);
    const applied = resolution.applied[0];
    assert.strictEqual(applied.target, 'src/app.ts:10#error');
    assert.strictEqual(applied.path, 'src/app.ts');
    assert.strictEqual(applied.line, 10);
    assert.strictEqual(applied.severity, 'error');
    assert.strictEqual(applied.actionability, 'change-request');
    assert.strictEqual(applied.bodyExcerpt, V7_BODY);
    assert.strictEqual(applied.reason, 'actions/checkout@v7 exists (v7.0.1)');
    assert.strictEqual(applied.findingIndex, 0);
    assert.strictEqual(resolution.remaining.length, 0);
    assert.ok(Object.isFrozen(resolution.applied));
    assert.ok(Object.isFrozen(resolution.remaining));
    assert.ok(Object.isFrozen(applied));
  });

  test('X2: an ambiguous path:line is refused and names both severities (AC4.2)', () => {
    const ambiguous = report([
      finding({
        path: 'src/db.ts',
        line: 42,
        severity: 'critical',
        body: 'Null pointer dereference when the row is absent.'
      }),
      finding({
        path: 'src/db.ts',
        line: 42,
        severity: 'error',
        body: 'The retry loop leaks a timer.'
      })
    ]);

    const resolution = resolveFindingRefutations(ambiguous, [FindingRefutation.parse('src/db.ts:42=v7 exists')]);

    assert.strictEqual(resolution.applied.length, 0);
    assert.strictEqual(resolution.refusals.length, 1);
    assertUses(resolution.refusals[0], NOTE_REFUTATION_AMBIGUOUS);
    assert.ok(resolution.refusals[0].includes('2 blocking findings'), resolution.refusals[0]);
    assert.ok(resolution.refusals[0].includes('critical'), resolution.refusals[0]);
    assert.ok(resolution.refusals[0].includes('error'), resolution.refusals[0]);
    assert.ok(resolution.refusals[0].includes('#critical='), resolution.refusals[0]);
    assert.strictEqual(resolution.remaining.length, 2);
  });

  test('X3: the #severity selector disambiguates a shared location', () => {
    const ambiguous = report([
      finding({
        path: 'src/db.ts',
        line: 42,
        severity: 'critical',
        body: 'Null pointer dereference when the row is absent.'
      }),
      finding({
        path: 'src/db.ts',
        line: 42,
        severity: 'error',
        body: 'The retry loop leaks a timer.'
      })
    ]);

    const resolution = resolveFindingRefutations(ambiguous, [FindingRefutation.parse('src/db.ts:42#error=fixed')]);

    assert.strictEqual(resolution.refusals.length, 0);
    assert.strictEqual(resolution.applied.length, 1);
    assert.strictEqual(resolution.applied[0].severity, 'error');
    assert.strictEqual(resolution.remaining.length, 1);
    assert.strictEqual(resolution.remaining[0].severity, 'critical');
  });

  test('X4: an affirmation is already non-blocking and cannot be refuted (AC4.3)', () => {
    const resolution = resolveFindingRefutations(
      report([
        finding({
          path: 'src/app.ts',
          line: 10,
          severity: 'critical',
          body: 'Correctly pins actions/checkout@v7.'
        })
      ]),
      [FindingRefutation.parse('src/app.ts:10=not needed')]
    );

    assert.strictEqual(resolution.applied.length, 0);
    assert.strictEqual(resolution.refusals.length, 1);
    assertUses(resolution.refusals[0], NOTE_REFUTATION_ALREADY_NON_BLOCKING);
  });

  test('X5: a warning at the target location is not a blocking finding', () => {
    const resolution = resolveFindingRefutations(
      report([finding({ path: 'src/app.ts', line: 10, severity: 'warning', body: 'Consider renaming this.' })]),
      [FindingRefutation.parse('src/app.ts:10=v7 exists')]
    );

    assert.strictEqual(resolution.applied.length, 0);
    assertUses(resolution.refusals[0], NOTE_REFUTATION_NO_MATCH);
  });

  test('X6: an unknown path/line matches nothing and is refused (AC4.3)', () => {
    const resolution = resolveFindingRefutations(
      report([finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY })]),
      [FindingRefutation.parse('src/missing.ts:1=v7 exists')]
    );

    assert.strictEqual(resolution.applied.length, 0);
    assert.strictEqual(resolution.remaining.length, 1);
    assertUses(resolution.refusals[0], NOTE_REFUTATION_NO_MATCH);
    assert.ok(resolution.refusals[0].includes('src/missing.ts:1'), resolution.refusals[0]);
  });

  test('X7: two refutations cannot consume the same finding', () => {
    const resolution = resolveFindingRefutations(
      report([finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY })]),
      [FindingRefutation.parse('src/app.ts:10=first'), FindingRefutation.parse('src/app.ts:10#error=second')]
    );

    assert.strictEqual(resolution.applied.length, 1);
    assert.strictEqual(resolution.applied[0].reason, 'first');
    assert.strictEqual(resolution.refusals.length, 1);
    assertUses(resolution.refusals[0], NOTE_REFUTATION_ALREADY_REFUTED);
  });

  test('X8: no report refuses every refutation', () => {
    const resolution = resolveFindingRefutations(null, [FindingRefutation.parse('src/app.ts:10=v7 exists')]);

    assert.strictEqual(resolution.applied.length, 0);
    assert.strictEqual(resolution.remaining.length, 0);
    assertUses(resolution.refusals[0], NOTE_REFUTATION_NO_REPORT);
  });

  test('X9: a bypassed report refuses every refutation', () => {
    const resolution = resolveFindingRefutations(
      report([finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY })], true),
      [FindingRefutation.parse('src/app.ts:10=v7 exists')]
    );

    assertUses(resolution.refusals[0], NOTE_REFUTATION_NO_REPORT);
  });

  test('X10: an ambiguous-classified finding IS refutable', () => {
    const resolution = resolveFindingRefutations(
      report([finding({ path: 'src/app.ts', line: 10, severity: 'critical', body: 'actions/setup-node@v7' })]),
      [FindingRefutation.parse('src/app.ts:10=v7 exists')]
    );

    assert.strictEqual(resolution.refusals.length, 0);
    assert.strictEqual(resolution.applied.length, 1);
    assert.strictEqual(resolution.applied[0].actionability, 'ambiguous');
    assert.strictEqual(resolution.remaining.length, 0);
  });

  test('X11: a wrong #severity names the actual severity and the corrected target', () => {
    const resolution = resolveFindingRefutations(
      report([finding({ path: 'src/db.ts', line: 42, severity: 'error', body: 'The retry loop leaks a timer.' })]),
      [FindingRefutation.parse('src/db.ts:42#critical=fixed')]
    );

    assert.strictEqual(resolution.applied.length, 0);
    assert.strictEqual(resolution.remaining.length, 1);
    assertUses(resolution.refusals[0], NOTE_REFUTATION_SEVERITY_MISMATCH);
    assert.ok(resolution.refusals[0].includes("'error'"), resolution.refusals[0]);
    assert.ok(resolution.refusals[0].includes('src/db.ts:42#error'), resolution.refusals[0]);
  });

  test('X12: no refutations is a no-op that still reports the blocking set', () => {
    const resolution = resolveFindingRefutations(
      report([finding({ path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY })]),
      []
    );

    assert.deepStrictEqual([...resolution.applied], []);
    assert.deepStrictEqual([...resolution.refusals], []);
    assert.strictEqual(resolution.remaining.length, 1);
    assert.strictEqual(resolution.blocking.length, 1);
  });
});
