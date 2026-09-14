/**
 * agyloop - ReviewVerdict Value Object Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ReviewVerdict,
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  TOKEN_REVIEW_STATUS,
  TOKEN_REVIEW_SUMMARY,
  TOKEN_UNFULFILLED_AC,
  TOKEN_REMEDIATION_GUIDANCE,
  ReviewerSubagentError,
  ValidationError,
  AiReviewReport,
  AiReviewFinding,
  ReviewConfidence
} = require('../../dist/domain');

describe('ReviewVerdict Value Object', () => {
  test('creates valid APPROVED verdict', () => {
    const verdict = ReviewVerdict.create({
      status: VERDICT_APPROVED,
      summary: 'All checks passed cleanly.'
    });

    assert.strictEqual(verdict.status, VERDICT_APPROVED);
    assert.strictEqual(verdict.summary, 'All checks passed cleanly.');
    assert.strictEqual(verdict.isApproved(), true);
    assert.strictEqual(verdict.isChangesRequested(), false);
    assert.deepStrictEqual([...verdict.unfulfilledCriteria], []);
    assert.deepStrictEqual([...verdict.remediationGuidance], []);
  });

  test('creates valid CHANGES_REQUESTED verdict with unfulfilled criteria & guidance', () => {
    const verdict = ReviewVerdict.create({
      status: VERDICT_CHANGES_REQUESTED,
      summary: 'Two acceptance criteria were unfulfilled.',
      unfulfilledCriteria: ['- Missing unit test for edge case', '* Error handling not implemented'],
      remediationGuidance: ['1. Add unit test in tests/foo.test.ts', '- Implement try/catch in src/foo.ts']
    });

    assert.strictEqual(verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(verdict.isApproved(), false);
    assert.strictEqual(verdict.isChangesRequested(), true);
    assert.deepStrictEqual([...verdict.unfulfilledCriteria], [
      'Missing unit test for edge case',
      'Error handling not implemented'
    ]);
    assert.deepStrictEqual([...verdict.remediationGuidance], [
      'Add unit test in tests/foo.test.ts',
      'Implement try/catch in src/foo.ts'
    ]);
  });

  test('filters out "None", "none", and "N/A" values', () => {
    const verdict = ReviewVerdict.create({
      status: VERDICT_APPROVED,
      summary: 'Clean review',
      unfulfilledCriteria: ['None', 'none.', 'N/A', '   '],
      remediationGuidance: ['None', 'no unfulfilled criteria', '']
    });

    assert.deepStrictEqual([...verdict.unfulfilledCriteria], []);
    assert.deepStrictEqual([...verdict.remediationGuidance], []);
  });

  test('validates inputs and throws ValidationError on invalid props', () => {
    assert.throws(
      () => new ReviewVerdict(null as any),
      (err: any) => err instanceof ValidationError && err.field === 'props'
    );

    assert.throws(
      () => new ReviewVerdict({ status: 'INVALID_STATUS' as any, summary: 'foo' }),
      (err: any) => err instanceof ValidationError && err.field === 'status'
    );

    assert.throws(
      () => new ReviewVerdict({ status: VERDICT_APPROVED, summary: '   ' }),
      (err: any) => err instanceof ValidationError && err.field === 'summary'
    );
  });

  test('formats structured tokens correctly', () => {
    const verdict = ReviewVerdict.create({
      status: VERDICT_CHANGES_REQUESTED,
      summary: 'Regression detected',
      unfulfilledCriteria: ['AC 1: Must handle timeout'],
      remediationGuidance: ['Add AbortController in fetch helper']
    });

    const tokens = verdict.formatStructuredTokens();
    assert.ok(tokens.includes(`${TOKEN_REVIEW_STATUS}: ${VERDICT_CHANGES_REQUESTED}`));
    assert.ok(tokens.includes(`${TOKEN_REVIEW_SUMMARY}: Regression detected`));
    assert.ok(tokens.includes(`${TOKEN_UNFULFILLED_AC}:`));
    assert.ok(tokens.includes('- AC 1: Must handle timeout'));
    assert.ok(tokens.includes(`${TOKEN_REMEDIATION_GUIDANCE}:`));
    assert.ok(tokens.includes('- Add AbortController in fetch helper'));
  });

  test('formatSelfCorrectionPayload formats actionable remediation block', () => {
    const verdict = ReviewVerdict.create({
      status: VERDICT_CHANGES_REQUESTED,
      summary: 'Missing input validation',
      unfulfilledCriteria: ['AC 2: Reject negative numbers'],
      remediationGuidance: ['Add throw new ValidationError if n < 0']
    });

    const payload = verdict.formatSelfCorrectionPayload();
    assert.ok(payload.includes('### Reviewer Subagent Self-Correction Remediation Guidance:'));
    assert.ok(payload.includes('**Review Summary**: Missing input validation'));
    assert.ok(payload.includes('**Unfulfilled Acceptance Criteria**:'));
    assert.ok(payload.includes('- AC 2: Reject negative numbers'));
    assert.ok(payload.includes('**Required Remediation Actions**:'));
    assert.ok(payload.includes('- Add throw new ValidationError if n < 0'));
  });

  test('formatSelfCorrectionPayload returns empty string when approved', () => {
    const verdict = ReviewVerdict.create({
      status: VERDICT_APPROVED,
      summary: 'All standards satisfied'
    });

    assert.strictEqual(verdict.formatSelfCorrectionPayload(), '');
  });

  test('parses structured APPROVED tokens from text', () => {
    const text = `
Here is my review:

REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: Clean diff adhering strictly to clean architecture guidelines.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;
    const verdict = ReviewVerdict.parse(text);
    assert.strictEqual(verdict.status, VERDICT_APPROVED);
    assert.strictEqual(verdict.summary, 'Clean diff adhering strictly to clean architecture guidelines.');
    assert.strictEqual(verdict.unfulfilledCriteria.length, 0);
    assert.strictEqual(verdict.remediationGuidance.length, 0);
  });

  test('parses structured CHANGES_REQUESTED with multi-line lists from text', () => {
    const text = `
REVIEW_STATUS: CHANGES_REQUESTED
REVIEW_SUMMARY: Identified 2 unfulfilled criteria in domain value objects.
UNFULFILLED_AC:
- AC 1: Missing boundary validation on negative integers
- AC 2: Missing unit test for corrupted JSON string
REMEDIATION_GUIDANCE:
- Step 1: Add check in constructor of FooValueObject
- Step 2: Add test case in tests/domain/foo.test.ts
`;
    const verdict = ReviewVerdict.parse(text);
    assert.strictEqual(verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(verdict.summary, 'Identified 2 unfulfilled criteria in domain value objects.');
    assert.deepStrictEqual([...verdict.unfulfilledCriteria], [
      'AC 1: Missing boundary validation on negative integers',
      'AC 2: Missing unit test for corrupted JSON string'
    ]);
    assert.deepStrictEqual([...verdict.remediationGuidance], [
      'Step 1: Add check in constructor of FooValueObject',
      'Step 2: Add test case in tests/domain/foo.test.ts'
    ]);
  });

  test('parses inline single-line tokens from text', () => {
    const text = `
REVIEW_STATUS: CHANGES_REQUESTED
REVIEW_SUMMARY: Edge case flaw
UNFULFILLED_AC: AC 3 failed: null check missing
REMEDIATION_GUIDANCE: Add null check before accessing property
`;
    const verdict = ReviewVerdict.parse(text);
    assert.strictEqual(verdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(verdict.summary, 'Edge case flaw');
    assert.deepStrictEqual([...verdict.unfulfilledCriteria], ['AC 3 failed: null check missing']);
    assert.deepStrictEqual([...verdict.remediationGuidance], ['Add null check before accessing property']);
  });

  test('throws ReviewerSubagentError when verdict status cannot be extracted', () => {
    assert.throws(
      () => ReviewVerdict.parse(''),
      (err: any) => err instanceof ReviewerSubagentError && err.operation === 'parse'
    );

    assert.throws(
      () => ReviewVerdict.parse('Just some random text with no status token.'),
      (err: any) => err instanceof ReviewerSubagentError && err.operation === 'parse'
    );
  });

  test('bridges from AiReviewReport instance', () => {
    const passingReport = new AiReviewReport({
      summary: 'All automated reviewer checks passed.',
      confidence: ReviewConfidence.high('Comprehensive diff coverage.'),
      findings: [
        new AiReviewFinding({
          path: 'src/foo.ts',
          line: 10,
          severity: 'info',
          body: 'Consider adding a JSDoc comment.'
        })
      ]
    });

    const approvedVerdict = ReviewVerdict.fromAiReviewReport(passingReport);
    assert.strictEqual(approvedVerdict.isApproved(), true);
    assert.strictEqual(approvedVerdict.status, VERDICT_APPROVED);
    assert.strictEqual(approvedVerdict.confidenceLevel, 'High');

    const failingReport = new AiReviewReport({
      summary: 'Blocking error detected.',
      confidence: ReviewConfidence.medium('Found critical path defect.'),
      findings: [
        new AiReviewFinding({
          path: 'src/bar.ts',
          line: 42,
          severity: 'critical',
          body: 'Potential null pointer dereference.'
        })
      ]
    });

    const rejectedVerdict = ReviewVerdict.fromAiReviewReport(failingReport);
    assert.strictEqual(rejectedVerdict.isChangesRequested(), true);
    assert.strictEqual(rejectedVerdict.status, VERDICT_CHANGES_REQUESTED);
    assert.strictEqual(rejectedVerdict.unfulfilledCriteria.length, 1);
    assert.ok(rejectedVerdict.unfulfilledCriteria[0].includes('Potential null pointer dereference.'));
    assert.strictEqual(rejectedVerdict.remediationGuidance.length, 1);
  });

  test('serializes to JSON correctly', () => {
    const verdict = ReviewVerdict.create({
      status: VERDICT_APPROVED,
      summary: 'Passed',
      confidenceLevel: 'High'
    });

    const json = verdict.toJSON();
    assert.strictEqual(json.status, VERDICT_APPROVED);
    assert.strictEqual(json.summary, 'Passed');
    assert.strictEqual(json.confidenceLevel, 'High');
    assert.strictEqual(json.findingsCount, 0);
  });
});
