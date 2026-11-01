/**
 * agyloop - ManagePlanDeviationsUseCase (issue #432, TR-7..TR-10)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { ManagePlanDeviationsUseCase } = require('../../dist/application');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE
} = require('../../dist/domain');

const BLOCK = [
  'PLAN_DEVIATION:',
  '{ "planSection": "§4.2", "planLiteral": "a === 1", "implementedAssertion": "a === 2", "reason": "pinned" }'
].join('\n');

class MemoryStateRepository {
  public snapshot: any;
  public saveCount = 0;

  constructor(snapshot: any) {
    this.snapshot = snapshot;
  }
  load() {
    return this.snapshot;
  }
  save(snapshot: any) {
    this.snapshot = snapshot;
    this.saveCount += 1;
  }
  reset() {
    this.snapshot = null;
  }
  getStateFilePath() {
    return '/mock/state.json';
  }
}

function machine(stage: string): any {
  const sm = StateMachine.createInitial({ issue: 432 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  if (stage === STAGE_PLAN) return sm;
  sm.transition(STAGE_APPROVAL);
  if (stage === STAGE_APPROVAL) return sm;
  sm.transition(STAGE_IMPLEMENT);
  if (stage === STAGE_IMPLEMENT) return sm;
  sm.transition(STAGE_QUALITY_GATE);
  return sm;
}

describe('ManagePlanDeviationsUseCase (issue #432)', () => {
  test('PDU1 filing at IMPLEMENT persists a record and its id', async () => {
    const repo = new MemoryStateRepository(machine(STAGE_IMPLEMENT).toSnapshot());
    const result = await new ManagePlanDeviationsUseCase(repo as any).file({ text: BLOCK });
    assert.strictEqual(repo.saveCount, 1);
    assert.strictEqual(result.id, 'PD-1');
    const saved = repo.snapshot.planDeviations;
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].id, 'PD-1');
    assert.strictEqual(saved[0].acknowledged, false);
  });

  test('PDU2 filing is refused outside IMPLEMENT and QUALITY_GATE', async () => {
    const repo = new MemoryStateRepository(machine(STAGE_PLAN).toSnapshot());
    await assert.rejects(
      () => new ManagePlanDeviationsUseCase(repo as any).file({ text: BLOCK }),
      /PLAN/
    );
    assert.strictEqual(repo.saveCount, 0);
  });

  test('PDU3 acknowledging without a reason writes nothing', async () => {
    const repo = new MemoryStateRepository(machine(STAGE_QUALITY_GATE).toSnapshot());
    const useCase = new ManagePlanDeviationsUseCase(repo as any);
    await useCase.file({ text: BLOCK });
    const before = JSON.stringify(repo.snapshot);
    const savesAfterFile = repo.saveCount;

    await assert.rejects(() => useCase.acknowledge({ id: 'PD-1', reason: null }), /reason/);
    assert.strictEqual(repo.saveCount, savesAfterFile);
    assert.strictEqual(JSON.stringify(repo.snapshot), before);
  });

  test('PDU4 acknowledging an unknown id lists the known ids', async () => {
    const repo = new MemoryStateRepository(machine(STAGE_QUALITY_GATE).toSnapshot());
    const useCase = new ManagePlanDeviationsUseCase(repo as any);
    await useCase.file({ text: BLOCK });

    await assert.rejects(
      () => useCase.acknowledge({ id: 'PD-9', reason: 'oops' }),
      /PD-1/
    );
    assert.strictEqual(repo.snapshot.planDeviations[0].acknowledged, false);
  });
});
