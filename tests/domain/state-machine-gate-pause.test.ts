/**
 * agyloop - StateMachine Gate-Pause Consumption Tests
 *
 * THE BUG guarded here: `pauseAtGate()` set `pausedAtGate`/`pausedAtTimestamp`
 * and `transition()` never cleared them, so a CIRCUIT_BREAKER halt (exhausted
 * retry budget or provider quota rejection) left the checkpoint claiming "waiting
 * for a human" through EVERY subsequent stage transition, forever. Every read
 * path then reported a pause that no amount of running could clear.
 *
 * The subtle half of the fix is the regression guard: APPROVAL / COMMIT /
 * TRIAGE pauses exist precisely to wait for a human and MUST survive a
 * transition. `TransitionStageUseCase` depends on it (it transitions out of
 * APPROVAL/COMMIT only after the human answered, then re-pauses at the target).
 *
 * The third clause is issue #226: the rule is bounded by "the run finished".
 * `COMMIT -> COMPLETED` used to persist `{ currentStage: COMPLETED,
 * pausedAtGate: COMMIT }`, and since COMMIT is a HUMAN_WAIT_GATES member, no
 * later transition could ever clear it — `status` reported a finished pipeline
 * that was also "waiting on a human", and `totalHumanWaitMs` stayed 0 forever.
 * COMPLETED consumes the pause; every non-terminal target still preserves it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  StateMachine,
  GATE_APPROVAL,
  GATE_COMMIT,
  GATE_TRIAGE,
  GATE_CIRCUIT_BREAKER,
  HUMAN_WAIT_GATES,
  STAGE_APPROVAL,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_DISCOVERY,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_TRIAGE,
  MODE_STANDARD,
  MODE_YOLO
} = require('../../dist/domain');

/** Drives a machine to QUALITY_GATE in yolo mode (the stage a breaker trips on). */
function machineAtQualityGate(): any {
  const sm = StateMachine.createInitial({ mode: MODE_YOLO, issue: 218 });
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  return sm;
}

/**
 * Drives a machine the whole way to COMMIT in standard mode — the stage
 * `ExecuteCommitUseCase` resumes from when it finishes a run with
 * `COMMIT -> COMPLETED`.
 */
function machineAtCommitGate(): any {
  const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 1 });
  sm.transition(STAGE_DISCOVERY);
  sm.transition(STAGE_PLAN);
  sm.transition(STAGE_APPROVAL);
  sm.transition(STAGE_IMPLEMENT);
  sm.transition(STAGE_QUALITY_GATE);
  sm.transition(STAGE_REVIEW);
  sm.transition(STAGE_COMMIT);
  return sm;
}

describe('StateMachine gate-pause consumption on transition', () => {
  test('a CIRCUIT_BREAKER pause is consumed by the next transition', () => {
    const sm = machineAtQualityGate();

    sm.pauseAtGate(GATE_CIRCUIT_BREAKER);
    assert.strictEqual(sm.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.ok(sm.pausedAtTimestamp, 'the pause must carry a timestamp');

    sm.transition(STAGE_REVIEW);

    assert.strictEqual(
      sm.currentStage,
      STAGE_REVIEW,
      'the transition itself must still happen'
    );
    assert.strictEqual(
      sm.pausedAtGate,
      null,
      'advancing past a breaker gate must consume the pause (it was sticky forever)'
    );
    assert.strictEqual(sm.pausedAtTimestamp, null);
  });

  test('consuming a breaker pause banks the wait into totalHumanWaitMs (it stays out of active execution)', () => {
    const pausedAt = new Date(Date.now() - 5000).toISOString();
    // Seed the checkpoint with a pause that started 5s ago (pauseAtGate always
    // stamps "now", so the historical instant is injected through the snapshot).
    const paused = StateMachine.fromSnapshot({
      ...machineAtQualityGate().toSnapshot(),
      pausedAtGate: GATE_CIRCUIT_BREAKER,
      pausedAtTimestamp: pausedAt
    });

    assert.strictEqual(paused.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.strictEqual(paused.totalHumanWaitMs, 0);
    // While paused, the open pause is subtracted from the active duration.
    assert.ok(
      paused.activeExecutionDurationMs() >= 0,
      'active duration must never go negative while paused'
    );

    paused.transition(STAGE_REVIEW);

    assert.strictEqual(paused.pausedAtGate, null);
    assert.ok(
      paused.totalHumanWaitMs >= 4000,
      `expected ~5000ms of human wait to be banked, got ${paused.totalHumanWaitMs}`
    );
    assert.ok(
      paused.activeExecutionDurationMs() >= 0,
      'active duration must stay non-negative after the pause is consumed'
    );
  });

  test('an APPROVAL pause SURVIVES a transition (regression guard)', () => {
    const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 7 });
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);

    sm.pauseAtGate(GATE_APPROVAL);
    const pausedAt = sm.pausedAtTimestamp;
    assert.strictEqual(sm.pausedAtGate, GATE_APPROVAL);

    sm.transition(STAGE_IMPLEMENT);

    assert.strictEqual(sm.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(
      sm.pausedAtGate,
      GATE_APPROVAL,
      'the APPROVAL gate is a deliberate human wait and must not be auto-consumed'
    );
    assert.strictEqual(sm.pausedAtTimestamp, pausedAt);
    assert.strictEqual(sm.totalHumanWaitMs, 0, 'a surviving pause must not bank time yet');
  });

  test('a COMMIT pause SURVIVES a transition (regression guard)', () => {
    const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 8 });
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);
    sm.transition(STAGE_IMPLEMENT);
    sm.transition(STAGE_QUALITY_GATE);
    sm.transition(STAGE_REVIEW);
    sm.transition(STAGE_COMMIT);

    sm.pauseAtGate(GATE_COMMIT);
    const pausedAt = sm.pausedAtTimestamp;

    sm.transition(STAGE_QUALITY_GATE);

    assert.strictEqual(sm.currentStage, STAGE_QUALITY_GATE);
    assert.strictEqual(
      sm.pausedAtGate,
      GATE_COMMIT,
      'the COMMIT gate is a deliberate human wait and must not be auto-consumed'
    );
    assert.strictEqual(sm.pausedAtTimestamp, pausedAt);
  });

  test('a TRIAGE pause SURVIVES a transition (human triage, not a mechanical halt)', () => {
    const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 9 });
    sm.transition(STAGE_DISCOVERY);
    sm.transition(STAGE_TRIAGE);

    sm.pauseAtGate(GATE_TRIAGE);
    const pausedAt = sm.pausedAtTimestamp;

    sm.transition(STAGE_PLAN);

    assert.strictEqual(sm.currentStage, STAGE_PLAN);
    assert.strictEqual(
      sm.pausedAtGate,
      GATE_TRIAGE,
      'TRIAGE hands control back to a human; the pause must survive'
    );
    assert.strictEqual(sm.pausedAtTimestamp, pausedAt);
  });

  test('HUMAN_WAIT_GATES enumerates exactly the three human gates', () => {
    assert.deepStrictEqual(
      [...HUMAN_WAIT_GATES].sort(),
      [GATE_APPROVAL, GATE_COMMIT, GATE_TRIAGE].sort()
    );
    assert.ok(
      !HUMAN_WAIT_GATES.includes(GATE_CIRCUIT_BREAKER),
      'CIRCUIT_BREAKER is a mechanical halt and must be auto-consumed'
    );
  });

  test('an unknown/future gate name is treated as non-human and consumed (never sticky)', () => {
    const sm = machineAtQualityGate();
    sm.pauseAtGate('SOME_GATE_FROM_A_NEWER_BUILD');

    sm.transition(STAGE_REVIEW);

    assert.strictEqual(
      sm.pausedAtGate,
      null,
      'an unknown gate must not be able to make the checkpoint permanently sticky'
    );
  });

  test('pause consumption survives the snapshot round trip (a reloaded checkpoint advances clean)', () => {
    const sm = machineAtQualityGate();
    sm.pauseAtGate(GATE_CIRCUIT_BREAKER);

    const reloaded = StateMachine.fromSnapshot(JSON.parse(JSON.stringify(sm.toSnapshot())));
    assert.strictEqual(reloaded.pausedAtGate, GATE_CIRCUIT_BREAKER);

    reloaded.transition(STAGE_REVIEW);

    assert.strictEqual(reloaded.pausedAtGate, null);
    assert.strictEqual(
      reloaded.toSnapshot().pausedAtGate,
      null,
      'the cleared pause must reach the persisted snapshot'
    );
  });

  test('resumeFromGate() clears a gate recorded without a timestamp', () => {
    const sm = StateMachine.fromSnapshot({
      ...machineAtQualityGate().toSnapshot(),
      pausedAtGate: GATE_CIRCUIT_BREAKER,
      pausedAtTimestamp: null
    });

    sm.resumeFromGate();

    assert.strictEqual(sm.pausedAtGate, null, 'a timestamp-less pause must still be clearable');
    assert.strictEqual(sm.pausedAtTimestamp, null);
    assert.strictEqual(sm.totalHumanWaitMs, 0, 'no timestamp => no wait time to bank');
  });

  test('pauseAtGate() keeps its first-pause-wins guard', () => {
    const sm = machineAtQualityGate();
    sm.pauseAtGate(GATE_CIRCUIT_BREAKER);
    const first = sm.pausedAtTimestamp;

    sm.pauseAtGate(GATE_COMMIT);

    assert.strictEqual(sm.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.strictEqual(sm.pausedAtTimestamp, first);
  });

  // --- #226: the terminal stage ends a pause -------------------------------
  //
  // Paired deliberately: the test above proves a NON-terminal target still
  // consumes a stale pause, and the two SURVIVES guards above prove a
  // NON-terminal target still preserves a deliberate one. These two prove the
  // new bound is the *stage*, not a blanket "always consume".

  test('entering COMPLETED consumes the inherited COMMIT pause (the run is over; nobody is waiting)', () => {
    const sm = machineAtCommitGate();

    sm.pauseAtGate(GATE_COMMIT);
    assert.strictEqual(sm.pausedAtGate, GATE_COMMIT, 'precondition: the checkpoint is paused at COMMIT');

    sm.transition(STAGE_COMPLETED);

    assert.strictEqual(
      sm.pausedAtGate,
      null,
      'a machine in its terminal stage is not waiting on a human — the pause must be resolved'
    );
    assert.strictEqual(sm.pausedAtTimestamp, null);
    assert.strictEqual(sm.currentStage, STAGE_COMPLETED, 'the transition itself must still happen');
  });

  test('the pause cleared on entering COMPLETED reaches the PERSISTED snapshot, not just the getter', () => {
    const sm = machineAtCommitGate();
    sm.pauseAtGate(GATE_COMMIT);

    sm.transition(STAGE_COMPLETED);

    assert.strictEqual(
      sm.toSnapshot().pausedAtGate,
      null,
      'the cleared pause must reach the snapshot that gets written to .agyloop/state.json'
    );
    assert.strictEqual(sm.toSnapshot().pausedAtTimestamp, null);

    const reloaded = StateMachine.fromSnapshot(JSON.parse(JSON.stringify(sm.toSnapshot())));
    assert.strictEqual(reloaded.pausedAtGate, null, 'a reloaded checkpoint must not resurrect the pause');
    assert.strictEqual(reloaded.currentStage, STAGE_COMPLETED);
  });

  test('entering COMPLETED banks the human wait it inherited (and never reports a negative active duration)', () => {
    const pausedAt = new Date(Date.now() - 5000).toISOString();
    // Seed through the snapshot: pauseAtGate() always stamps "now", so the
    // historical instant has to be injected.
    const sm = StateMachine.fromSnapshot({
      ...machineAtCommitGate().toSnapshot(),
      pausedAtGate: GATE_COMMIT,
      pausedAtTimestamp: pausedAt
    });

    assert.strictEqual(sm.totalHumanWaitMs, 0);

    sm.transition(STAGE_COMPLETED);

    assert.strictEqual(sm.pausedAtGate, null);
    assert.ok(
      sm.totalHumanWaitMs >= 4000,
      `expected ~5000ms of human wait to be banked, got ${sm.totalHumanWaitMs}`
    );
    assert.ok(
      sm.activeExecutionDurationMs() >= 0,
      'active duration must stay non-negative after the pause is consumed'
    );
  });

  test('a NON-terminal target still PRESERVES the pause (the terminal bound did not generalise)', () => {
    const sm = StateMachine.createInitial({ mode: MODE_STANDARD, issue: 11 });
    sm.transition(STAGE_PLAN);
    sm.transition(STAGE_APPROVAL);

    sm.pauseAtGate(GATE_APPROVAL);
    const pausedAt = sm.pausedAtTimestamp;

    sm.transition(STAGE_IMPLEMENT);

    assert.strictEqual(sm.currentStage, STAGE_IMPLEMENT);
    assert.strictEqual(
      sm.pausedAtGate,
      GATE_APPROVAL,
      'only COMPLETED ends a pause; APPROVAL -> IMPLEMENT is still a mid-run human gate'
    );
    assert.strictEqual(sm.pausedAtTimestamp, pausedAt);
    assert.strictEqual(sm.totalHumanWaitMs, 0, 'a surviving pause must not bank time yet');
  });
});
