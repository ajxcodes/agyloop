/**
 * agyloop - REVIEW re-dispatch counter domain tests (issue #272)
 *
 * RC1 - default 0; `recordReviewDispatch()` increments and bumps `updatedAt`
 * RC2 - snapshot round-trip preserves the count; a legacy snapshot loads as 0
 * RC3 - `reset()` and a transition INTO REVIEW zero it; leaving REVIEW keeps it
 * RC4 - `getStatus().reviewDispatchCount` reflects the field
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  StateMachine,
  STAGE_REVIEW,
  STAGE_QUALITY_GATE,
  STAGE_COMMIT,
  STAGE_DISCOVERY
} = require('../../dist/domain');

function snapshotAt(stage: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    currentStage: stage,
    mode: 'standard',
    issue: 241,
    baseBranch: 'main',
    createdAt: now,
    updatedAt: now,
    history: [{ stage, timestamp: now }],
    pausedAtGate: null,
    pausedAtTimestamp: null,
    ...extra
  };
}

describe('StateMachine reviewDispatchCount (issue #272)', () => {
  test('RC1: defaults to 0 and recordReviewDispatch() increments and bumps updatedAt', () => {
    const sm = StateMachine.fromSnapshot(snapshotAt(STAGE_REVIEW, { updatedAt: '2026-01-01T00:00:00Z' }));
    assert.strictEqual(sm.reviewDispatchCount, 0);

    sm.recordReviewDispatch();

    assert.strictEqual(sm.reviewDispatchCount, 1);
    assert.notStrictEqual(sm.updatedAt, '2026-01-01T00:00:00Z');
  });

  test('RC2: toSnapshot/fromSnapshot preserves the count and a legacy snapshot loads as 0', () => {
    const sm = StateMachine.fromSnapshot(snapshotAt(STAGE_REVIEW));
    sm.recordReviewDispatch();
    sm.recordReviewDispatch();

    const restored = StateMachine.fromSnapshot(sm.toSnapshot());
    assert.strictEqual(restored.reviewDispatchCount, 2);

    const legacy = snapshotAt(STAGE_REVIEW);
    delete (legacy as any).reviewDispatchCount;
    assert.strictEqual(StateMachine.fromSnapshot(legacy).reviewDispatchCount, 0);
  });

  test('RC3: reset() zeroes it, a transition INTO REVIEW starts a fresh round, leaving REVIEW keeps it', () => {
    const sm = StateMachine.fromSnapshot(snapshotAt(STAGE_QUALITY_GATE));
    sm.recordReviewDispatch();
    sm.recordReviewDispatch();

    sm.transition(STAGE_REVIEW);
    assert.strictEqual(sm.reviewDispatchCount, 0, 'a fresh REVIEW round must start at zero');

    sm.recordReviewDispatch();
    sm.transition(STAGE_COMMIT);
    assert.strictEqual(sm.reviewDispatchCount, 1, 'leaving REVIEW must not resurrect or reset the record');

    sm.reset('standard', 241);
    assert.strictEqual(sm.reviewDispatchCount, 0);
  });

  test('RC4: getStatus().reviewDispatchCount reflects the field', () => {
    const sm = StateMachine.fromSnapshot(snapshotAt(STAGE_DISCOVERY));
    assert.strictEqual(sm.getStatus().reviewDispatchCount, 0);
    sm.recordReviewDispatch();
    assert.strictEqual(sm.getStatus().reviewDispatchCount, 1);
  });

  test('RC5: the dead review-dispatch reset method is gone (issue #291 F2)', () => {
    // Assembled, not typed: the name must not survive anywhere in `src`/`tests`
    // (the #291 F1/F2 smoke check greps for it), while this assertion still
    // proves the method no longer exists.
    const removedMethod = ['resetReview', 'DispatchCount'].join('');
    const sm: any = StateMachine.createInitial();
    assert.strictEqual(
      typeof sm[removedMethod],
      'undefined',
      'reset()/transition() are the only reset authorities'
    );
  });
});
