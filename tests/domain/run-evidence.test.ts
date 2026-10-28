/**
 * agyloop - Run evidence primitives (issue #284, AC5/AC9)
 *
 * The defect: a duration was recomputed from a transition gap and the
 * CUMULATIVE human wait was subtracted from it, so an hour of human idle time
 * printed as stage work (`50m 39s`) and a minutes-long implementation printed
 * as `0s`.
 *
 * These tests pin the pure derivation: the formatter, the measurability guard,
 * and the "never the cumulative total" rule.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  formatStageDuration,
  formatGateReportedDuration,
  measureStageWindowMs,
  deriveStageDuration,
  isHumanWaitStage,
  consumedHumanWaitMs,
  DURATION_NOT_RECORDED,
  STAGE_APPROVAL,
  STAGE_COMMIT,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW
} = require('../../dist/domain');

function entry(stage: string, timestampMs: number, metadata?: Record<string, unknown>) {
  return { stage, timestamp: new Date(timestampMs).toISOString(), metadata };
}

describe('formatStageDuration (issue #284)', () => {
  test('renders the documented shapes', () => {
    assert.strictEqual(formatStageDuration(196000), '3m 16s');
    assert.strictEqual(formatStageDuration(84000), '1m 24s');
    assert.strictEqual(formatStageDuration(16000), '16s');
    assert.strictEqual(formatStageDuration(0), '0s');
  });

  test('an unmeasurable value is "-", never 0s or NaN', () => {
    assert.strictEqual(formatStageDuration(-1), DURATION_NOT_RECORDED);
    assert.strictEqual(formatStageDuration(NaN), DURATION_NOT_RECORDED);
    assert.strictEqual(formatStageDuration(Infinity), DURATION_NOT_RECORDED);
    assert.strictEqual(formatStageDuration(-Infinity), DURATION_NOT_RECORDED);
  });
});

describe('formatGateReportedDuration (issue #315, AC-15/AC-18)', () => {
  test('names the gate-reported clock, and the wall clock when it is measurable', () => {
    assert.strictEqual(
      formatGateReportedDuration(196000, 302000),
      '3m 16s (gate-reported; 5m 2s wall)'
    );
    assert.strictEqual(formatGateReportedDuration(196000, null), '3m 16s (gate-reported)');
    assert.strictEqual(formatGateReportedDuration(196000), '3m 16s (gate-reported)');
  });

  test('an unmeasurable self-timer is "-", never a labelled guess', () => {
    assert.strictEqual(formatGateReportedDuration(NaN, 1000), DURATION_NOT_RECORDED);
    assert.strictEqual(formatGateReportedDuration(-1), DURATION_NOT_RECORDED);
  });
});

describe('measureStageWindowMs (issue #284)', () => {
  test('returns the gap when the stage entry is immediately before the final entry', () => {
    const now = Date.now();
    const history = [
      entry(STAGE_APPROVAL, now - 200_000),
      entry(STAGE_IMPLEMENT, now - 60_000),
      entry(STAGE_QUALITY_GATE, now)
    ];
    assert.strictEqual(measureStageWindowMs(history, STAGE_IMPLEMENT), 60_000);
  });

  test('returns null when the stage entry is the final entry (the stage has not ended)', () => {
    const now = Date.now();
    const history = [entry(STAGE_IMPLEMENT, now - 60_000), entry(STAGE_QUALITY_GATE, now)];
    assert.strictEqual(measureStageWindowMs(history, STAGE_QUALITY_GATE), null);
  });

  test('returns null when the stage entry is followed by MORE than one entry (a previous round)', () => {
    // history: REVIEW -> COMMIT -> QUALITY_GATE -> REVIEW (a re-review). The
    // FIRST REVIEW entry is the previous round's; its window must not be
    // reported for the current row.
    const now = Date.now();
    const history = [
      entry(STAGE_REVIEW, now - 900_000),
      entry(STAGE_COMMIT, now - 800_000),
      entry(STAGE_QUALITY_GATE, now - 700_000),
      entry(STAGE_REVIEW, now - 60_000),
      { stage: 'COMMIT', timestamp: new Date(now).toISOString() }
    ];
    assert.strictEqual(measureStageWindowMs(history, STAGE_REVIEW), 60_000);
    const withoutCurrent = history.slice(0, 4);
    assert.strictEqual(measureStageWindowMs(withoutCurrent, STAGE_REVIEW), null);
  });

  test('returns null for an absent stage', () => {
    assert.strictEqual(measureStageWindowMs([entry(STAGE_IMPLEMENT, Date.now())], STAGE_REVIEW), null);
  });
});

describe('deriveStageDuration (issue #284)', () => {
  test('a self-measurement always wins', () => {
    const now = Date.now();
    const history = [entry(STAGE_IMPLEMENT, now - 1000), entry(STAGE_QUALITY_GATE, now)];
    assert.strictEqual(
      deriveStageDuration(history, STAGE_IMPLEMENT, { stageDurationMs: 196000, humanWaitMs: 999_999 }),
      '3m 16s'
    );
  });

  test('an UNMEASURED human gate prints "-" (its row belongs to the work stage)', () => {
    const now = Date.now();
    const history = [entry(STAGE_APPROVAL, now - 300_000), entry(STAGE_IMPLEMENT, now)];
    assert.strictEqual(deriveStageDuration(history, STAGE_APPROVAL), DURATION_NOT_RECORDED);
    assert.strictEqual(deriveStageDuration(history, STAGE_COMMIT), DURATION_NOT_RECORDED);
  });

  test('an unmeasurable stage prints "-"', () => {
    assert.strictEqual(deriveStageDuration([], STAGE_IMPLEMENT), DURATION_NOT_RECORDED);
    const now = Date.now();
    const history = [entry(STAGE_IMPLEMENT, now)];
    assert.strictEqual(deriveStageDuration(history, STAGE_IMPLEMENT), DURATION_NOT_RECORDED);
  });

  test('subtracts ONLY the wait this transition consumed, never the cumulative total', () => {
    const now = Date.now();
    const history = [entry(STAGE_IMPLEMENT, now - 60_000), entry(STAGE_QUALITY_GATE, now)];
    // 1 minute of implementation, 10 s of wait consumed by this transition.
    assert.strictEqual(
      deriveStageDuration(history, STAGE_IMPLEMENT, { humanWaitMs: 10_000 }),
      '50s'
    );
    // The regression: a run that had banked 50m 39s previously clamped this to 0s.
    assert.strictEqual(
      deriveStageDuration(history, STAGE_IMPLEMENT, { humanWaitMs: 3_038_481 }),
      '0s'
    );
    // ...but with only THIS transition's wait, the real minute survives.
    assert.strictEqual(
      deriveStageDuration(history, STAGE_IMPLEMENT, { humanWaitMs: 1_000 }),
      '59s'
    );
  });
});

describe('consumedHumanWaitMs (issue #284)', () => {
  test('is the delta, clamped at zero', () => {
    assert.strictEqual(consumedHumanWaitMs(0, 84_000), 84_000);
    assert.strictEqual(consumedHumanWaitMs(84_000, 84_000), 0);
    assert.strictEqual(consumedHumanWaitMs(84_000, 80_000), 0);
    assert.strictEqual(consumedHumanWaitMs(NaN, 5), 0);
  });
});

describe('isHumanWaitStage (issue #284)', () => {
  test('names exactly the human gates', () => {
    assert.strictEqual(isHumanWaitStage(STAGE_APPROVAL), true);
    assert.strictEqual(isHumanWaitStage(STAGE_COMMIT), true);
    assert.strictEqual(isHumanWaitStage(STAGE_IMPLEMENT), false);
    assert.strictEqual(isHumanWaitStage(STAGE_QUALITY_GATE), false);
    assert.strictEqual(isHumanWaitStage(STAGE_REVIEW), false);
  });
});
