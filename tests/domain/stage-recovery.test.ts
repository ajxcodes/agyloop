/**
 * agyloop - Stage recovery path tests (issue #327, Defect 2)
 *
 * RG1 - the table widened by exactly one recovery hop (QUALITY_GATE -> PLAN)
 * RG2 - ONE legality predicate: `Stage.canTransitionTo` delegates to it
 * RG3 - the BFS returns the legal walk-back, not a forward detour
 * RG4 - the rendered commands are the hops the table allows
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  Stage,
  isLegalTransition,
  findLegalTransitionPath,
  formatTransitionRecoveryCommands,
  ALLOWED_TRANSITIONS,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_TRIAGE,
  MODE_STANDARD,
  MODE_YOLO
} = require('../../dist/domain');

describe('transition table recovery hop (#327 AC-3)', () => {
  test('RG1: QUALITY_GATE -> PLAN is legal and -> APPROVAL is still not', () => {
    assert.ok(
      ALLOWED_TRANSITIONS[STAGE_QUALITY_GATE].includes(STAGE_PLAN),
      'a gate that refuses to certify a plan must be able to send it back to planning'
    );
    assert.ok(!ALLOWED_TRANSITIONS[STAGE_QUALITY_GATE].includes(STAGE_APPROVAL));
    assert.ok(ALLOWED_TRANSITIONS[STAGE_QUALITY_GATE].includes(STAGE_REVIEW));
    assert.ok(ALLOWED_TRANSITIONS[STAGE_QUALITY_GATE].includes(STAGE_IMPLEMENT));
    assert.ok(ALLOWED_TRANSITIONS[STAGE_QUALITY_GATE].includes(STAGE_TRIAGE));
  });

  test('RG1b: the widening did not add any hop to the other stages', () => {
    assert.ok(!ALLOWED_TRANSITIONS[STAGE_IMPLEMENT].includes(STAGE_REVIEW));
    assert.ok(!ALLOWED_TRANSITIONS[STAGE_REVIEW].includes(STAGE_QUALITY_GATE));
    assert.ok(!ALLOWED_TRANSITIONS[STAGE_REVIEW].includes(STAGE_PLAN));
    assert.ok(!ALLOWED_TRANSITIONS[STAGE_DISCOVERY].includes(STAGE_IMPLEMENT));
  });
});

describe('isLegalTransition is the ONE predicate (#327)', () => {
  test('RG2: Stage.canTransitionTo agrees with isLegalTransition', () => {
    const from = new Stage(STAGE_PLAN);
    const toImplement = new Stage(STAGE_IMPLEMENT);

    assert.strictEqual(from.canTransitionTo(toImplement, MODE_STANDARD), false);
    assert.strictEqual(isLegalTransition(STAGE_PLAN, STAGE_IMPLEMENT, MODE_STANDARD), false);

    assert.strictEqual(from.canTransitionTo(toImplement, MODE_YOLO), true);
    assert.strictEqual(isLegalTransition(STAGE_PLAN, STAGE_IMPLEMENT, MODE_YOLO), true);
  });

  test('RG2b: an unknown source stage is never legal', () => {
    assert.strictEqual(isLegalTransition('NOPE', STAGE_PLAN, MODE_STANDARD), false);
  });
});

describe('findLegalTransitionPath (#327)', () => {
  test('RG3: REVIEW walks back through IMPLEMENT, not forward through COMMIT', () => {
    assert.deepStrictEqual(findLegalTransitionPath(STAGE_REVIEW, STAGE_QUALITY_GATE, MODE_STANDARD), [
      STAGE_IMPLEMENT,
      STAGE_QUALITY_GATE
    ]);
  });

  test('RG3b: COMMIT and COMPLETED reach the gate directly', () => {
    assert.deepStrictEqual(findLegalTransitionPath(STAGE_COMMIT, STAGE_QUALITY_GATE, MODE_STANDARD), [
      STAGE_QUALITY_GATE
    ]);
    assert.deepStrictEqual(
      findLegalTransitionPath(STAGE_COMPLETED, STAGE_QUALITY_GATE, MODE_STANDARD),
      [STAGE_QUALITY_GATE]
    );
  });

  test('RG3c: TRIAGE walks back through IMPLEMENT', () => {
    assert.deepStrictEqual(findLegalTransitionPath(STAGE_TRIAGE, STAGE_QUALITY_GATE, MODE_STANDARD), [
      STAGE_IMPLEMENT,
      STAGE_QUALITY_GATE
    ]);
  });

  test('RG3d: same stage is an empty path; an unreachable or unknown source is null', () => {
    assert.deepStrictEqual(findLegalTransitionPath(STAGE_REVIEW, STAGE_REVIEW, MODE_STANDARD), []);
    assert.strictEqual(findLegalTransitionPath(null, STAGE_QUALITY_GATE, MODE_STANDARD), null);
    assert.strictEqual(findLegalTransitionPath('NOPE', STAGE_QUALITY_GATE, MODE_STANDARD), null);
    assert.strictEqual(
      findLegalTransitionPath(STAGE_INITIALIZED, 'NOPE', MODE_STANDARD),
      null,
      'an unknown target is unreachable'
    );
  });
});

describe('formatTransitionRecoveryCommands (#327 AC-5)', () => {
  test('RG4: every hop is rendered as the transition command with the issue', () => {
    assert.strictEqual(
      formatTransitionRecoveryCommands(STAGE_REVIEW, STAGE_QUALITY_GATE, 702, MODE_STANDARD),
      'codeloop transition IMPLEMENT --issue 702, then codeloop transition QUALITY_GATE --issue 702'
    );
    assert.strictEqual(
      formatTransitionRecoveryCommands(STAGE_COMMIT, STAGE_QUALITY_GATE, 702, MODE_STANDARD),
      'codeloop transition QUALITY_GATE --issue 702'
    );
  });

  test('RG4b: no issue token drops the flag; no path and no source yield null', () => {
    assert.strictEqual(
      formatTransitionRecoveryCommands(STAGE_REVIEW, STAGE_QUALITY_GATE, null, MODE_STANDARD),
      'codeloop transition IMPLEMENT, then codeloop transition QUALITY_GATE'
    );
    assert.strictEqual(
      formatTransitionRecoveryCommands(STAGE_REVIEW, STAGE_REVIEW, 1, MODE_STANDARD),
      ''
    );
    assert.strictEqual(
      formatTransitionRecoveryCommands(null, STAGE_QUALITY_GATE, 1, MODE_STANDARD),
      null
    );
  });

  test('RG4c: the rendered hops are all table-legal from the stage before them', () => {
    const path = findLegalTransitionPath(STAGE_REVIEW, STAGE_QUALITY_GATE, MODE_STANDARD);
    let current = STAGE_REVIEW;
    for (const target of path) {
      assert.ok(
        ALLOWED_TRANSITIONS[current].includes(target),
        `${current} -> ${target} must be legal`
      );
      current = target;
    }
    assert.strictEqual(current, STAGE_QUALITY_GATE);
  });
});
