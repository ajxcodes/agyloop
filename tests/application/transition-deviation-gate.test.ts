/**
 * agyloop - The REVIEW deviation gate (issue #432, TR-11..TR-14)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { TransitionStageUseCase, RunReviewUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  GateResultReport
} = require('../../dist/domain');

const REPORT = {
  verdict: 'PASSED',
  buildSystem: 'node',
  buildStatus: 'PASSED',
  testsStatus: 'PASSED (12 passed)',
  testsPassed: 12,
  testsFailed: 0,
  durationMs: 1000,
  executedCommands: ['npm run lint'],
  commandResults: [{ command: 'npm run lint', passed: 12, failed: 0 }],
  smokeChecks: [],
  smokeProtocol: 'NOT_DECLARED',
  notRun: [],
  gateRound: 1
};

class MemoryStateRepository {
  public snapshot: any;
  public loads = 0;
  public saves = 0;

  constructor(snapshot: any) {
    this.snapshot = snapshot;
  }
  load() {
    this.loads += 1;
    return this.snapshot;
  }
  save(snapshot: any) {
    this.snapshot = snapshot;
    this.saves += 1;
  }
  reset() {
    this.snapshot = null;
  }
  getStateFilePath() {
    return '/mock/state.json';
  }
}

class MemoryGateReportRepository {
  public clears = 0;
  public report: any;
  constructor(report: any) {
    this.report = report;
  }
  load() {
    return this.report;
  }
  save() {
    return '/mock/gate.json';
  }
  clear() {
    this.clears += 1;
  }
}

function atGate(): any {
  const sm = StateMachine.createInitial({ issue: 432 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  sm.setPlanDir('/mock/plans');
  sm.recordPlanDeviation({
    planSection: '§4.2',
    planLiteral: 'a === 1',
    implementedAssertion: 'a === 2',
    reason: 'pinned'
  });
  return sm;
}

function transitionUseCase(repo: MemoryStateRepository, gateRepo: any) {
  return new TransitionStageUseCase(
    repo as any,
    undefined,
    undefined,
    undefined,
    gateRepo as any,
    undefined,
    undefined
  );
}

describe('REVIEW deviation gate (issue #432)', () => {
  test('DVG1 transition REVIEW refuses an unacknowledged deviation and keeps the gate report', async () => {
    const repo = new MemoryStateRepository(atGate().toSnapshot());
    const before = JSON.stringify(repo.snapshot);
    const gateRepo = new MemoryGateReportRepository(GateResultReport.fromJSON(REPORT));

    await assert.rejects(
      () => transitionUseCase(repo, gateRepo).execute({ targetStage: STAGE_REVIEW, issue: 432 }),
      /PD-1/
    );
    assert.strictEqual(repo.loads, 1);
    assert.strictEqual(gateRepo.clears, 0, 'the filed report must not be consumed');
    assert.strictEqual(repo.saves, 0);
    assert.strictEqual(JSON.stringify(repo.snapshot), before, 'the checkpoint is byte-identical');
  });

  test('DVG2 acknowledging then advancing certifies the same round', async () => {
    const seed = atGate();
    seed.acknowledgePlanDeviation(seed.planDeviations[0].id, 'verified');
    const repo = new MemoryStateRepository(seed.toSnapshot());
    const gateRepo = new MemoryGateReportRepository(GateResultReport.fromJSON(REPORT));

    const sm = await transitionUseCase(repo, gateRepo).execute({
      targetStage: STAGE_REVIEW,
      issue: 432
    });
    assert.strictEqual(sm.currentStage, STAGE_REVIEW);
    assert.strictEqual(repo.snapshot.planDeviations[0].acknowledged, true);
  });

  test('DVG3 QUALITY_GATE -> PLAN clears the unacknowledged record', async () => {
    const repo = new MemoryStateRepository(atGate().toSnapshot());
    const gateRepo = new MemoryGateReportRepository(null);
    const sm = await transitionUseCase(repo, gateRepo).execute({
      targetStage: STAGE_PLAN,
      issue: 432
    });
    assert.strictEqual(sm.currentStage, STAGE_PLAN);
    // The machine is the snapshot the use case returns; its own getter is the
    // contract's `snapshot.planDeviations` (the serialized key is omitted when
    // empty, by AC7).
    const snapshot = sm;
    assert.deepStrictEqual(snapshot.planDeviations, []);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(repo.snapshot, 'planDeviations'),
      false
    );
  });

  test('DVG4 the direct review entry at QUALITY_GATE refuses too', async () => {
    const repo = new MemoryStateRepository(atGate().toSnapshot());
    const useCase = new RunReviewUseCase(repo as any, {} as any, {} as any);
    await assert.rejects(
      () => useCase.execute({ issue: 432, reviewOutput: 'REVIEW_STATUS: APPROVED\n' }),
      /PD-1/
    );
    assert.strictEqual(repo.saves, 0);
  });
});
