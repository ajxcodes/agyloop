/**
 * agyloop - Gate evidence coverage (issue #408, D2)
 *
 * The application seam between a filed report and the plan's declared
 * verification targets. It resolves the plan through `PlanGeneratorPort` (no
 * `fs`, no `path`, no `process`: the hexagonal boundary is preserved) and
 * delegates the decision to the pure domain matcher.
 *
 * Both enforcement points call THIS helper — `codeloop gate-report` at filing
 * and `TransitionStageUseCase` at ingest — so the two cannot disagree about
 * whether a report certifies a plan.
 */

import {
  GateResultReport,
  STATUS_PASSED,
  assessGateTargetCoverage,
  parseQualityGateTargets,
  type GateTargetCoverage
} from '../domain';
import { PlanGeneratorPort } from '../ports';

export interface GateEvidenceCoverageQuery {
  readonly planGenerator?: PlanGeneratorPort;
  readonly workspaceDir: string;
  readonly issue?: number | string | null;
  readonly planPath?: string | null;
  readonly planDir?: string | null;
  readonly report: GateResultReport;
}

export interface GateEvidenceCoverage extends GateTargetCoverage {
  /** True only when coverage was actually assessed (PASSED + declared targets). */
  readonly assessed: boolean;
}

/**
 * The "nothing to check" outcome. Frozen so a caller cannot mutate the shared
 * value; `covered: true` keeps the pre-#408 behaviour for every plan that
 * declares no targets.
 */
const NO_COVERAGE: GateEvidenceCoverage = Object.freeze({
  declared: Object.freeze([]) as readonly string[],
  executed: Object.freeze([]) as readonly string[],
  missing: Object.freeze([]) as readonly string[],
  covered: true,
  assessed: false
});

export function assessGateEvidenceCoverage(
  query: GateEvidenceCoverageQuery
): GateEvidenceCoverage {
  // Only a PASSED block certifies the gate; a FAILED report is a "go fix it"
  // exit and must not be refused for missing commands.
  if (query.report.verdict !== STATUS_PASSED) {
    return NO_COVERAGE;
  }
  const declared = resolveDeclaredTargets(query);
  if (declared.length === 0) {
    // No declared targets — or an unresolvable/unreadable plan — keeps the
    // pre-#408 behaviour. The digest guard still protects an edited plan.
    return NO_COVERAGE;
  }
  return { ...assessGateTargetCoverage(declared, query.report), assessed: true };
}

/**
 * The plan's declared gate commands, or `[]` when there is nothing to read.
 *
 * `resolvePlanFile` is the single resolver: it honours the explicit `planPath`,
 * the recorded `planDir` and the issue. Its `null` result falls back to the
 * caller's `planPath` (a checkpoint may name an approved plan the resolver's
 * directory scan cannot see). Any read failure is "no targets" — an unreadable
 * plan is not a target list, and the digest guard owns plan integrity.
 */
function resolveDeclaredTargets(query: GateEvidenceCoverageQuery): readonly string[] {
  const generator = query.planGenerator;
  if (!generator) {
    return [];
  }
  let planPath: string | null = query.planPath ?? null;
  try {
    const resolved = generator.resolvePlanFile({
      projectRoot: query.workspaceDir,
      issue: query.issue ?? undefined,
      planPath: query.planPath ?? undefined,
      planDir: query.planDir ?? undefined
    });
    planPath = resolved?.planPath ?? planPath;
  } catch {
    // A failing resolver falls back to the caller's path, already in hand.
  }
  if (!planPath) {
    return [];
  }
  try {
    return parseQualityGateTargets(generator.readPlanDocument(planPath)).commands;
  } catch {
    return [];
  }
}
