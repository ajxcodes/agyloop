/**
 * agyloop - Two-tier invariant and the reviewer's natural "none" wording (issue #356)
 *
 * Defect 1 was recorded at the REVIEW channel: `ReviewVerdict.parse` captured
 * `- None in the reviewed in-repo scope (deferred to post-commit).` as an
 * UNFULFILLED criterion, and `applyTwoTierInvariant` therefore rewrote an
 * `APPROVED` verdict into `CHANGES_REQUESTED`. The guard itself was correct; the
 * parse upstream was not. These tests pin both directions so the predicate can
 * never be widened into a rubber stamp:
 *
 * NW1 - the live mixed-wording block stays APPROVED with no escalation
 * NW2 - a real criterion still escalates (positive control)
 * NW3 - a critique escalation still wins (the second arm was not reordered)
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
  VERDICT_CHANGES_REQUESTED
} = require('../../dist/domain');

const MIXED_NONE_APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: Every acceptance criterion is met; the diff is in scope.
UNFULFILLED_AC:
- None in the reviewed in-repo scope (deferred to post-commit).
REMEDIATION_GUIDANCE:
- None required.
`;

function criticalReport() {
  return new AiReviewReport({
    summary: 'critique summary',
    confidence: ReviewConfidence.high('static scan'),
    findings: [
      new AiReviewFinding({
        path: 'src/app.ts',
        line: 10,
        severity: 'critical',
        body: 'a critical finding'
      })
    ]
  });
}

describe('applyTwoTierInvariant - natural none phrasing (issue #356)', () => {
  test('NW1: the live mixed-wording APPROVED verdict stays APPROVED with no escalation', () => {
    const verdict = ReviewVerdict.parse(MIXED_NONE_APPROVED_BLOCK);
    assert.strictEqual(verdict.status, VERDICT_APPROVED);
    assert.deepStrictEqual([...verdict.unfulfilledCriteria], []);

    const outcome: any = applyTwoTierInvariant(verdict, null);

    assert.strictEqual(outcome.escalatedBy, null);
    assert.strictEqual(outcome.verdict.status, VERDICT_APPROVED);
    assert.strictEqual(
      outcome.verdict.summary,
      'Every acceptance criterion is met; the diff is in scope.'
    );
  });

  test('NW2: a real unfulfilled criterion still escalates APPROVED', () => {
    const verdict = ReviewVerdict.parse(
      [
        'REVIEW_STATUS: APPROVED',
        'REVIEW_SUMMARY: Approved with one caveat.',
        'UNFULFILLED_AC:',
        '- The nil dereference is fixed',
        'REMEDIATION_GUIDANCE:',
        '- None required.'
      ].join('\n')
    );

    assert.deepStrictEqual([...verdict.unfulfilledCriteria], [
      'The nil dereference is fixed'
    ]);

    const outcome: any = applyTwoTierInvariant(verdict, null);

    assert.strictEqual(outcome.escalatedBy, 'unfulfilled-criteria');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(
      outcome.verdict.summary.startsWith(
        'Review requested changes: Unfulfilled Acceptance Criteria detected.'
      ),
      `unexpected escalation summary: ${outcome.verdict.summary}`
    );
  });

  test('NW3: a critique escalation still wins over the none-wording fix', () => {
    const verdict = ReviewVerdict.parse(MIXED_NONE_APPROVED_BLOCK);
    const outcome: any = applyTwoTierInvariant(verdict, criticalReport());

    assert.strictEqual(outcome.escalatedBy, 'critique');
    assert.strictEqual(outcome.verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.ok(
      outcome.verdict.summary.includes('blocking/error violation(s)'),
      `unexpected escalation summary: ${outcome.verdict.summary}`
    );
  });
});
