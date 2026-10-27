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
  GATE_REPORT_JSON_MARKER
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
