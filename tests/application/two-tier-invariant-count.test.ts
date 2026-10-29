/**
 * agyloop - Two-tier invariant escalation count (issue #242 / NEW-1)
 *
 * `applyTwoTierInvariant` used to compute
 * `errorCount() + (hasBlockingIssues() ? 1 : 0)`, but `isBlocking()` and
 * `isError()` were the same predicate, so one blocking finding was announced as
 * "2 blocking/error violation(s)" and N findings as "N+1".
 *
 * N1 - one critical finding escalates APPROVED and reports exactly 1
 * N2 - 2 critical + 1 error reports 3, with one criterion per finding
 * N3 - warning/suggestion/info never escalate and never touch the summary
 * N4 - `isError()` / `errorCount()` are aliases of the ONE blocking predicate
 * N5 - a bypassed report carrying a stray critical never escalates (SKIPPED)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { applyTwoTierInvariant } = require('../../dist/application');
const {
  AiReviewReport,
  AiReviewFinding,
  ReviewConfidence,
  ReviewVerdict,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  VERDICT_SKIPPED,
  REVIEW_SEVERITIES
} = require('../../dist/domain');

function finding(severity: string, line: number = 10) {
  return new AiReviewFinding({
    path: 'src/app.ts',
    line,
    severity,
    body: `a ${severity} finding`
  });
}

function report(findings: any[], bypassed: boolean = false) {
  return new AiReviewReport({
    summary: 'critique summary',
    confidence: ReviewConfidence.high('static scan'),
    findings,
    bypassed
  });
}

function approvedVerdict() {
  return new ReviewVerdict({
    status: VERDICT_APPROVED,
    summary: 'reviewer approved',
    confidenceLevel: 'High'
  });
}

describe('applyTwoTierInvariant escalation count', () => {
  test('N1: one critical finding escalates APPROVED and counts exactly once', () => {
    const outcome: any = applyTwoTierInvariant(approvedVerdict(), report([finding('critical')]));

    assert.strictEqual(outcome.escalatedBy, 'critique');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(
      outcome.verdict.summary.includes('detected 1 blocking/error violation(s)'),
      `expected the exact count, got: ${outcome.verdict.summary}`
    );
    assert.ok(
      !outcome.verdict.summary.includes('detected 2'),
      `the N+1 over-count is back: ${outcome.verdict.summary}`
    );
  });

  test('N2: 2 critical + 1 error reports 3 and carries one criterion per finding', () => {
    const outcome: any = applyTwoTierInvariant(
      approvedVerdict(),
      report([finding('critical', 1), finding('critical', 2), finding('error', 3)])
    );

    assert.strictEqual(outcome.escalatedBy, 'critique');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(
      outcome.verdict.summary.includes('detected 3 blocking/error violation(s)'),
      `expected 3, got: ${outcome.verdict.summary}`
    );
    assert.strictEqual(outcome.verdict.unfulfilledCriteria.length, 3);
  });

  test('N3: warning/suggestion/info do not escalate and leave the verdict untouched', () => {
    const verdict = approvedVerdict();
    const outcome: any = applyTwoTierInvariant(
      verdict,
      report([finding('warning'), finding('suggestion'), finding('info')])
    );

    assert.strictEqual(outcome.escalatedBy, null);
    assert.strictEqual(outcome.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(outcome.verdict.summary, verdict.summary);
  });

  test('N4: isError()/errorCount() are aliases of the one blocking predicate', () => {
    for (const severity of REVIEW_SEVERITIES) {
      const f = finding(severity);
      assert.strictEqual(
        f.isError(),
        f.isBlocking(),
        `${severity}: isError() must equal isBlocking()`
      );
    }

    const mixed = report([
      finding('critical'),
      finding('error'),
      finding('warning'),
      finding('suggestion'),
      finding('info')
    ]);
    assert.strictEqual(mixed.errorCount(), mixed.blockingCount());
    assert.strictEqual(mixed.errorCount(), 2);
    assert.strictEqual(mixed.hasBlockingIssues(), mixed.blockingCount() > 0);
  });

  test('N5: a bypassed report with a stray critical finding never escalates', () => {
    const verdict = new ReviewVerdict({
      status: VERDICT_SKIPPED,
      summary: 'critique did not run',
      confidenceLevel: 'Low'
    });
    const outcome: any = applyTwoTierInvariant(verdict, report([finding('critical')], true));

    assert.strictEqual(outcome.escalatedBy, null);
    assert.strictEqual(outcome.verdict, verdict);
  });
});

// #339 (audit extra E5 / T12): the escalated verdict's `findingsCount` keeps
// counting every report finding — N1-N5 above pin that BLOCKING behaviour
// (summary, criteria, remediation, escalation decision) is unchanged, which is
// the mandated T12.2 regression: bypassed reports still map to SKIPPED and the
// summary/criteria still count blocking only.
describe('escalated verdict findingsCount keeps every report finding (#339 E5)', () => {
  test('T12.1 (N6): APPROVED verdict + 1 blocking + 3 warnings escalates with findingsCount 4', () => {
    const outcome: any = applyTwoTierInvariant(
      approvedVerdict(),
      report([
        finding('critical', 10),
        finding('warning', 11),
        finding('suggestion', 12),
        finding('info', 13)
      ])
    );

    assert.strictEqual(outcome.escalatedBy, 'critique');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(outcome.verdict.findings.length, 4, 'all 4 report findings must be kept');
    // The `--json` surface named by the AC reads the same count.
    assert.strictEqual(outcome.verdict.toJSON().findingsCount, 4);

    // Blocking behaviour is untouched: the summary and criteria still count
    // only the blocking finding.
    assert.ok(
      outcome.verdict.summary.includes('detected 1 blocking/error violation(s)'),
      outcome.verdict.summary
    );
    assert.strictEqual(outcome.verdict.unfulfilledCriteria.length, 1);
  });

  test('N7: a duplicate of a tier-1 finding is not double-counted', () => {
    const shared = finding('critical', 10);
    const verdict = new ReviewVerdict({
      status: VERDICT_APPROVED,
      summary: 'reviewer approved',
      confidenceLevel: 'High',
      findings: [shared]
    });
    const outcome: any = applyTwoTierInvariant(
      verdict,
      report([shared, finding('warning', 11)])
    );

    assert.strictEqual(outcome.escalatedBy, 'critique');
    assert.strictEqual(outcome.verdict.findings.length, 2, 'deduplicated: 1 tier-1 + 1 new');
    assert.strictEqual(outcome.verdict.toJSON().findingsCount, 2);
  });
});
