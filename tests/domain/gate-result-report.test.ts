/**
 * agyloop - GateResultReport value object (issue #284, AC1/AC9)
 *
 * The gate's evidence block is the ONLY record of a gate run. It fails closed:
 * a block that claims PASSED with failing tests, carries an unmeasurable
 * duration, or omits the marker is refused before anything is persisted.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  GateResultReport,
  ValidationError,
  GATE_REPORT_JSON_MARKER,
  formatGateReportExample,
  SMOKE_PROTOCOL_NOT_DECLARED
} = require('../../dist/domain');

const VALID_BLOCK = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (1408 passed)", "testsPassed": 1408, "testsFailed": 0,
  "durationMs": 196000, "executedCommands": ["npm run lint", "npm test"],
  "smokeProtocol": "PASSED", "notRun": [] }
`;

describe('GateResultReport (issue #284)', () => {
  test('a valid block round-trips and renders the documented confirmation', () => {
    const report = GateResultReport.parseBlock(VALID_BLOCK, 1);

    assert.strictEqual(report.verdict, 'PASSED');
    assert.strictEqual(report.buildSystem, 'node');
    assert.strictEqual(report.buildStatus, 'PASSED');
    assert.strictEqual(report.testsStatus, 'PASSED (1408 passed)');
    assert.strictEqual(report.testsPassed, 1408);
    assert.strictEqual(report.testsFailed, 0);
    assert.strictEqual(report.durationMs, 196000);
    assert.deepStrictEqual([...report.executedCommands], ['npm run lint', 'npm test']);
    assert.strictEqual(report.gateRound, 1);
    assert.strictEqual(
      report.formatConfirmation(),
      'PASSED — node — PASSED (1408 passed) — 3m 16s'
    );

    const json = report.toJSON();
    assert.strictEqual(json.testsStatus, 'PASSED (1408 passed)');
    assert.strictEqual(GateResultReport.fromJSON(json, 1).formatConfirmation(), report.formatConfirmation());
  });

  test('a PASSED verdict that reports failing tests is refused', () => {
    const block = VALID_BLOCK.replace('"testsFailed": 0', '"testsFailed": 1');
    assert.throws(
      () => GateResultReport.parseBlock(block, 1),
      (err: any) => err instanceof ValidationError && err.field === 'testsFailed'
    );
  });

  test('a block without the marker is refused', () => {
    assert.throws(
      () => GateResultReport.parseBlock('{ "verdict": "PASSED" }', 1),
      (err: any) => err instanceof ValidationError && /missing GATE_REPORT_JSON/.test(err.message)
    );
  });

  test('a negative duration is refused', () => {
    const block = VALID_BLOCK.replace('"durationMs": 196000', '"durationMs": -1');
    assert.throws(
      () => GateResultReport.parseBlock(block, 0),
      (err: any) => err instanceof ValidationError && err.field === 'durationMs'
    );
  });

  test('an unknown verdict is refused', () => {
    const block = VALID_BLOCK.replace('"verdict": "PASSED"', '"verdict": "MAYBE"');
    assert.throws(
      () => GateResultReport.parseBlock(block, 0),
      (err: any) => err instanceof ValidationError && err.field === 'verdict'
    );
  });

  test('a block that certifies a DIFFERENT round is refused', () => {
    const block = VALID_BLOCK.replace(
      '"durationMs": 196000,',
      '"durationMs": 196000, "gateRound": 3,'
    );
    assert.throws(
      () => GateResultReport.parseBlock(block, 2),
      (err: any) => err instanceof ValidationError && err.field === 'gateRound'
    );
  });

  test('notRun entries require an id and a reason', () => {
    const block = VALID_BLOCK.replace(
      '"notRun": []',
      '"notRun": [{ "id": "act", "label": "act", "reason": "no runtime" }]'
    );
    const report = GateResultReport.parseBlock(block, 0);
    assert.strictEqual(report.notRun.length, 1);
    assert.strictEqual(report.notRun[0].id, 'act');
    assert.strictEqual(report.notRun[0].reason, 'no runtime');

    const bad = VALID_BLOCK.replace('"notRun": []', '"notRun": [{ "id": "act" }]');
    assert.throws(
      () => GateResultReport.parseBlock(bad, 0),
      (err: any) => err instanceof ValidationError && err.field === 'notRun.reason'
    );
  });

  test('a command string containing braces does not truncate the block', () => {
    const block = VALID_BLOCK.replace(
      '"executedCommands": ["npm run lint", "npm test"]',
      '"executedCommands": ["echo {not-a-brace} && npm test"]'
    );
    const report = GateResultReport.parseBlock(block, 0);
    assert.deepStrictEqual([...report.executedCommands], ['echo {not-a-brace} && npm test']);
  });
});

describe('normaliseGateTests: testsPassed counts UNIQUE tests (issue #325, AC-16)', () => {
  const { normaliseGateTests } = require('../../dist/domain');

  function report(json: Record<string, unknown>) {
    return GateResultReport.fromJSON(
      {
        verdict: 'PASSED',
        buildSystem: 'node',
        buildStatus: 'PASSED',
        testsStatus: 'PASSED (0 passed)',
        testsPassed: 0,
        testsFailed: 0,
        durationMs: 1000,
        executedCommands: [],
        gateRound: 1,
        ...json
      },
      1
    );
  }

  test('a targeted subset plus the full suite that already includes it is NOT summed', () => {
    // The #311 numbers: 1953 = 1867 + 86, and the 86 are inside the 1867.
    const normalised = normaliseGateTests(
      report({
        testsStatus: 'PASSED (1953 passed)',
        testsPassed: 1953,
        executedCommands: ['node --test tests/domain/x.test.ts', 'npm test'],
        commandResults: [
          { command: 'node --test tests/domain/x.test.ts', passed: 86, failed: 0 },
          { command: 'npm test', passed: 1867, failed: 0 }
        ]
      })
    );

    assert.strictEqual(normalised.testsPassed, 1867);
    assert.strictEqual(normalised.testsStatus, 'PASSED (1867 passed)');
    assert.strictEqual(normalised.rewritten, true);
  });

  test('disjoint suites still sum', () => {
    const normalised = normaliseGateTests(
      report({
        testsStatus: 'PASSED (90 passed)',
        testsPassed: 90,
        executedCommands: ['node --test tests/unit.test.ts', 'node --test tests/e2e.test.ts'],
        commandResults: [
          { command: 'node --test tests/unit.test.ts', passed: 40, failed: 0 },
          { command: 'node --test tests/e2e.test.ts', passed: 50, failed: 0 }
        ]
      })
    );

    assert.strictEqual(normalised.testsPassed, 90);
    assert.strictEqual(normalised.testsStatus, 'PASSED (90 passed)');
    assert.strictEqual(normalised.rewritten, false);
  });

  test('a testsStatus that contradicts testsPassed is rewritten from the count', () => {
    const normalised = normaliseGateTests(
      report({
        testsStatus: 'PASSED (1953 passed)',
        testsPassed: 1867,
        executedCommands: ['npm test']
      })
    );

    assert.strictEqual(normalised.testsPassed, 1867);
    assert.strictEqual(normalised.testsStatus, 'PASSED (1867 passed)');
    assert.strictEqual(normalised.rewritten, true);
  });

  test('a covering command pair with no per-command counts is FLAGGED, not silently trusted', () => {
    const normalised = normaliseGateTests(
      report({
        testsStatus: 'PASSED (1953 passed)',
        testsPassed: 1953,
        executedCommands: ['node --test tests/domain/x.test.ts', 'npm test']
      })
    );

    assert.strictEqual(normalised.testsPassed, 1953, 'the aggregate is still what gets recorded');
    assert.strictEqual(normalised.rewritten, false);
    assert.strictEqual(
      normalised.suspectDoubleCount,
      true,
      'a subset beside its superset must be challenged even without a breakdown'
    );
  });

  test('an existing report with no commandResults keeps its aggregate', () => {
    const plain = GateResultReport.parseBlock(VALID_BLOCK, 1);
    assert.deepStrictEqual([...plain.commandResults], []);
    assert.deepStrictEqual([...plain.smokeChecks], []);

    const normalised = normaliseGateTests(plain);
    assert.strictEqual(normalised.testsPassed, 1408);
    assert.strictEqual(normalised.testsStatus, 'PASSED (1408 passed)');
    assert.strictEqual(normalised.rewritten, false);
  });

  test('a FAILED report that declares failures is never rewritten by normalisation', () => {
    const failed = report({
      verdict: 'FAILED',
      testsStatus: 'FAILED (3 failed, 1200 passed)',
      testsPassed: 1200,
      testsFailed: 3,
      executedCommands: ['npm test']
    });
    const normalised = normaliseGateTests(failed);
    assert.strictEqual(normalised.testsPassed, 1200);
    assert.strictEqual(normalised.testsStatus, 'FAILED (3 failed, 1200 passed)');
    assert.strictEqual(normalised.rewritten, false);
  });
});

describe('splitSmokeChecks: commands stay commands (issue #325, AC-17)', () => {
  const { splitSmokeChecks } = require('../../dist/domain');

  test('smoke-check labels are partitioned out of executedCommands', () => {
    const split = splitSmokeChecks([
      'npm run lint',
      'npm test',
      'smoke-check-1: app boots (plan line 385) PASSED',
      'smoke-check-2: login flow FAILED',
      'smoke-check-3: dark mode',
      'node --test tests/x.test.ts'
    ]);

    assert.deepStrictEqual(
      [...split.commands],
      ['npm run lint', 'npm test', 'node --test tests/x.test.ts']
    );
    assert.strictEqual(split.smokeChecks.length, 3);
    assert.strictEqual(split.smokeChecks[0].passed, true);
    assert.strictEqual(split.smokeChecks[1].passed, false);
    assert.strictEqual(
      split.smokeChecks[2].passed,
      null,
      'a check that reported no verdict is neither a pass nor a failure'
    );
    assert.ok(split.smokeChecks[0].id.startsWith('smoke-check-1'), split.smokeChecks[0].id);
  });

  test('an untagged command is never mistaken for a smoke check', () => {
    const split = splitSmokeChecks(['npm test', 'smoke-test-runner']);
    assert.deepStrictEqual([...split.commands], ['npm test', 'smoke-test-runner']);
    assert.deepStrictEqual([...split.smokeChecks], []);
  });
});

describe('gate evidence vocabulary and round parity (issue #311)', () => {
  const {
    SMOKE_PROTOCOL_VALUES,
    SMOKE_PROTOCOL_VOCABULARY,
    SMOKE_PROTOCOL_NOT_DECLARED,
    STAGE_QUALITY_GATE,
    STAGE_IMPLEMENT,
    resolveGateRound
  } = require('../../dist/domain');

  function withSmoke(value: string): string {
    return VALID_BLOCK.replace('"smokeProtocol": "PASSED"', `"smokeProtocol": "${value}"`);
  }

  test('#311 D1: the canonical NOT_DECLARED token parses', () => {
    const report = GateResultReport.parseBlock(withSmoke('NOT_DECLARED'), 1);
    assert.strictEqual(report.smokeProtocol, SMOKE_PROTOCOL_NOT_DECLARED);
  });

  test('#311 D2: legacy spacing is normalized, unknown spellings still fail closed', () => {
    for (const spelling of ['NOT DECLARED', 'not  declared']) {
      const report = GateResultReport.parseBlock(withSmoke(spelling), 1);
      assert.strictEqual(report.smokeProtocol, SMOKE_PROTOCOL_NOT_DECLARED, spelling);
    }
    for (const spelling of ['NOT-DECLARED', 'NOT_DECLARD', 'maybe']) {
      assert.throws(
        () => GateResultReport.parseBlock(withSmoke(spelling), 1),
        (err: any) =>
          err instanceof ValidationError &&
          err.field === 'smokeProtocol' &&
          err.message.includes(SMOKE_PROTOCOL_VOCABULARY),
        spelling
      );
    }
  });

  test('#311 D3: the parser accepts exactly the advertised vocabulary', () => {
    assert.deepStrictEqual([...SMOKE_PROTOCOL_VALUES], ['PASSED', 'FAILED', 'NOT_DECLARED']);
    assert.strictEqual(SMOKE_PROTOCOL_VOCABULARY, 'PASSED | FAILED | NOT_DECLARED');
    for (const value of SMOKE_PROTOCOL_VALUES) {
      assert.strictEqual(GateResultReport.parseBlock(withSmoke(value), 1).smokeProtocol, value);
    }
  });

  test('#311 D4: one round formula for empty, sparse and repeated history', () => {
    assert.strictEqual(resolveGateRound(undefined), 1);
    assert.strictEqual(resolveGateRound(null), 1);
    assert.strictEqual(resolveGateRound([]), 1);
    assert.strictEqual(resolveGateRound([{ stage: STAGE_IMPLEMENT }]), 1);
    assert.strictEqual(resolveGateRound([{ stage: STAGE_QUALITY_GATE }]), 1);
    assert.strictEqual(
      resolveGateRound([
        { stage: STAGE_QUALITY_GATE },
        { stage: STAGE_IMPLEMENT },
        { stage: STAGE_QUALITY_GATE }
      ]),
      2
    );
    assert.strictEqual(resolveGateRound([{}, { timestamp: 'x' } as any]), 1);
  });
});

describe('gate report example is the accepted shape (issue #338)', () => {
  /**
   * Fill every documented placeholder with the value the prompt calls for.
   * The replacements are distinct so one token can never stand in for another.
   */
  function fillExample(example: string): string {
    return example
      .replaceAll('<id>', 'node')
      .replaceAll('<command>', 'npm test')
      .replaceAll('<check-id>', 'check-1')
      .replaceAll('<check label>', 'app boots')
      .replaceAll('<gate-id>', 'e2e')
      .replaceAll('<gate label>', 'e2e suite')
      .replaceAll('<why it did not run>', 'no fixtures');
  }

  test('#338 T1.1: the published example carries a smokeChecks entry the parser files', () => {
    const report = GateResultReport.parseBlock(fillExample(formatGateReportExample('PASSED')), 1);

    assert.strictEqual(report.smokeChecks.length, 1);
    assert.strictEqual(report.smokeChecks[0].id, 'check-1');
    assert.strictEqual(report.smokeChecks[0].label, 'app boots');
    // Strictly a boolean: a `"PASSED"` status string must never become a verdict.
    assert.strictEqual(report.smokeChecks[0].passed, true);
    assert.strictEqual(report.notRun.length, 1);
    assert.strictEqual(report.notRun[0].id, 'e2e');
    assert.strictEqual(report.notRun[0].reason, 'no fixtures');
    assert.strictEqual(report.smokeProtocol, 'PASSED');
  });

  test('#338 T1.2: a no-protocol plan is shown no invented check', () => {
    const example = formatGateReportExample(SMOKE_PROTOCOL_NOT_DECLARED);
    assert.ok(example.includes('"smokeChecks": []'), example);

    const report = GateResultReport.parseBlock(fillExample(example), 1);
    assert.strictEqual(report.smokeChecks.length, 0);
    assert.strictEqual(report.notRun.length, 1);
    assert.strictEqual(report.smokeProtocol, SMOKE_PROTOCOL_NOT_DECLARED);
  });

  test('#338 T1.3: the parser was not widened — the natural-but-undocumented shapes still fail', () => {
    const withStatusString = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (1 passed)", "testsPassed": 1, "testsFailed": 0,
  "durationMs": 1000, "executedCommands": ["npm test"],
  "smokeChecks": [{ "id": "check-1", "label": "app boots", "passed": "PASSED" }] }
`;
    assert.throws(
      () => GateResultReport.parseBlock(withStatusString, 1),
      (err: any) => err instanceof ValidationError && err.field === 'smokeChecks.passed'
    );

    const withBareStrings = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (1 passed)", "testsPassed": 1, "testsFailed": 0,
  "durationMs": 1000, "executedCommands": ["npm test"],
  "notRun": ["act: no CI-workflow simulation in scope"] }
`;
    assert.throws(
      () => GateResultReport.parseBlock(withBareStrings, 1),
      (err: any) => err instanceof ValidationError && err.field === 'notRun'
    );
  });
});
