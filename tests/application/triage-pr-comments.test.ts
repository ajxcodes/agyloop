/**
 * agyloop - Triage PR Comments & Lifecycle Routing Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  TriagePrCommentsUseCase,
  GetNextActionUseCase,
  RunLifecycleUseCase
} = require('../../dist/application');
const {
  STAGE_TRIAGE,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  STAGE_DISCOVERY,
  STAGE_COMPLETED,
  STAGE_INITIALIZED,
  GATE_TRIAGE,
  StateMachine
} = require('../../dist/domain');

function makeMockStateRepo(initialSnapshot: any = null) {
  let current = initialSnapshot;
  return {
    load: async () => current,
    save: async (snap: any) => {
      current = snap;
    },
    exists: async () => current !== null,
    delete: async () => {
      current = null;
    }
  };
}

describe('TriagePrCommentsUseCase & Lifecycle Routing', () => {
  test('transitions state machine to STAGE_IMPLEMENT on triage action "implement"', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    sm.pauseAtGate(GATE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'implement',
      comments: [
        { author: 'reviewer', body: '[error] Fix this bug', category: 'error' }
      ]
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.targetStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(result.comments.length, 1);
  });

  test('transitions state machine to STAGE_PLAN on triage action "plan"', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'plan'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.targetStage, STAGE_PLAN);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_PLAN);
  });

  test('transitions state machine to STAGE_DISCOVERY on triage action "discovery"', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'discovery'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.targetStage, STAGE_DISCOVERY);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_DISCOVERY);
  });

  test('transitions state machine to STAGE_COMPLETED on triage action "dismiss"', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());

    const useCase = new TriagePrCommentsUseCase(stateRepo as any);
    const result = await useCase.execute({
      issue: 83,
      action: 'dismiss'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.targetStage, STAGE_COMPLETED);
    assert.strictEqual(result.stateMachine.currentStage, STAGE_COMPLETED);
  });

  test('getNextAction returns human_gate for STAGE_TRIAGE prompting triage execution', async () => {
    const sm = StateMachine.createInitial({ issue: 83 });
    sm.transition(STAGE_TRIAGE);
    const stateRepo = makeMockStateRepo(sm.toSnapshot());
    const configRepo = {
      loadConfig: () => ({
        options: {},
        subagents: {}
      })
    };

    const getNext = new GetNextActionUseCase(stateRepo as any, configRepo as any);
    const action = await getNext.execute({ issue: 83 });

    assert.strictEqual(action.currentStage, STAGE_TRIAGE);
    assert.strictEqual(action.actionType, 'human_gate');
    assert.ok(action.title.includes('Triage'));
    assert.ok(action.humanSummary.includes('triage'));
  });
});
