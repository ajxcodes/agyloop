/**
 * agyloop - Run evidence primitives (issue #284)
 *
 * ONE derivation for a stage duration, used by every writer of the CodeLoop
 * Summary.
 *
 * The defect this module exists to stop is that a duration was recomputed from
 * whatever happened to be lying around: the gap between two history timestamps,
 * with the CUMULATIVE human wait subtracted from it. That printed an hour of
 * human idle time as stage work (`50m 39s` for a review) and printed real work
 * as `0s` (a minutes-long implementation interval clamped to zero because a
 * previous gate had banked more wait than the interval was long).
 *
 * The rule (I-2): a duration is printed only when it is attributable to the
 * stage named on the row. Human wait is never attributed to a stage except the
 * human gate that consumed it. When there is no measurement, print `-`.
 *
 * Pure domain: no I/O, no clock, no environment.
 */

import { StateHistoryEntry } from '../entities/state-machine';
import {
  DURATION_NOT_RECORDED,
  HUMAN_WAIT_GATES,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
  StageName
} from '../constants';
/**
 * Formats a measured millisecond duration as the summary's `1m 24s` / `16s`
 * shape.
 *
 * A value that is not a finite, non-negative number is NOT a duration: it is
 * `-`. Printing `NaNs` or `0s` for an unmeasurable interval is how the summary
 * lied in the first place.
 */
export function formatStageDuration(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return DURATION_NOT_RECORDED;
  }
  const totalSeconds = Math.round(ms / MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * The wall-clock window attributable to `stage`, or `null` when it cannot be
 * measured.
 *
 * Measurable ONLY when the stage's own history entry is the penultimate entry:
 * the interval runs from entering the stage to the transition that left it.
 * A stage entry that is the FINAL entry has not ended yet, and one followed by
 * more than one later entry belongs to a round the machine has already left —
 * reporting its window would attribute someone else's interval to this row
 * (the re-review case).
 */
export function measureStageWindowMs(
  history: readonly StateHistoryEntry[],
  stage: StageName
): number | null {
  if (!Array.isArray(history) || history.length < 2) {
    return null;
  }
  const finalIndex = history.length - 1;
  let stageIndex = -1;
  for (let index = finalIndex; index >= 0; index -= 1) {
    if (history[index]?.stage === stage) {
      stageIndex = index;
      break;
    }
  }
  if (stageIndex < 0 || stageIndex !== finalIndex - 1) {
    return null;
  }
  const startMs = new Date(history[stageIndex].timestamp).getTime();
  const endMs = new Date(history[finalIndex].timestamp).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return Math.max(0, endMs - startMs);
}

/**
 * The duration cell for a summary row.
 *
 * Precedence:
 * 1. A duration the stage measured about ITSELF (`stageDurationMs`) wins — the
 *    stage that performed the work is the authority on how long it took.
 * 2. Otherwise the measured history window minus the human wait consumed by
 *    THIS transition (`humanWaitMs`, never the cumulative total).
 * 3. Otherwise `-`.
 *
 * A human-wait gate row has no work of its own: `transition-stage` maps
 * `APPROVAL` onto the `Plan Review` row, whose number belongs to the gate that
 * consumed the wait. Without a self-measurement it must keep whatever the work
 * stage wrote, so the answer is `-` (callers use `undefined` to mean "leave the
 * cell alone").
 */
export function deriveStageDuration(
  history: readonly StateHistoryEntry[],
  stage: StageName,
  options: { readonly stageDurationMs?: number | null; readonly humanWaitMs?: number | null } = {}
): string {
  const measured = options.stageDurationMs ?? null;
  if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) {
    return formatStageDuration(measured);
  }

  if (isHumanWaitStage(stage)) {
    return DURATION_NOT_RECORDED;
  }

  const window = measureStageWindowMs(history, stage);
  if (window === null) {
    return DURATION_NOT_RECORDED;
  }

  const waitMs =
    typeof options.humanWaitMs === 'number' && Number.isFinite(options.humanWaitMs) && options.humanWaitMs > 0
      ? options.humanWaitMs
      : 0;

  return formatStageDuration(Math.max(0, window - waitMs));
}

/** True when `stage` is a gate a human has to answer. */
export function isHumanWaitStage(stage: string): boolean {
  return HUMAN_WAIT_GATES.includes(stage);
}

/**
 * The summary cell for a stage that ran OUT OF PROCESS and measured itself
 * (issue #325.3, AC-18; the transport field is `gateReportedDurationMs` after
 * issue #315 AC-15).
 *
 * The row used to print the gate's self-timer with no label, so
 * `1m 9s` looked like the stage's wall clock while the checkpoint's window was
 * `2m 57s` — the difference being agent start-up the gate never self-reports.
 * The cell now names the clock it shows; when the wall window is measurable the
 * reader can see both.
 */
export function formatGateReportedDuration(
  reportedMs: number,
  wallMs?: number | null
): string {
  if (typeof reportedMs !== 'number' || !Number.isFinite(reportedMs) || reportedMs < 0) {
    return DURATION_NOT_RECORDED;
  }
  const reported = formatStageDuration(reportedMs);
  if (typeof wallMs === 'number' && Number.isFinite(wallMs) && wallMs >= 0) {
    return `${reported} (gate-reported; ${formatStageDuration(wallMs)} wall)`;
  }
  return `${reported} (gate-reported)`;
}

/**
 * The human wait consumed by THIS transition.
 *
 * `totalHumanWaitMs` after minus before the resume. The cumulative total minus
 * an interval is meaningless: it is a running bank across the whole run, and
 * subtracting it from one stage's window clamped real work to `0s`.
 */
export function consumedHumanWaitMs(before: number, after: number): number {
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return 0;
  }
  return Math.max(0, after - before);
}
