/**
 * agyloop - Two-tier invariant: content-aware blocking (issue #349 AC1/AC3)
 *
 * The invariant escalated whenever `blockingCount() > 0`, and a finding was
 * blocking iff its severity was `critical`/`error`. A model that mislabelled an
 * AFFIRMATION as `critical` therefore reverted an otherwise-`APPROVED` verdict.
 *
 * T1 - a critical affirmation does not escalate an APPROVED verdict (AC1)
 * T2 - a genuine defect still escalates (AC1, other direction)
 * T3 - the escalation count is accurate and the ignored count is named (AC3)
 * T4 - affirmations never UPGRADE a reviewer's CHANGES_REQUESTED
 * T5 - a bypassed report still never escalates (N5 regression)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { applyTwoTierInvariant } = require('../../dist/application');
const {
  AiReviewFinding,
  AiReviewReport,
  ReviewConfidence,
  ReviewVerdict,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  VERDICT_SKIPPED
} = require('../../dist/domain');

const AFFIRMATION_BODY = 'Correctly pins actions/checkout@v7 and actions/setup-node@v7.';
const DEFECT_BODY = 'Null pointer dereference on an empty payload.';

function finding(severity: string, body: string, line = 10, path = 'src/app.ts') {
  return new AiReviewFinding({ path, line, severity, body });
}

function report(findings: any, bypassed = false) {
  return new AiReviewReport({
    summary: 'critique summary',
    confidence: ReviewConfidence.high('static scan'),
    findings,
    bypassed
  });
}

function reviewerVerdict(status = VERDICT_APPROVED) {
  return new ReviewVerdict({
    status,
    summary: 'reviewer summary',
    confidenceLevel: 'High'
  });
}

describe('applyTwoTierInvariant - content-aware blocking (issue #349)', () => {
  test('T1: a critical affirmation does not escalate an APPROVED verdict (AC1)', () => {
    const verdict = reviewerVerdict();
    const outcome = applyTwoTierInvariant(verdict, report([finding('critical', AFFIRMATION_BODY)]));

    assert.strictEqual(outcome.escalatedBy, null);
    assert.strictEqual(outcome.verdict.status, VERDICT_APPROVED);
    // The very same object: nothing was rebuilt, so nothing can drift.
    assert.strictEqual(outcome.verdict, verdict);
  });

  test('T2: a genuine defect still escalates (AC1, other direction)', () => {
    const outcome = applyTwoTierInvariant(reviewerVerdict(), report([finding('error', DEFECT_BODY)]));

    assert.strictEqual(outcome.escalatedBy, 'critique');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(
      outcome.verdict.summary.includes('detected 1 blocking/error violation(s)'),
      outcome.verdict.summary
    );
    assert.strictEqual(outcome.verdict.unfulfilledCriteria.length, 1);
    assert.ok(outcome.verdict.unfulfilledCriteria[0].includes(DEFECT_BODY));
  });

  test('T3: the count is accurate and the ignored affirmations are named (AC3)', () => {
    const outcome = applyTwoTierInvariant(
      reviewerVerdict(),
      report([
        finding('error', DEFECT_BODY, 42, 'src/db.ts'),
        finding('critical', AFFIRMATION_BODY, 10, 'src/app.ts'),
        finding('error', 'Correctly handles the empty payload.', 11, 'src/app.ts')
      ])
    );

    assert.strictEqual(outcome.escalatedBy, 'critique');
    assert.ok(
      outcome.verdict.summary.includes('detected 1 blocking/error violation(s)'),
      `the count must be 1, got: ${outcome.verdict.summary}`
    );
    assert.ok(
      !outcome.verdict.summary.includes('detected 3'),
      `the content-blind count is back: ${outcome.verdict.summary}`
    );
    assert.ok(outcome.verdict.summary.includes('Ignored 2'), outcome.verdict.summary);
    assert.strictEqual(outcome.verdict.unfulfilledCriteria.length, 1);
    assert.ok(outcome.verdict.unfulfilledCriteria[0].includes('src/db.ts:42'));
    // An affirmation is never written into remediation.
    assert.ok(
      !outcome.verdict.remediationGuidance.some((line: string) => line.includes(AFFIRMATION_BODY)),
      outcome.verdict.remediationGuidance.join('\n')
    );
  });

  test('T4: affirmations never upgrade a reviewer CHANGES_REQUESTED', () => {
    const verdict = reviewerVerdict(VERDICT_CHANGES_REQUESTED);
    const outcome = applyTwoTierInvariant(verdict, report([finding('critical', AFFIRMATION_BODY)]));

    assert.strictEqual(outcome.escalatedBy, null);
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(outcome.verdict, verdict);
  });

  test('T5: a bypassed report with a stray critical finding never escalates (N5)', () => {
    const verdict = new ReviewVerdict({
      status: VERDICT_SKIPPED,
      summary: 'critique did not run',
      confidenceLevel: 'Low'
    });
    const outcome = applyTwoTierInvariant(verdict, report([finding('critical', DEFECT_BODY)], true));

    assert.strictEqual(outcome.escalatedBy, null);
    assert.strictEqual(outcome.verdict, verdict);
  });
});
