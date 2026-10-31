/**
 * agyloop - Gate target coverage (issue #408, D2)
 *
 * Compares a filed gate report's executed commands with the plan's declared
 * `### Quality Gate Targets`.
 *
 * Pure domain: no I/O, no clock. The caller resolves the plan and reads it; this
 * module only decides whether the evidence covers what the plan declared.
 *
 * Evidence set = the union of `executedCommands` (with `smoke-check-N` labels
 * partitioned OUT, so a smoke label can never satisfy a declared command —
 * #325 AC-17) and `commandResults[].command` (optional on the wire, absent from
 * every pre-#325 block, so refusing it would discard honest legacy evidence).
 *
 * Matching reuses `commandCoversTarget`, i.e. the unique-test-accounting
 * semantics: normalised equality, or the existing containment / full-suite rule
 * (`npm test` covers a targeted `node --test tests/a.test.ts`; a full-suite
 * command does not cover lint).
 */

import { commandCoversTarget, splitSmokeChecks } from './gate-result-report';

/** The report fields coverage is decided from. */
export interface GateExecutionEvidence {
  readonly executedCommands: readonly string[];
  readonly commandResults: readonly { readonly command: string }[];
}

/** The outcome of comparing declared targets with executed evidence. */
export interface GateTargetCoverage {
  /** The plan's declared commands, deduped, in plan order. */
  readonly declared: readonly string[];
  /** The evidence commands, deduped: commands first, then `commandResults`. */
  readonly executed: readonly string[];
  /** Every declared target no evidence command covers, in plan order. */
  readonly missing: readonly string[];
  /** True when nothing is missing (an empty declared list is trivially covered). */
  readonly covered: boolean;
}

/**
 * Assesses whether `report`'s executed commands cover `declaredTargets`.
 *
 * `missing` is every uncovered target IN PLAN ORDER, so one message can name
 * all of them once.
 */
export function assessGateTargetCoverage(
  declaredTargets: readonly string[],
  report: GateExecutionEvidence
): GateTargetCoverage {
  const declared = dedupe(Array.isArray(declaredTargets) ? declaredTargets : []);
  const executed = dedupe([
    ...splitSmokeChecks(report.executedCommands ?? []).commands,
    ...(report.commandResults ?? []).map((entry) => entry.command)
  ]);
  const missing = declared.filter(
    (target) => !executed.some((command) => commandCoversTarget(command, target))
  );
  return { declared, executed, missing, covered: missing.length === 0 };
}

/** Trimmed, de-duplicated, blank-free and frozen — order preserved. */
function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return Object.freeze(out);
}
