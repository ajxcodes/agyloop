/**
 * agyloop - smoke check coverage (issue #444)
 *
 * A PASSED gate report must evidence the plan's frozen
 * `### Manual Smoke Test Protocol`. The plan is the SOLE authority for check
 * identity (`check-1 … check-N`); a report that declares NOT_DECLARED, covers a
 * subset, re-labels an id, duplicates one or lists a check in `notRun` does not
 * cover the protocol. A FAILED report is exempt (it is the "go fix it" exit).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  SmokeProtocol,
  assessSmokeCheckCoverage,
  formatSmokeCheckId,
  formatGateSmokeCoverageRefusal
} = require('../../dist/domain');

const FOUR_CHECK_PLAN = [
  '# [Implementation] - probe',
  '',
  '### Manual Smoke Test Protocol',
  '',
  '#### Check 1 — one',
  '',
  '```bash',
  'echo one',
  '```',
  '',
  '#### Check 2 — two',
  '',
  '```bash',
  'echo two',
  '```',
  '',
  '#### Check 3 — three',
  '',
  '```bash',
  'echo three',
  '```',
  '',
  '#### Check 4 — four',
  '',
  '```bash',
  'echo four',
  '```',
  ''
].join('\n');

const NO_PROTOCOL_PLAN = ['# [Implementation] - probe', '', '- [ ] Step 1: probe', ''].join('\n');

const ALL_CHECKS = [
  { id: 'check-1', label: 'one', passed: true },
  { id: 'check-2', label: 'two', passed: true },
  { id: 'check-3', label: 'three', passed: true },
  { id: 'check-4', label: 'four', passed: true }
];

function protocol() {
  return SmokeProtocol.fromPlan(FOUR_CHECK_PLAN);
}

function evidence(overrides = {}) {
  return {
    verdict: 'PASSED',
    smokeProtocol: 'PASSED',
    smokeChecks: ALL_CHECKS,
    notRun: [],
    executedCommands: ['npm test'],
    ...overrides
  };
}

describe('assessSmokeCheckCoverage (issue #444)', () => {
  test('SCD1: a zero-check NOT_DECLARED report is refused and names every declared id', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({ smokeProtocol: 'NOT_DECLARED', smokeChecks: [] })
    );

    assert.strictEqual(coverage.covered, false);
    assert.deepStrictEqual(coverage.missing, ['check-1', 'check-2', 'check-3', 'check-4']);
    assert.strictEqual(coverage.reason, 'protocol-not-declared');
    assert.strictEqual(coverage.assessed, true);
  });

  test('SCD2: a subset report names only the ids it omitted', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({ smokeChecks: [{ id: 'check-1', label: 'one', passed: true }] })
    );

    assert.deepStrictEqual(coverage.missing, ['check-2', 'check-3', 'check-4']);
    assert.strictEqual(coverage.covered, false);
    assert.strictEqual(coverage.reason, 'missing');
  });

  test('SCD3: a full report is covered and the protocol is kept', () => {
    const coverage = assessSmokeCheckCoverage(protocol(), evidence());

    assert.strictEqual(coverage.covered, true);
    assert.strictEqual(coverage.reason, 'ok');
    assert.deepStrictEqual(coverage.declared, [
      'check-1',
      'check-2',
      'check-3',
      'check-4'
    ]);
    assert.strictEqual(coverage.assessed, true);
  });

  test('SCD4: a notRun entry for a declared check is refused as skipped', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({ notRun: [{ id: 'check-3', label: 'three', reason: 'skipped in this run' }] })
    );

    assert.deepStrictEqual(coverage.skipped, ['check-3']);
    assert.strictEqual(coverage.reason, 'skipped');
    assert.strictEqual(coverage.covered, false);
  });

  test('SCD5: a check reported failed or without a verdict is refused', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({
        smokeChecks: [
          { id: 'check-1', label: 'one', passed: true },
          { id: 'check-2', label: 'two', passed: false },
          { id: 'check-3', label: 'three', passed: true },
          { id: 'check-4', label: 'four', passed: null }
        ]
      })
    );

    assert.deepStrictEqual(coverage.failed, ['check-2', 'check-4']);
    assert.strictEqual(coverage.reason, 'failed');
  });

  test('SCD6: a renamed id is refused as unknown and its canonical target stays missing', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({
        smokeChecks: [
          { id: 'check-1', label: 'one', passed: true },
          { id: 'smoke-444-check-2', label: 'two', passed: true },
          { id: 'check-3', label: 'three', passed: true },
          { id: 'check-4', label: 'four', passed: true }
        ]
      })
    );

    assert.deepStrictEqual(coverage.unknown, ['smoke-444-check-2']);
    assert.deepStrictEqual(coverage.missing, ['check-2']);
    assert.strictEqual(coverage.reason, 'unknown');
  });

  test('SCD7: duplicate ids cannot masquerade as coverage', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({
        smokeChecks: [
          { id: 'check-1', label: 'one', passed: true },
          { id: 'check-1', label: 'one again', passed: true }
        ]
      })
    );

    assert.deepStrictEqual(coverage.duplicate, ['check-1']);
    assert.deepStrictEqual(coverage.missing, ['check-2', 'check-3', 'check-4']);
    assert.strictEqual(coverage.reason, 'duplicate');
  });

  test('SCD8: a legacy smoke-check-N label is normalised to the canonical id', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({
        smokeChecks: [],
        executedCommands: [
          'npm test',
          'smoke-check-1: PASSED',
          'smoke-check-2: PASSED',
          'smoke-check-3: PASSED',
          'smoke-check-4: PASSED'
        ]
      })
    );

    assert.strictEqual(coverage.covered, true);
    assert.deepStrictEqual(coverage.reported, [
      'check-1',
      'check-2',
      'check-3',
      'check-4'
    ]);
  });

  test('SCD9: a plan that declares no protocol is not assessed', () => {
    const coverage = assessSmokeCheckCoverage(
      SmokeProtocol.fromPlan(NO_PROTOCOL_PLAN),
      evidence({ smokeProtocol: 'NOT_DECLARED', smokeChecks: [] })
    );

    assert.strictEqual(coverage.assessed, false);
    assert.strictEqual(coverage.covered, true);
    assert.strictEqual(coverage.reason, 'not-assessed');
  });

  test('SCD10: a FAILED report is exempt', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({
        verdict: 'FAILED',
        smokeProtocol: 'NOT_DECLARED',
        smokeChecks: []
      })
    );

    assert.strictEqual(coverage.assessed, false);
    assert.strictEqual(coverage.covered, true);
  });

  test('SCD11: an omitted smokeProtocol on a PASSED report is refused', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({ smokeProtocol: null })
    );

    assert.strictEqual(coverage.reason, 'protocol-missing');
    assert.strictEqual(coverage.covered, false);
  });

  test('SCD12: a PASSED report declaring smokeProtocol FAILED is refused', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({ smokeProtocol: 'FAILED' })
    );

    assert.strictEqual(coverage.reason, 'protocol-failed');
    assert.strictEqual(coverage.covered, false);
  });

  test('SCD13: the refusal names the missing ids, the refile command and the channel tail', () => {
    const coverage = assessSmokeCheckCoverage(
      protocol(),
      evidence({ smokeProtocol: 'NOT_DECLARED', smokeChecks: [] })
    );
    const params = {
      reason: coverage.reason,
      protocol: 'NOT_DECLARED',
      declaredCount: coverage.declared.length,
      missing: coverage.missing,
      skipped: coverage.skipped,
      failed: coverage.failed,
      unknown: coverage.unknown,
      duplicate: coverage.duplicate,
      issue: 444
    };

    const message = formatGateSmokeCoverageRefusal({ ...params, channel: 'filing' });
    assert.ok(
      message.includes('codeloop gate-report --issue 444 --report-file <path>'),
      message
    );
    assert.ok(
      message.includes("does not evidence the plan's declared Manual Smoke Test Protocol"),
      message
    );
    for (const id of ['check-1', 'check-2', 'check-3', 'check-4']) {
      assert.ok(message.includes(`\`${id}\``), `${id} must be named:\n${message}`);
    }

    const ingest = formatGateSmokeCoverageRefusal({ ...params, channel: 'ingest' });
    const filing = formatGateSmokeCoverageRefusal({ ...params, channel: 'filing' });
    assert.ok(ingest.includes('NOT consumed'), ingest);
    assert.ok(ingest.includes('unchanged at QUALITY_GATE'), ingest);
    assert.ok(filing.includes('Nothing was written'), filing);
    assert.ok(!ingest.includes('Nothing was written'), ingest);
  });

  test('SCD14: formatSmokeCheckId is the one canonical id producer', () => {
    assert.strictEqual(formatSmokeCheckId(1), 'check-1');
    assert.strictEqual(formatSmokeCheckId(12), 'check-12');
  });
});
