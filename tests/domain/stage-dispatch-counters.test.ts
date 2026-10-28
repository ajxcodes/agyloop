/**
 * agyloop - Stage dispatch counters & re-plan transition tests
 *
 * Covers issue #292 (the DISCOVERY/PLAN re-dispatch record), issue #267 AC-A3
 * (`IMPLEMENT -> PLAN` is legal) and #267 AC-A5 (the blank-plan park counter).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  MODE_STANDARD,
  MODE_YOLO,
  PLAN_EMPTY_PARK_REPEAT_THRESHOLD
} = require('../../dist/domain');

function atImplementation(): any {
  const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 41 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  return sm;
}

describe('stage dispatch counters (#292)', () => {
  test('T-292.3: the three counters default to 0 and increment independently', () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    assert.strictEqual(sm.discoveryDispatchCount, 0);
    assert.strictEqual(sm.planDispatchCount, 0);
    assert.strictEqual(sm.planEmptyParkCount, 0);

    sm.recordDiscoveryDispatch();
    sm.recordDiscoveryDispatch();
    sm.recordPlanDispatch();
    sm.recordPlanEmptyPark();

    assert.strictEqual(sm.discoveryDispatchCount, 2);
    assert.strictEqual(sm.planDispatchCount, 1);
    assert.strictEqual(sm.planEmptyParkCount, 1);
  });

  test('T-292.3: the counters survive a snapshot round-trip', () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.recordDiscoveryDispatch();
    sm.recordDiscoveryDispatch();
    sm.recordPlanDispatch();

    const restored = StateMachine.fromSnapshot(sm.toSnapshot());
    assert.strictEqual(restored.discoveryDispatchCount, 2);
    assert.strictEqual(restored.planDispatchCount, 1);
    assert.strictEqual(restored.planEmptyParkCount, 0);
  });

  test('T-292.3: a legacy snapshot without the counters loads 0', () => {
    const legacy = StateMachine.createInitial({ issue: 41 }).toSnapshot() as any;
    delete legacy.discoveryDispatchCount;
    delete legacy.planDispatchCount;
    delete legacy.planEmptyParkCount;

    const restored = StateMachine.fromSnapshot(legacy);
    assert.strictEqual(restored.discoveryDispatchCount, 0);
    assert.strictEqual(restored.planDispatchCount, 0);
    assert.strictEqual(restored.planEmptyParkCount, 0);
  });

  test('T-292.3: a transition INTO the stage zeroes only its own counter', () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    sm.recordDiscoveryDispatch();
    sm.recordPlanDispatch();
    sm.recordPlanEmptyPark();

    sm.transition(STAGE_DISCOVERY);
    assert.strictEqual(sm.discoveryDispatchCount, 0, 'DISCOVERY resets its dispatch count');
    assert.strictEqual(sm.planDispatchCount, 1, 'the PLAN count is untouched');

    sm.transition(STAGE_PLAN);
    assert.strictEqual(sm.planDispatchCount, 0);
    assert.strictEqual(sm.planEmptyParkCount, 0, 're-planning clears the blank-plan park count');
  });

  test('T-292.3: reset() zeroes all three counters', () => {
    const sm = atImplementation();
    sm.recordDiscoveryDispatch();
    sm.recordPlanDispatch();
    sm.recordPlanEmptyPark();

    sm.reset(MODE_STANDARD, 41);
    assert.strictEqual(sm.discoveryDispatchCount, 0);
    assert.strictEqual(sm.planDispatchCount, 0);
    assert.strictEqual(sm.planEmptyParkCount, 0);
  });
});

describe('IMPLEMENT re-dispatch counter (#327)', () => {
  test('T-327.1: the counter defaults to 0 and increments independently', () => {
    const sm = StateMachine.createInitial({ issue: 41 });
    assert.strictEqual(sm.implementationDispatchCount, 0);

    sm.recordImplementationDispatch();
    sm.recordImplementationDispatch();

    assert.strictEqual(sm.implementationDispatchCount, 2);
    assert.strictEqual(sm.reviewDispatchCount, 0, 'the REVIEW counter is untouched');
  });

  test('T-327.2: the counter survives a snapshot round-trip and legacy checkpoints load 0', () => {
    const sm = atImplementation();
    sm.recordImplementationDispatch();

    const restored = StateMachine.fromSnapshot(sm.toSnapshot());
    assert.strictEqual(restored.implementationDispatchCount, 1);
    assert.strictEqual(restored.getStatus().implementationDispatchCount, 1);

    const legacy = StateMachine.createInitial({ issue: 41 }).toSnapshot() as any;
    delete legacy.implementationDispatchCount;
    assert.strictEqual(StateMachine.fromSnapshot(legacy).implementationDispatchCount, 0);
  });

  test('T-327.3: a transition INTO IMPLEMENT zeroes the counter', () => {
    const sm = atImplementation();
    sm.recordImplementationDispatch();
    sm.recordImplementationDispatch();

    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    assert.strictEqual(
      sm.implementationDispatchCount,
      2,
      'leaving IMPLEMENT does not clear the record'
    );

    sm.transition(STAGE_IMPLEMENT);
    assert.strictEqual(sm.implementationDispatchCount, 0, 'a fresh implementation round starts at 0');
  });

  test('T-327.4: reset() zeroes the counter', () => {
    const sm = atImplementation();
    sm.recordImplementationDispatch();

    sm.reset(MODE_STANDARD, 41);
    assert.strictEqual(sm.implementationDispatchCount, 0);
  });
});

describe('blank-plan park repeat threshold (#267 AC-A5)', () => {
  test('the threshold is ONE domain constant (2)', () => {
    assert.strictEqual(PLAN_EMPTY_PARK_REPEAT_THRESHOLD, 2);
  });
});

describe('IMPLEMENT -> PLAN recovery transition (#267 AC-A3)', () => {
  test('T-267.A3: canTransition(PLAN) is true from IMPLEMENT and the history records it', () => {
    const sm = atImplementation();
    assert.strictEqual(sm.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(sm.canTransition(STAGE_PLAN), true);

    sm.transition(STAGE_PLAN, { note: 'blank-plan recovery' });
    assert.strictEqual(sm.currentStage, STAGE_PLAN);
    const entry = sm.history[sm.history.length - 1];
    assert.strictEqual(entry.stage, STAGE_PLAN);
    assert.strictEqual(entry.metadata?.note, 'blank-plan recovery');
  });

  test('T-267.A3: unrelated transitions are still rejected', () => {
    const sm = atImplementation();
    assert.strictEqual(sm.canTransition(STAGE_INITIALIZED), false);
    assert.strictEqual(sm.canTransition(STAGE_APPROVAL), false);
  });

  test('T-267.A3: YOLO mode also permits the re-plan', () => {
    const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 41 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_IMPLEMENT);
    assert.strictEqual(sm.canTransition(STAGE_PLAN), true);
    sm.transition(STAGE_PLAN);
    assert.strictEqual(sm.currentStage, STAGE_PLAN);
  });
});
