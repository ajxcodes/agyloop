/**
 * agyloop - Smoke protocol approval guard tests (issue #388, Defect 2)
 *
 * SPA1 - a plan whose frozen smoke block writes `.agyloop/tasks/<n>.json`
 *        without creating the parent is refused at `transition APPROVAL`; the
 *        checkpoint stays at PLAN and nothing is saved
 * SPA2 - the SAME plan with ONE `mkdir -p` line is approved unchanged, so a
 *        gate never needs to edit the frozen script
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TransitionStageUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  MODE_STANDARD,
  ValidationError
} = require('../../dist/domain');

const ISSUE = 388;
const SEED =
  'node -e \'const fs=require("fs");fs.writeFileSync(".agyloop/tasks/388.json", "{}")\'';

function planWithSmoke(bodyLines: string[]): string {
  return [
    '# [Implementation] - smoke probe',
    '',
    '## 3. Implementation Steps',
    '- [ ] **Step 1:** hold',
    '',
    '### Manual Smoke Test Protocol',
    '',
    '```bash',
    ...bodyLines,
    '```',
    ''
  ].join('\n');
}

class MockStateRepository {
  public snapshot: any;
  public saveCallCount = 0;

  constructor(initial: any) {
    this.snapshot = initial;
  }

  public load(): any {
    return this.snapshot;
  }

  public save(snapshot: any): void {
    this.snapshot = snapshot;
    this.saveCallCount++;
  }

  public reset(): void {
    this.snapshot = null;
  }

  public getStateFilePath(): string {
    return '/mock/state.json';
  }
}

function makePlanGenerator(planDir: string, planPath: string): any {
  return {
    resolvePlanFile: () => ({
      planDir,
      planPath,
      planFileName: path.basename(planPath),
      summaryPath: path.join(planDir, 'AgyLoop Summary.md')
    }),
    readPlanDocument: (target: string) => fs.readFileSync(target, 'utf8'),
    hashPlanDocument: (target: string) => `sha256:${fs.readFileSync(target, 'utf8')}`,
    updateSummaryLog: () => true
  };
}

describe('Smoke protocol approval guard (issue #388)', () => {
  let root: string;
  let planDir: string;
  let planPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-smoke-approval-'));
    planDir = path.join(root, 'artifacts/plans/388-smoke');
    fs.mkdirSync(planDir, { recursive: true });
    planPath = path.join(planDir, 'implementation_plan.md');
    fs.writeFileSync(planPath, planWithSmoke([SEED]), 'utf8');
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  function stateAtPlan(): MockStateRepository {
    const sm = StateMachine.createInitial({ issue: ISSUE, mode: MODE_STANDARD });
    sm.setPlanDir(planDir);
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    return new MockStateRepository(sm.toSnapshot());
  }

  test('SPA1: the seed-broken protocol is refused at APPROVAL and nothing is saved', async () => {
    const stateRepo = stateAtPlan();
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath)
    );

    await assert.rejects(
      () => useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root }),
      (err: any) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err}`);
        assert.strictEqual(err.field, 'smokeProtocol');
        assert.ok(err.message.includes('missing-parent-directory'), err.message);
        assert.ok(err.message.includes('.agyloop/tasks'), err.message);
        return true;
      }
    );

    assert.strictEqual(stateRepo.saveCallCount, 0);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_PLAN);
  });

  test('SPA2: one mkdir line makes the same plan approvable unchanged', async () => {
    fs.writeFileSync(planPath, planWithSmoke(['mkdir -p .agyloop/tasks', SEED]), 'utf8');
    const stateRepo = stateAtPlan();
    const useCase = new TransitionStageUseCase(
      stateRepo as any,
      undefined,
      undefined,
      makePlanGenerator(planDir, planPath)
    );

    const approved = await useCase.execute({ targetStage: STAGE_APPROVAL, workspaceDir: root });
    assert.strictEqual(approved.currentStage, STAGE_APPROVAL);
    assert.strictEqual(stateRepo.saveCallCount, 1);
    assert.strictEqual(stateRepo.snapshot.currentStage, STAGE_APPROVAL);
  });
});
