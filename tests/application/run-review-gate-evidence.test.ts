/**
 * agyloop - `codeloop review` certifies the QUALITY_GATE exit (issue #455)
 *
 * RG1 - no filed report: the review entry refuses, writes nothing
 * RG2 - a usable round-1 report certifies, records provenance and is consumed
 * RG3 - an edited approved plan is refused (issue #421)
 * RG4 - a report that skips a declared target is refused (issue #408)
 * RG5 - a PASSED zero-test report is refused (issue #415)
 * RG6 - an unacknowledged deviation is refused after the evidence passes (#432)
 * RG7 - --dry-run warns instead of throwing and persists nothing
 * RG8 - the COMPLETED -> REVIEW re-entry needs no gate evidence
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { RunReviewUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  GateResultReport
} = require('../../dist/domain');
const { DEFAULT_CONFIG } = require('../../dist/infrastructure');

const ISSUE = 455;

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: the delivered change set is clean.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

const PLAN_ONE_TARGET = [
  '# [Implementation] - probe',
  '',
  '## 4. Quality Gate & Test Verification',
  '',
  '### Quality Gate Targets',
  '',
  '- `npm test`',
  ''
].join('\n');

const PLAN_TWO_TARGETS = [
  '# [Implementation] - probe',
  '',
  '## 4. Quality Gate & Test Verification',
  '',
  '### Quality Gate Targets',
  '',
  '- `npm run lint`',
  '- `npm test`',
  ''
].join('\n');

const USABLE_REPORT = {
  verdict: 'PASSED',
  buildSystem: 'node',
  buildStatus: 'PASSED',
  testsStatus: 'PASSED (12 passed)',
  testsPassed: 12,
  testsFailed: 0,
  durationMs: 1000,
  executedCommands: ['npm test'],
  commandResults: [],
  smokeChecks: [],
  smokeProtocol: 'NOT_DECLARED',
  notRun: [],
  gateRound: 1
};

class MemoryStateRepository {
  public snapshot: any;
  public events: any[];
  public loads = 0;
  public saves = 0;

  constructor(snapshot: any, events: any[]) {
    this.snapshot = snapshot;
    this.events = events;
  }

  load() {
    this.loads += 1;
    return this.snapshot;
  }

  save(snapshot: any) {
    this.snapshot = snapshot;
    this.saves += 1;
    this.events.push('state:save');
  }

  reset() {
    this.snapshot = null;
  }

  getStateFilePath() {
    return '/mock/state.json';
  }
}

class MemoryGateReportRepository {
  public report: any;
  public events: any[];
  public clears = 0;

  constructor(report: any, events: any[]) {
    this.report = report;
    this.events = events;
  }

  load() {
    return this.report;
  }

  save() {
    return '/mock/gate.json';
  }

  clear() {
    this.clears += 1;
    this.events.push('gate:clear');
  }
}

function atGate(planDir = '/mock/plans') {
  const sm = StateMachine.createInitial({ issue: ISSUE });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  sm.setPlanDir(planDir);
  return sm;
}

function completed() {
  const sm = atGate();
  sm.transition(STAGE_REVIEW);
  sm.transition(STAGE_COMMIT);
  sm.transition(STAGE_COMPLETED);
  return sm;
}

function planGeneratorFor(planPath: string, content: string, digest = 'same-digest') {
  return {
    resolvePlanFile: () => ({
      planDir: '/mock/plans',
      planPath,
      planFileName: 'implementation_plan.md'
    }),
    readPlanDocument: () => content,
    hashPlanDocument: () => digest,
    updateSummaryLog: () => true,
    scaffoldPlanDirectory: () => null,
    generatePlan: () => null,
    generateSummaryLog: () => null,
    findPlanDirectory: () => '/mock/plans'
  };
}

function configRepo() {
  return {
    loadConfig: () => DEFAULT_CONFIG,
    resolveModel: (role: string) => ({
      role,
      configured: 'flash',
      tier: 'flash',
      apiModel: 'gemini-3.5-flash'
    }),
    mapModelToTier: () => 'flash'
  };
}

function reviewUseCase(stateRepo: any, planGenerator: any, gateRepo: any) {
  return new RunReviewUseCase(
    stateRepo,
    configRepo(),
    planGenerator,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    gateRepo
  );
}

describe('review certifies the QUALITY_GATE exit (issue #455)', () => {
  test('RG1 review at QUALITY_GATE with no filed report refuses and writes nothing (issue #455)', async () => {
    const events: any[] = [];
    const repo = new MemoryStateRepository(atGate().toSnapshot(), events);
    const gateRepo = new MemoryGateReportRepository(null, events);
    const before = JSON.stringify(repo.snapshot);

    await assert.rejects(
      () =>
        reviewUseCase(repo, planGeneratorFor('/mock/plans/implementation_plan.md', PLAN_ONE_TARGET), gateRepo).execute({
          issue: ISSUE,
          reviewOutput: APPROVED_BLOCK
        }),
      (err: any) => {
        assert.strictEqual(err.field, 'gateEvidence');
        assert.match(String(err.message), /gate round 1/);
        return true;
      }
    );

    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(gateRepo.clears, 0, 'a refusal must not consume the report');
    assert.strictEqual(JSON.stringify(repo.snapshot), before);
    assert.ok(!repo.snapshot.history.some((entry: any) => entry.stage === STAGE_REVIEW));
  });

  test('RG2 a usable round-1 report certifies QUALITY_GATE -> REVIEW -> COMMIT and is consumed once (issue #455)', async () => {
    const events: any[] = [];
    const repo = new MemoryStateRepository(atGate().toSnapshot(), events);
    const gateRepo = new MemoryGateReportRepository(
      GateResultReport.fromJSON(USABLE_REPORT),
      events
    );

    const result = await reviewUseCase(
      repo,
      planGeneratorFor('/mock/plans/implementation_plan.md', PLAN_ONE_TARGET),
      gateRepo
    ).execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK });

    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    const reviewEntry = [...result.stateMachine.history]
      .reverse()
      .find((entry: any) => entry.stage === STAGE_REVIEW);
    assert.ok(reviewEntry, 'a REVIEW entry must be recorded');
    assert.strictEqual(reviewEntry.metadata.gateVerdict, 'PASSED');
    assert.strictEqual(reviewEntry.metadata.gateTests, 'PASSED (12 passed)');
    assert.strictEqual(gateRepo.clears, 1);
    assert.deepStrictEqual(events, ['state:save', 'gate:clear'], 'consume AFTER the commit');
  });

  test('RG3 an edited approved plan is refused by the review entry (issue #421)', async () => {
    const events: any[] = [];
    const repo = new MemoryStateRepository(atGate().toSnapshot(), events);
    const gateRepo = new MemoryGateReportRepository(
      GateResultReport.fromJSON(USABLE_REPORT),
      events
    );
    const planPath = '/mock/plans/implementation_plan.md';
    const sm = atGate();
    sm.recordApprovedPlan(planPath, 'approved-digest');
    repo.snapshot = sm.toSnapshot();

    await assert.rejects(
      () =>
        reviewUseCase(
          repo,
          planGeneratorFor(planPath, PLAN_ONE_TARGET, 'edited-digest'),
          gateRepo
        ).execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK }),
      (err: any) => {
        assert.strictEqual(err.field, 'approvedPlanDigest');
        assert.match(String(err.message), /approved plan changed during the quality gate/);
        return true;
      }
    );

    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(gateRepo.clears, 0);
  });

  test('RG4 a report that skips a declared target is refused by the review entry (issue #408)', async () => {
    const events: any[] = [];
    const repo = new MemoryStateRepository(atGate().toSnapshot(), events);
    const gateRepo = new MemoryGateReportRepository(
      GateResultReport.fromJSON({
        ...USABLE_REPORT,
        executedCommands: ['npm run lint']
      }),
      events
    );

    await assert.rejects(
      () =>
        reviewUseCase(
          repo,
          planGeneratorFor('/mock/plans/implementation_plan.md', PLAN_TWO_TARGETS),
          gateRepo
        ).execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK }),
      (err: any) => {
        assert.strictEqual(err.field, 'executedCommands');
        assert.match(String(err.message), /Missing 1 of 2 declared commands/);
        return true;
      }
    );

    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(gateRepo.clears, 0);
  });

  test('RG5 a PASSED zero-test report is refused by the review entry (issue #415)', async () => {
    const events: any[] = [];
    const repo = new MemoryStateRepository(atGate().toSnapshot(), events);
    const gateRepo = new MemoryGateReportRepository(
      GateResultReport.fromJSON({
        ...USABLE_REPORT,
        testsStatus: 'PASSED (0 passed)',
        testsPassed: 0
      }),
      events
    );

    await assert.rejects(
      () =>
        reviewUseCase(
          repo,
          planGeneratorFor('/mock/plans/implementation_plan.md', PLAN_ONE_TARGET),
          gateRepo
        ).execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK }),
      (err: any) => {
        assert.strictEqual(err.field, 'testsPassed');
        return true;
      }
    );

    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(gateRepo.clears, 0);
  });

  test('RG6 an unacknowledged deviation is still refused after the evidence passes (issue #432)', async () => {
    const events: any[] = [];
    const sm = atGate();
    sm.recordPlanDeviation({
      planSection: '§4.2',
      planLiteral: 'a === 1',
      implementedAssertion: 'a === 2',
      reason: 'pinned'
    });
    const repo = new MemoryStateRepository(sm.toSnapshot(), events);
    const gateRepo = new MemoryGateReportRepository(
      GateResultReport.fromJSON(USABLE_REPORT),
      events
    );

    await assert.rejects(
      () =>
        reviewUseCase(
          repo,
          planGeneratorFor('/mock/plans/implementation_plan.md', PLAN_ONE_TARGET),
          gateRepo
        ).execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK }),
      (err: any) => {
        assert.strictEqual(err.field, 'planDeviations');
        return true;
      }
    );

    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(gateRepo.clears, 0);
  });

  test('RG7 --dry-run warns instead of throwing and persists nothing', async () => {
    const events: any[] = [];
    const repo = new MemoryStateRepository(atGate().toSnapshot(), events);
    const gateRepo = new MemoryGateReportRepository(null, events);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    try {
      console.warn = (...args) => warnings.push(args.map(String).join(' '));
      const result = await reviewUseCase(
        repo,
        planGeneratorFor('/mock/plans/implementation_plan.md', PLAN_ONE_TARGET),
        gateRepo
      ).execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK, dryRun: true });

      assert.strictEqual(result.dryRun, true);
      assert.strictEqual(result.previousStage, STAGE_QUALITY_GATE);
    } finally {
      console.warn = originalWarn;
    }

    assert.match(warnings.join('\n'), /gate round 1/);
    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(gateRepo.clears, 0);
  });

  test('RG8 the COMPLETED -> REVIEW re-entry needs no gate evidence', async () => {
    const events: any[] = [];
    const repo = new MemoryStateRepository(completed().toSnapshot(), events);

    const result = await reviewUseCase(
      repo,
      planGeneratorFor('/mock/plans/implementation_plan.md', PLAN_ONE_TARGET),
      undefined
    ).execute({ issue: ISSUE, reviewOutput: APPROVED_BLOCK });

    assert.strictEqual(result.currentStage, STAGE_COMMIT);
    assert.strictEqual(repo.saves, 1);
  });
});
