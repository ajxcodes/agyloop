/**
 * agyloop - Domain Tests: Structured Quality Gate Summary Protocol & Value Objects
 *
 * Tests TestMetrics, DiagnosticSnippet, and GateSummaryReport value objects,
 * surgical stack trace extraction, bounded 25-line truncation, and structured token parsing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  TestMetrics,
  DiagnosticSnippet,
  GateSummaryReport,
  STATUS_PASSED,
  STATUS_FAILED,
  STATUS_TIMED_OUT,
  MAX_DIAGNOSTIC_LINES,
  DIAGNOSTIC_TRUNCATION_MARKER,
  TOKEN_GATE_STATUS,
  TOKEN_TEST_METRICS,
  SECTION_SELF_CORRECTION_TITLE,
  ValidationError,
  QualityGateSummaryParseError
} = require('../../dist');

describe('Structured Quality Gate Summary Protocol & Value Objects', () => {
  describe('TestMetrics Value Object', () => {
    test('creates valid instance and calculates total correctly', () => {
      const metrics = new TestMetrics({ passed: 10, failed: 2, skipped: 1 });
      assert.strictEqual(metrics.passed, 10);
      assert.strictEqual(metrics.failed, 2);
      assert.strictEqual(metrics.skipped, 1);
      assert.strictEqual(metrics.total, 13);
      assert.strictEqual(metrics.hasFailures(), true);
      assert.strictEqual(metrics.isAllPassed(), false);
      assert.strictEqual(metrics.format(), '10 passed, 2 failed, 1 skipped (13 total)');
      assert.strictEqual(metrics.formatSummary(), ' (10 passed, 2 failed)');
      assert.strictEqual(metrics.toTokenString(), `${TOKEN_TEST_METRICS}: 10 passed, 2 failed, 1 skipped`);
    });

    test('accepts explicit total when >= sum of components', () => {
      const metrics = new TestMetrics({ passed: 5, failed: 0, skipped: 0, total: 10 });
      assert.strictEqual(metrics.total, 10);
      assert.strictEqual(metrics.isAllPassed(), true);
      assert.strictEqual(metrics.hasFailures(), false);
      assert.strictEqual(metrics.formatSummary(), ' (5 passed)');
    });

    test('rejects negative numbers, non-integers, and invalid totals', () => {
      assert.throws(
        () => new TestMetrics({ passed: -1 }),
        (err: unknown) => err instanceof ValidationError
      );

      assert.throws(
        () => new TestMetrics({ passed: 3.5 }),
        (err: unknown) => err instanceof ValidationError
      );

      assert.throws(
        () => new TestMetrics({ passed: 5, failed: 2, total: 4 }), // 4 < 5 + 2
        (err: unknown) => err instanceof ValidationError
      );
    });

    test('validates equality across instances', () => {
      const a = new TestMetrics({ passed: 5, failed: 1, skipped: 0, total: 6 });
      const b = new TestMetrics({ passed: 5, failed: 1, skipped: 0, total: 6 });
      const c = new TestMetrics({ passed: 4, failed: 2, skipped: 0, total: 6 });

      assert.strictEqual(a.equals(b), true);
      assert.strictEqual(a.equals(c), false);
      assert.strictEqual(a.equals(null), false);
    });

    test('parses structured TEST_METRICS and TEST_COUNT tokens', () => {
      const parsed1 = TestMetrics.parse('TEST_METRICS: 12 passed, 3 failed, 1 skipped');
      assert.ok(parsed1);
      assert.strictEqual(parsed1.passed, 12);
      assert.strictEqual(parsed1.failed, 3);
      assert.strictEqual(parsed1.skipped, 1);
      assert.strictEqual(parsed1.total, 16);

      const parsed2 = TestMetrics.parse('TEST_COUNT: 8 passed, 0 failed');
      assert.ok(parsed2);
      assert.strictEqual(parsed2.passed, 8);
      assert.strictEqual(parsed2.failed, 0);
      assert.strictEqual(parsed2.total, 8);
    });

    test('parses Node.js TAP runner output', () => {
      const tapOutput = `
✔ state-machine (1.2ms)
✔ subagent-routing (2.1ms)
ℹ tests 25
ℹ pass 23
ℹ fail 2
ℹ skipped 0
`;
      const parsed = TestMetrics.parse(tapOutput);
      assert.ok(parsed);
      assert.strictEqual(parsed.total, 25);
      assert.strictEqual(parsed.passed, 23);
      assert.strictEqual(parsed.failed, 2);
      assert.strictEqual(parsed.skipped, 0);
    });

    test('parses Playwright / Jest output with ANSI escape codes', () => {
      const coloredOutput = `\u001b[32m5 passed\u001b[39m, \u001b[31m1 failed\u001b[39m (4.2s)`;
      const parsed = TestMetrics.parse(coloredOutput);
      assert.ok(parsed);
      assert.strictEqual(parsed.passed, 5);
      assert.strictEqual(parsed.failed, 1);
      assert.strictEqual(parsed.total, 6);
    });

    test('returns null for non-test output', () => {
      assert.strictEqual(TestMetrics.parse(''), null);
      assert.strictEqual(TestMetrics.parse('Build complete without errors.'), null);
    });
  });

  describe('DiagnosticSnippet Value Object & Surgical Extractor', () => {
    test('enforces strict 25-line limit (MAX_DIAGNOSTIC_LINES) with truncation marker', () => {
      const longLog = Array.from({ length: 40 }, (_, i) => `Error line ${i + 1}`).join('\n');
      const snippet = DiagnosticSnippet.fromRaw(longLog);

      assert.strictEqual(snippet.lines.length, MAX_DIAGNOSTIC_LINES);
      assert.strictEqual(snippet.lineCount, 25);
      assert.strictEqual(snippet.lines[24], DIAGNOSTIC_TRUNCATION_MARKER);
      assert.ok(snippet.toString().includes(DIAGNOSTIC_TRUNCATION_MARKER));
    });

    test('surgically isolates root cause, failing assertion, and file location while stripping noise', () => {
      const verboseFailingOutput = `
✔ passing test 1 (1ms)
✔ passing test 2 (2ms)
✖ failing test 3 (5ms)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'FAILED'
- 'PASSED'
    at Context.<anonymous> (tests/domain/value-objects.test.ts:42:5)
    at processImmediate (node:internal/timers:478:21)
    at process.callbackTrampoline (node:internal/async_hooks:130:17)
npm ERR! lifecycle failure
npm ERR! A complete log of this run can be found in:
`;

      const snippet = DiagnosticSnippet.extract(verboseFailingOutput);
      assert.ok(snippet);
      assert.strictEqual(snippet.fileLocation, 'tests/domain/value-objects.test.ts:42:5');
      assert.ok(snippet.failingAssertion?.includes('AssertionError'));
      assert.ok(snippet.rootCause?.includes('failing test 3'));

      const formatted = snippet.formatForPrompt();
      assert.ok(formatted.includes('tests/domain/value-objects.test.ts:42:5'));
      assert.ok(formatted.includes('AssertionError'));
      // Verifies noise was stripped
      assert.strictEqual(formatted.includes('node:internal/timers'), false);
      assert.strictEqual(formatted.includes('npm ERR!'), false);
      assert.strictEqual(formatted.includes('✔ passing test 1'), false);
    });

    test('handles empty or blank failure outputs safely', () => {
      const snippet = DiagnosticSnippet.extract('', '');
      assert.ok(snippet);
      assert.ok(snippet.toString().includes('Command failed without output'));
    });

    test('formats token representation', () => {
      const snippet = new DiagnosticSnippet({
        rawContent: 'Error: Connection refused',
        fileLocation: 'src/api/client.ts:88:12',
        failingAssertion: 'Error: Connection refused'
      });

      const tokens = snippet.toTokenString();
      assert.ok(tokens.includes('FAILURE_FILE: src/api/client.ts:88:12'));
      assert.ok(tokens.includes('FAILING_ASSERTION: Error: Connection refused'));
      assert.ok(tokens.includes('DIAGNOSTIC_SNIPPET:'));
    });
  });

  describe('GateSummaryReport Value Object & Structured Parser', () => {
    test('creates report, formats text report and structured tokens', () => {
      const report = GateSummaryReport.create({
        verdict: STATUS_PASSED,
        totalDurationMs: 3500,
        commands: [
          {
            id: 'typecheck',
            label: 'TypeScript Compilation & Typecheck',
            command: 'npm run typecheck',
            exitCode: 0,
            durationMs: 1500,
            passed: true,
            timedOut: false
          },
          {
            id: 'test',
            label: 'Automated Test Suite',
            command: 'npm test',
            exitCode: 0,
            durationMs: 2000,
            passed: true,
            timedOut: false,
            testMetrics: new TestMetrics({ passed: 133, failed: 0, total: 133 })
          }
        ],
        testMetrics: new TestMetrics({ passed: 133, failed: 0, total: 133 }),
        buildStatus: STATUS_PASSED,
        testsStatus: STATUS_PASSED,
        buildSystem: 'node'
      });

      assert.strictEqual(report.isPassed(), true);
      assert.strictEqual(report.isFailed(), false);

      const text = report.formatTextReport({ nextStage: 'REVIEW' });
      assert.ok(text.includes('=== AgyLoop: Quality Gate Report ==='));
      assert.ok(text.includes('Overall Verdict : PASSED'));
      assert.ok(text.includes('Build System    : node'));
      assert.ok(text.includes('Total Duration  : 3.50s'));
      assert.ok(text.includes('Next Stage      : REVIEW'));
      assert.ok(text.includes('133/133 tests passed'));

      const tokens = report.formatStructuredTokens();
      assert.ok(tokens.includes('GATE_STATUS: PASSED'));
      assert.ok(tokens.includes('BUILD_STATUS: PASSED'));
      assert.ok(tokens.includes('TEST_METRICS: 133 passed, 0 failed, 0 skipped'));
    });

    test('formats self-correction payload for failing report', () => {
      const snippet = new DiagnosticSnippet({
        rawContent: 'AssertionError: values differ',
        fileLocation: 'tests/core.test.ts:25:9',
        failingAssertion: 'AssertionError: values differ'
      });

      const report = GateSummaryReport.create({
        verdict: STATUS_FAILED,
        totalDurationMs: 2000,
        commands: [
          {
            id: 'test',
            label: 'Automated Test Suite',
            command: 'npm test',
            exitCode: 1,
            durationMs: 2000,
            passed: false,
            timedOut: false,
            failureSnippet: snippet.toString()
          }
        ],
        diagnosticSnippet: snippet
      });

      assert.strictEqual(report.isFailed(), true);
      const payload = report.formatSelfCorrectionPayload();
      assert.ok(payload.includes(SECTION_SELF_CORRECTION_TITLE));
      assert.ok(payload.includes('tests/core.test.ts:25:9'));
      assert.ok(payload.includes('AssertionError: values differ'));
    });

    test('parses machine-readable GATE_* tokens successfully', () => {
      const rawText = `
GATE_STATUS: FAILED
BUILD_STATUS: PASSED
TEST_METRICS: 40 passed, 2 failed, 0 skipped
FAILURE_FILE: src/domain/constants.ts:50:3
FAILING_ASSERTION: AssertionError: unexpected token
DIAGNOSTIC_SNIPPET:
Error at constants.ts:50:3
`;

      const parsed = GateSummaryReport.parse(rawText);
      assert.strictEqual(parsed.verdict, STATUS_FAILED);
      assert.strictEqual(parsed.buildStatus, STATUS_PASSED);
      assert.ok(parsed.testMetrics);
      assert.strictEqual(parsed.testMetrics.passed, 40);
      assert.strictEqual(parsed.testMetrics.failed, 2);
      assert.ok(parsed.diagnosticSnippet);
      assert.strictEqual(parsed.diagnosticSnippet.fileLocation, 'src/domain/constants.ts:50:3');
      assert.strictEqual(parsed.diagnosticSnippet.failingAssertion, 'AssertionError: unexpected token');
    });

    test('parses markdown execution matrix table', () => {
      const markdownReport = `
=== Quality Gate Verification Report ===

| Command | Exit Code | Duration | Status |
| --- | --- | --- | --- |
| npm run typecheck | 0 | 1.5s | PASSED |
| npm test | 1 | 3.2s | FAILED |

TEST_METRICS: 10 passed, 1 failed
`;

      const parsed = GateSummaryReport.parse(markdownReport);
      assert.strictEqual(parsed.verdict, STATUS_FAILED);
      assert.strictEqual(parsed.commands.length, 2);
      assert.strictEqual(parsed.commands[0].label, 'npm run typecheck');
      assert.strictEqual(parsed.commands[0].passed, true);
      assert.strictEqual(parsed.commands[0].durationMs, 1500);
      assert.strictEqual(parsed.commands[1].label, 'npm test');
      assert.strictEqual(parsed.commands[1].passed, false);
      assert.strictEqual(parsed.commands[1].durationMs, 3200);
      assert.ok(parsed.testMetrics);
      assert.strictEqual(parsed.testMetrics.passed, 10);
      assert.strictEqual(parsed.testMetrics.failed, 1);
    });

    test('throws QualityGateSummaryParseError on invalid input', () => {
      assert.throws(
        () => GateSummaryReport.parse(''),
        (err: unknown) => err instanceof QualityGateSummaryParseError
      );

      assert.throws(
        () => GateSummaryReport.parse('No gate report tokens or table here at all.'),
        (err: unknown) => err instanceof QualityGateSummaryParseError
      );
    });
  });
});
