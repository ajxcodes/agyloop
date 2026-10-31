/**
 * agyloop - gate evidence coverage at the application seam (issue #408, D2)
 *
 * `assessGateEvidenceCoverage` resolves the plan through `PlanGeneratorPort`
 * and delegates to the pure domain matcher. It is the ONE assessment both
 * `codeloop gate-report` (filing) and `transition REVIEW` (ingest) run, so the
 * two cannot disagree. Only a PASSED block certifies, and a plan with no
 * declared targets keeps the pre-#408 behaviour.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { assessGateEvidenceCoverage } = require('../../dist/application');
const { GateResultReport, formatGateTargetCoverageRefusal } = require('../../dist/domain');

const PLAN_PATH = '/fake/artifacts/plans/408-smoke/implementation_plan.md';
const FOUR_TARGET_PLAN = [
  '# [Implementation] - probe',
  '',
  '### Quality Gate Targets',
  '',
  '- `npm run build`',
  '- `npm run typecheck`',
  '- `npm run lint`',
  '- `npm test`',
  ''
].join('\n');
const NO_TARGET_PLAN = ['# [Implementation] - probe', '', '- [ ] Step 1: probe', ''].join('\n');

/** A `PlanGeneratorPort` double holding one document. */
function fakeGenerator(options: {
  planPath?: string | null;
  doc?: string;
  throwOnRead?: boolean;
}) {
  return {
    resolvePlanFile: () =>
      options.planPath === null
        ? null
        : {
            planDir: '/fake/artifacts/plans/408-smoke',
            planPath: options.planPath ?? PLAN_PATH,
            planFileName: 'implementation_plan.md'
          },
    readPlanDocument: () => {
      if (options.throwOnRead) {
        throw new Error('unreadable');
      }
      return options.doc ?? '';
    }
  };
}

/** A filed report with the given verdict and executed commands. */
function report(verdict: string, executed: string[], results: Array<{ command: string }> = []) {
  return GateResultReport.fromJSON({
    verdict,
    buildSystem: 'node',
    buildStatus: verdict,
    testsStatus: verdict === 'PASSED' ? 'PASSED (1 passed)' : 'FAILED (1 failed)',
    testsPassed: verdict === 'PASSED' ? 1 : 0,
    testsFailed: verdict === 'PASSED' ? 0 : 1,
    durationMs: 1000,
    executedCommands: executed,
    commandResults: results,
    smokeProtocol: 'NOT_DECLARED',
    notRun: []
  });
}

describe('assessGateEvidenceCoverage (issue #408)', () => {
  test('T-APP-1: a PASSED one-command report misses the other declared targets', () => {
    const coverage = assessGateEvidenceCoverage({
      planGenerator: fakeGenerator({ doc: FOUR_TARGET_PLAN }),
      workspaceDir: '/fake',
      issue: 408,
      report: report('PASSED', ['npm run build'])
    });

    assert.strictEqual(coverage.assessed, true);
    assert.strictEqual(coverage.covered, false);
    assert.deepStrictEqual(coverage.missing, ['npm run typecheck', 'npm run lint', 'npm test']);
  });

  test('T-APP-2: a FAILED report is never coverage-checked', () => {
    const coverage = assessGateEvidenceCoverage({
      planGenerator: fakeGenerator({ doc: FOUR_TARGET_PLAN }),
      workspaceDir: '/fake',
      issue: 408,
      report: report('FAILED', [])
    });

    assert.strictEqual(coverage.assessed, false);
    assert.strictEqual(coverage.covered, true);
  });

  test('T-APP-3: an unresolvable plan keeps the pre-#408 behaviour', () => {
    const coverage = assessGateEvidenceCoverage({
      planGenerator: fakeGenerator({ planPath: null }),
      workspaceDir: '/fake',
      issue: 408,
      report: report('PASSED', [])
    });

    assert.strictEqual(coverage.assessed, false);
    assert.strictEqual(coverage.covered, true);
  });

  test('T-APP-4: a plan with no targets section is not checked', () => {
    const coverage = assessGateEvidenceCoverage({
      planGenerator: fakeGenerator({ doc: NO_TARGET_PLAN }),
      workspaceDir: '/fake',
      issue: 408,
      report: report('PASSED', [])
    });

    assert.strictEqual(coverage.assessed, false);
    assert.strictEqual(coverage.covered, true);
  });

  test('T-APP-5: an unreadable plan does not throw', () => {
    const coverage = assessGateEvidenceCoverage({
      planGenerator: fakeGenerator({ throwOnRead: true }),
      workspaceDir: '/fake',
      issue: 408,
      report: report('PASSED', [])
    });

    assert.strictEqual(coverage.assessed, false);
    assert.strictEqual(coverage.covered, true);
  });

  test('T-APP-6: the filing refusal names every missing command', () => {
    const message = formatGateTargetCoverageRefusal(
      ['npm run typecheck', 'npm run lint', 'npm test'],
      4,
      408,
      'filing'
    );

    assert.ok(message.includes('Missing 3 of 4'), message);
    for (const command of ['npm run typecheck', 'npm run lint', 'npm test']) {
      assert.ok(message.includes(`\`${command}\``), `${command} must be named:\n${message}`);
    }
    assert.ok(message.includes('codeloop gate-report --issue 408 --report-file <path>'), message);
    assert.ok(message.includes('Nothing was written'), message);
  });

  test('T-APP-7: the ingest refusal says the evidence SURVIVED', () => {
    const message = formatGateTargetCoverageRefusal(
      ['npm run typecheck', 'npm run lint', 'npm test'],
      4,
      408,
      'ingest'
    );

    assert.ok(message.includes('NOT consumed'), message);
    assert.ok(message.includes('still readable'), message);
    assert.ok(message.includes('unchanged at QUALITY_GATE'), message);
    assert.ok(!message.includes('Nothing was written'), message);
    assert.ok(!message.includes('report is gone'), message);
  });
});
