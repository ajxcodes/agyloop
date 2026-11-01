/**
 * agyloop - StateMachine plan deviations (issue #432, TR-4..TR-6)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  StateMachine,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW
} = require('../../dist/domain');

const PROPS = {
  planSection: '§4.2',
  planLiteral: 'a === 1',
  implementedAssertion: 'a === 2',
  reason: 'the pinned case is authoritative'
};

function machineAt(stage: string): any {
  const sm = StateMachine.createInitial({ issue: 432 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  if (stage === STAGE_PLAN) return sm;
  sm.transition(STAGE_APPROVAL);
  if (stage === STAGE_APPROVAL) return sm;
  sm.transition(STAGE_IMPLEMENT);
  if (stage === STAGE_IMPLEMENT) return sm;
  sm.transition(STAGE_QUALITY_GATE);
  if (stage === STAGE_QUALITY_GATE) return sm;
  sm.transition(STAGE_REVIEW);
  return sm;
}

describe('StateMachine plan deviations (issue #432)', () => {
  test('SMD1 an untouched machine omits planDeviations from its snapshot', () => {
    const sm = machineAt(STAGE_PLAN);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(sm.toSnapshot(), 'planDeviations'),
      false
    );
  });

  test('SMD2 entering PLAN clears the records', () => {
    const sm = machineAt(STAGE_IMPLEMENT);
    sm.recordPlanDeviation(PROPS);
    assert.strictEqual(sm.planDeviations.length, 1);
    // QUALITY_GATE -> IMPLEMENT preserves, IMPLEMENT has no PLAN target, so use
    // the legal QUALITY_GATE -> PLAN recovery route.
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_PLAN);
    assert.deepStrictEqual(sm.planDeviations, []);
  });

  test('SMD3 a gate retry preserves the acknowledgement', () => {
    const sm = machineAt(STAGE_QUALITY_GATE);
    const record = sm.recordPlanDeviation(PROPS);
    assert.strictEqual(sm.acknowledgePlanDeviation(record.id, 'verified'), true);
    sm.transition(STAGE_IMPLEMENT);
    assert.strictEqual(sm.planDeviations.length, 1);
    assert.strictEqual(sm.planDeviations[0].acknowledged, true);
    assert.strictEqual(sm.planDeviations[0].acknowledgementReason, 'verified');
  });

  test('SMD4 dedupe and round-trip: the same triple keeps one id', () => {
    const sm = machineAt(STAGE_IMPLEMENT);
    const first = sm.recordPlanDeviation(PROPS);
    const second = sm.recordPlanDeviation({ ...PROPS, reason: 'restated' });
    assert.strictEqual(first.id, second.id);
    assert.strictEqual(sm.planDeviations.length, 1);

    const revived = StateMachine.fromSnapshot(sm.toSnapshot());
    assert.strictEqual(revived.planDeviations.length, 1);
    assert.strictEqual(revived.planDeviations[0].planLiteral, PROPS.planLiteral);
  });
});
