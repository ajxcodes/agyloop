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
  SmokeProtocol,
  STATUS_PASSED,
  assessGateTargetCoverage,
  assessSmokeCheckCoverage,
  parseQualityGateTargets,
  type GateTargetCoverage,
  type SmokeCheckCoverage
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
  /** True only when TARGET coverage was assessed (PASSED + declared targets). */
  readonly assessed: boolean;
  /** The independent smoke-protocol adjudication (issue #444). */
  readonly smoke: SmokeCheckCoverage;
}

/**
 * The "nothing to check" smoke outcome. Frozen so a caller cannot mutate the
 * shared value; `covered: true` keeps every plan that declares no protocol
 * certifiable (the documented `codeloop yolo` scaffold and every pre-#298
 * block).
 */
const NO_SMOKE_COVERAGE: SmokeCheckCoverage = Object.freeze({
  assessed: false,
  covered: true,
  reason: 'not-assessed' as const,
  declared: Object.freeze([]) as readonly string[],
  reported: Object.freeze([]) as readonly string[],
  missing: Object.freeze([]) as readonly string[],
  skipped: Object.freeze([]) as readonly string[],
  failed: Object.freeze([]) as readonly string[],
  unknown: Object.freeze([]) as readonly string[],
  duplicate: Object.freeze([]) as readonly string[]
});

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
  assessed: false,
  smoke: NO_SMOKE_COVERAGE
});

export function assessGateEvidenceCoverage(
  query: GateEvidenceCoverageQuery
): GateEvidenceCoverage {
  // Only a PASSED block certifies the gate; a FAILED report is a "go fix it"
  // exit and must not be refused for missing commands or smoke checks.
  if (query.report.verdict !== STATUS_PASSED) {
    return NO_COVERAGE;
  }

  // ONE plan read for BOTH adjudications (issue #444): the smoke assessment
  // must not ride the target `declared.length === 0` early return — the
  // reproduction plan declares four checks and no Quality Gate Targets.
  const markdown = resolvePlanDocument(query);
  const declared = markdown === null ? [] : parseQualityGateTargets(markdown).commands;
  const smoke =
    markdown === null
      ? NO_SMOKE_COVERAGE
      : assessSmokeCheckCoverage(SmokeProtocol.fromPlan(markdown), query.report);

  if (declared.length === 0) {
    // No declared targets — or an unresolvable/unreadable plan — keeps the
    // pre-#408 TARGET behaviour. The digest guard still protects an edited plan.
    return { ...NO_COVERAGE, smoke };
  }
  return { ...assessGateTargetCoverage(declared, query.report), assessed: true, smoke };
}

/**
 * The plan document, or `null` when there is nothing readable.
 *
 * `resolvePlanFile` is the single resolver: it honours the explicit `planPath`,
 * the recorded `planDir` and the issue. Its `null` result falls back to the
 * caller's `planPath` (a checkpoint may name an approved plan the resolver's
 * directory scan cannot see). Any read failure is `null` — an unreadable plan
 * is not a target list or a protocol, and the digest guard owns plan integrity.
 */
function resolvePlanDocument(query: GateEvidenceCoverageQuery): string | null {
  const generator = query.planGenerator;
  if (!generator) {
    return null;
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
    return null;
  }
  try {
    return generator.readPlanDocument(planPath);
  } catch {
    return null;
  }
}
