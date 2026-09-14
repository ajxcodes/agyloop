/**
 * agyloop - AI PR Reviewer Domain Value Objects Tests
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  ReviewConfidence,
  AiReviewFinding,
  AiReviewReport,
  ValidationError,
  AiReviewerError,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_LOW,
  SEVERITY_CRITICAL,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  SEVERITY_SUGGESTION,
  SEVERITY_INFO
} = require('../../dist/domain');

describe('ReviewConfidence Value Object', () => {
  test('creates valid confidence instances and normalizes case', () => {
    const high = ReviewConfidence.create('high', 'Diff is small and clean');
    assert.strictEqual(high.level, CONFIDENCE_HIGH);
    assert.strictEqual(high.explanation, 'Diff is small and clean');
    assert.strictEqual(high.isHigh(), true);
    assert.strictEqual(high.isMedium(), false);
    assert.strictEqual(high.isLow(), false);

    const med = ReviewConfidence.medium('Moderate complexity');
    assert.strictEqual(med.level, CONFIDENCE_MEDIUM);
    assert.strictEqual(med.isMedium(), true);

    const low = ReviewConfidence.low('Large diff with unknown areas');
    assert.strictEqual(low.level, CONFIDENCE_LOW);
    assert.strictEqual(low.isLow(), true);
  });

  test('validates equality and formatting', () => {
    const c1 = ReviewConfidence.create('High', 'Reason');
    const c2 = ReviewConfidence.create('high', 'Reason');
    const c3 = ReviewConfidence.create('High', 'Other');

    assert.strictEqual(c1.equals(c2), true);
    assert.strictEqual(c1.equals(c3), false);
    assert.strictEqual(c1.equals(null), false);
    assert.strictEqual(c1.toString(), 'High - Reason');
  });

  test('rejects invalid confidence levels', () => {
    assert.throws(
      () => new ReviewConfidence('invalid'),
      (err: unknown) => err instanceof ValidationError
    );
    assert.throws(() => new ReviewConfidence(''), ValidationError);
    assert.throws(() => new ReviewConfidence(123), ValidationError);
  });

  test('tryFrom handles objects, strings, and invalid inputs', () => {
    const fromStr = ReviewConfidence.tryFrom('high');
    assert.ok(fromStr && fromStr.isHigh());

    const fromObj = ReviewConfidence.tryFrom({
      confidenceLevel: 'Low',
      confidenceExplanation: 'Complex logic'
    });
    assert.ok(fromObj && fromObj.isLow() && fromObj.explanation === 'Complex logic');

    assert.strictEqual(ReviewConfidence.tryFrom(null), null);
    assert.strictEqual(ReviewConfidence.tryFrom('invalid_level'), null);
  });
});

describe('AiReviewFinding Value Object', () => {
  test('creates finding and identifies severities and blocking status', () => {
    const crit = new AiReviewFinding({
      path: 'src/domain/constants.ts',
      line: 42,
      severity: 'critical',
      body: 'Memory leak detected'
    });
    assert.strictEqual(crit.isBlocking(), true);
    assert.strictEqual(crit.isCritical(), true);
    assert.strictEqual(crit.isError(), true);
    assert.strictEqual(crit.isWarning(), false);
    assert.strictEqual(crit.getIcon(), '🔴');

    const warn = new AiReviewFinding({
      path: 'src/ports/ai-reviewer.ts',
      line: 10,
      severity: 'warning',
      body: 'Consider making this property optional'
    });
    assert.strictEqual(warn.isBlocking(), false);
    assert.strictEqual(warn.isWarning(), true);
    assert.strictEqual(warn.getIcon(), '⚠️');

    const info = new AiReviewFinding({
      path: 'README.md',
      line: 1,
      severity: 'info',
      body: 'Documentation updated'
    });
    assert.strictEqual(info.isInfo(), true);
    assert.strictEqual(info.isBlocking(), false);
    assert.strictEqual(info.getIcon(), 'ℹ️');
  });

  test('formats markdown representation correctly', () => {
    const finding = new AiReviewFinding({
      path: 'src/app.ts',
      line: 15,
      severity: 'warning',
      body: 'Variable might be undefined'
    });
    const md = finding.formatMarkdown();
    assert.ok(md.includes('### ⚠️ src/app.ts (Line 15)'));
    assert.ok(md.includes('Variable might be undefined'));
  });

  test('rejects invalid finding inputs', () => {
    assert.throws(
      () => new AiReviewFinding({ path: '', line: 10, severity: 'warning', body: 'Body' }),
      ValidationError
    );
    assert.throws(
      () => new AiReviewFinding({ path: 'a.ts', line: -1, severity: 'warning', body: 'Body' }),
      ValidationError
    );
    assert.throws(
      () => new AiReviewFinding({ path: 'a.ts', line: 10, severity: 'unknown_sev', body: 'Body' }),
      ValidationError
    );
    assert.throws(
      () => new AiReviewFinding({ path: 'a.ts', line: 10, severity: 'warning', body: '' }),
      ValidationError
    );
  });

  test('tryFrom extracts valid finding or returns null', () => {
    const valid = AiReviewFinding.tryFrom({
      path: 'test.ts',
      line: 5,
      severity: 'error',
      body: 'Type error'
    });
    assert.ok(valid);
    assert.strictEqual(valid.path, 'test.ts');
    assert.strictEqual(valid.isError(), true);

    assert.strictEqual(AiReviewFinding.tryFrom(null), null);
    assert.strictEqual(AiReviewFinding.tryFrom({ path: 123 }), null);
  });
});

describe('AiReviewReport Value Object & Parser', () => {
  test('parses raw JSON response into structured AiReviewReport', () => {
    const rawJson = JSON.stringify({
      summary: 'High-level PR summary.\n\n- Feat A\n- Feat B',
      confidenceLevel: 'High',
      confidenceExplanation: 'Clear isolated diff',
      resolvedThreads: ['thread-1', 'thread-2'],
      comments: [
        {
          path: 'src/ports/ai-reviewer.ts',
          line: 12,
          severity: 'warning',
          body: 'Consider adding JSDoc comments.'
        }
      ]
    });

    const report = AiReviewReport.parse(rawJson);
    assert.strictEqual(report.summary.includes('High-level PR summary.'), true);
    assert.strictEqual(report.confidence.isHigh(), true);
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].path, 'src/ports/ai-reviewer.ts');
    assert.strictEqual(report.findings[0].isWarning(), true);
    assert.strictEqual(report.warningCount(), 1);
    assert.strictEqual(report.errorCount(), 0);
    assert.strictEqual(report.hasBlockingIssues(), false);
    assert.strictEqual(report.isPassing(), true);
    assert.deepStrictEqual(report.resolvedThreads, ['thread-1', 'thread-2']);
  });

  test('parses JSON embedded inside markdown codeblock', () => {
    const markdownResponse = `Here is my review:
\`\`\`json
{
  "summary": "Clean pull request.",
  "confidenceLevel": "High",
  "confidenceExplanation": "Simple changes",
  "comments": []
}
\`\`\`
Hope this helps!`;

    const report = AiReviewReport.parse(markdownResponse);
    assert.strictEqual(report.confidence.isHigh(), true);
    assert.strictEqual(report.findings.length, 0);
    assert.strictEqual(report.isPassing(), true);
  });

  test('detects blocking issues and prevents passing verdict', () => {
    const report = new AiReviewReport({
      summary: 'Changes with issues',
      confidence: ReviewConfidence.high('Good diff coverage'),
      findings: [
        new AiReviewFinding({
          path: 'src/main.ts',
          line: 25,
          severity: 'critical',
          body: 'Security SQL injection hazard'
        })
      ]
    });

    assert.strictEqual(report.hasBlockingIssues(), true);
    assert.strictEqual(report.errorCount(), 1);
    assert.strictEqual(report.isPassing(), false);
  });

  test('handles empty diff and bypassed report factories', () => {
    const emptyReport = AiReviewReport.empty();
    assert.strictEqual(emptyReport.findings.length, 0);
    assert.strictEqual(emptyReport.confidence.isHigh(), true);
    assert.strictEqual(emptyReport.bypassed, false);

    const bypassed = AiReviewReport.bypassed('GEMINI_API_KEY missing');
    assert.strictEqual(bypassed.bypassed, true);
    assert.strictEqual(bypassed.isPassing(), false);
    assert.strictEqual(bypassed.diagnosticMessage, 'GEMINI_API_KEY missing');
  });

  test('throws AiReviewerError on unparseable JSON', () => {
    assert.throws(
      () => AiReviewReport.parse('This is not json { ['),
      (err: unknown) => err instanceof AiReviewerError
    );
    assert.throws(() => AiReviewReport.parse(''), AiReviewerError);
  });
});
