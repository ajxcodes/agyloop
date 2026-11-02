/**
 * agyloop - Smoke check coverage (issue #444)
 *
 * Compares a filed gate report's `smokeProtocol` / `smokeChecks` with the
 * plan's frozen `### Manual Smoke Test Protocol`.
 *
 * The gate prompt promises that "a failing check, a skipped check, a
 * zero-check protocol, or any edit to the plan is a `FAILED` verdict"
 * (`resolve-subagent.ts`). Nothing compared a filed PASSED block to the plan,
 * so a PASSED report declaring `NOT_DECLARED` with zero checks — or covering
 * one of four checks — could certify `QUALITY_GATE -> REVIEW`.
 *
 * The plan is the SOLE authority for identity: its check order defines
 * `check-1 … check-N`, and `formatSmokeCheckId` is the ONE producer of that
 * id. A report that re-labels a check (`smoke-444-check-2`, `S1`) does not
 * cover it.
 *
 * Pure domain: no I/O, no clock. The caller resolves and reads the plan.
 */

import {
  SMOKE_PROTOCOL_NOT_DECLARED,
  STATUS_FAILED,
  STATUS_PASSED
} from '../constants';
import { splitSmokeChecks } from './gate-result-report';
import type { SmokeProtocol } from './smoke-protocol';

/** The canonical id prefix of a plan-declared smoke check. */
export const SMOKE_CHECK_ID_PREFIX = 'check-' as const;

/**
 * The canonical, 1-based id of the protocol's `<index>`-th check.
 *
 * The ONLY producer: the gate prompt, this adjudicator and the tests all call
 * it, so a published id and an accepted id cannot drift.
 */
export function formatSmokeCheckId(index: number): string {
  return `${SMOKE_CHECK_ID_PREFIX}${index}`;
}

/**
 * The only legacy shape normalised: `smoke-check-N`, `smoke-check N`,
 * `smoke-check:N`, `check-N`. That is the label shape the tool itself produced
 * before #325 (`smoke-check-1: PASSED`), so those blocks stay certifiable.
 * Arbitrary re-labelling (`smoke-444-check-2`, `S1`) is deliberately NOT
 * matched and lands in `unknown`.
 */
const LEGACY_CHECK_ID = /^(?:smoke-)?check[-:\s]*(\d+)$/i;

/** A reported id as filed → the canonical id it denotes. */
function canonicalSmokeCheckId(id: string): string {
  const text = typeof id === 'string' ? id.trim() : '';
  const match = LEGACY_CHECK_ID.exec(text);
  return match === null ? text : formatSmokeCheckId(Number(match[1]));
}

/** The report fields smoke coverage is decided from. */
export interface GateSmokeEvidence {
  readonly verdict: string; // 'PASSED' | 'FAILED'
  /** The wire token, `null` when omitted. */
  readonly smokeProtocol: string | null;
  readonly smokeChecks: readonly { readonly id: string; readonly passed: boolean | null }[];
  readonly notRun: readonly { readonly id: string }[];
  readonly executedCommands: readonly string[];
}

/** Why a PASSED report does (not) cover the plan's declared protocol. */
export type SmokeCoverageReason =
  | 'not-assessed'
  | 'ok'
  | 'protocol-not-declared'
  | 'protocol-missing'
  | 'protocol-failed'
  | 'duplicate'
  | 'unknown'
  | 'missing'
  | 'skipped'
  | 'failed';

/** The outcome of comparing a report with the plan's declared checks. */
export interface SmokeCheckCoverage {
  /** True only when a PASSED report faced a plan that DECLARES checks. */
  readonly assessed: boolean;
  readonly covered: boolean;
  readonly reason: SmokeCoverageReason;
  /** Canonical ids, plan order. */
  readonly declared: readonly string[];
  /** Canonicalised ids as filed, in report order. */
  readonly reported: readonly string[];
  /** Declared ids absent from `reported`, plan order. */
  readonly missing: readonly string[];
  /** Declared ids present in `notRun`, plan order. */
  readonly skipped: readonly string[];
  /** Declared ids whose entry is not `passed: true`, plan order. */
  readonly failed: readonly string[];
  /** Reported ids the plan does not declare, report order. */
  readonly unknown: readonly string[];
  /** Ids reported more than once, first-appearance order. */
  readonly duplicate: readonly string[];
}

function frozen(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

/** De-duplicates, preserving first-appearance order. */
function unique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function notAssessed(declared: readonly string[]): SmokeCheckCoverage {
  return Object.freeze({
    assessed: false,
    covered: true,
    reason: 'not-assessed' as const,
    declared: frozen(declared),
    reported: frozen([]),
    missing: frozen([]),
    skipped: frozen([]),
    failed: frozen([]),
    unknown: frozen([]),
    duplicate: frozen([])
  });
}

/**
 * Assesses whether a filed report evidences every check of `protocol`.
 *
 * Unassessed — and therefore certifiable — for a non-PASSED verdict (the "go
 * fix it" exit) and for a plan that declares no runnable check (the generated
 * `codeloop yolo` scaffold). A PASSED report facing a declared protocol must
 * satisfy ALL of: `smokeProtocol === 'PASSED'`; exactly the declared id set,
 * with no duplicates and no unknown ids; no declared id in `notRun`; every
 * declared id reported `passed: true`.
 *
 * Reason precedence: `protocol-not-declared` → `protocol-missing` →
 * `protocol-failed` → `duplicate` → `unknown` → `missing` → `skipped` →
 * `failed` → `ok`. Every list preserves plan order.
 */
export function assessSmokeCheckCoverage(
  protocol: SmokeProtocol,
  evidence: GateSmokeEvidence
): SmokeCheckCoverage {
  const declared = protocol.checks.map((check) => formatSmokeCheckId(check.index));

  if (
    evidence.verdict !== STATUS_PASSED ||
    protocol.declared !== true ||
    protocol.checks.length === 0
  ) {
    return notAssessed(declared);
  }

  // Legacy precedence (the same one `certify-review-exit` uses): a block that
  // filed real `smokeChecks` wins; otherwise the `smoke-check-N` labels inside
  // `executedCommands` are the evidence.
  const entries = (
    evidence.smokeChecks.length > 0
      ? evidence.smokeChecks
      : splitSmokeChecks(evidence.executedCommands).smokeChecks
  )
    .map((entry) => ({
      id: canonicalSmokeCheckId(entry.id),
      passed: entry.passed
    }))
    .filter((entry) => entry.id.length > 0);

  const reported = entries.map((entry) => entry.id);
  const reportedSet = new Set(reported);
  const declaredSet = new Set(declared);
  const notRunSet = new Set(
    (evidence.notRun ?? [])
      .map((entry) => canonicalSmokeCheckId(entry.id))
      .filter((id) => id.length > 0)
  );

  const counts = new Map<string, number>();
  for (const id of reported) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const duplicate = unique(reported.filter((id) => (counts.get(id) ?? 0) > 1));
  const unknown = unique(reported.filter((id) => !declaredSet.has(id)));
  const missing = declared.filter((id) => !reportedSet.has(id));
  const skipped = declared.filter((id) => notRunSet.has(id));
  const failed = declared.filter((id) =>
    entries.some((entry) => entry.id === id && entry.passed !== true)
  );

  const reason: SmokeCoverageReason =
    evidence.smokeProtocol === SMOKE_PROTOCOL_NOT_DECLARED
      ? 'protocol-not-declared'
      : evidence.smokeProtocol === null
        ? 'protocol-missing'
        : evidence.smokeProtocol === STATUS_FAILED
          ? 'protocol-failed'
          : duplicate.length > 0
            ? 'duplicate'
            : unknown.length > 0
              ? 'unknown'
              : missing.length > 0
                ? 'missing'
                : skipped.length > 0
                  ? 'skipped'
                  : failed.length > 0
                    ? 'failed'
                    : 'ok';

  return Object.freeze({
    assessed: true,
    covered: reason === 'ok',
    reason,
    declared: frozen(declared),
    reported: frozen(reported),
    missing: frozen(missing),
    skipped: frozen(skipped),
    failed: frozen(failed),
    unknown: frozen(unknown),
    duplicate: frozen(duplicate)
  });
}
