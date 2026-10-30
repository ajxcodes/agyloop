/**
 * agyloop - the ONE gate-target contract guard (issue #369)
 *
 * Two approval entry points (`codeloop implement` and
 * `codeloop transition APPROVAL`) must refuse the same plans for the same
 * reasons. This module owns the ENFORCEMENT; each caller keeps its own plan
 * resolution, because the two resolve plans differently by design.
 *
 * A plan is refused when a declared target asserts a committed-tree invariant
 * (#348) or when the parser could not turn a declared entry into an executable
 * command (#369, was #372). Under `--dry-run` the same findings are WARNED, so a
 * preview can never report success for a transition the real run refuses.
 */

import {
  GateTargetFinding,
  ValidationError,
  formatGateTargetContractViolations,
  lintGateTargetRejections,
  lintQualityGateTargets,
  parseQualityGateTargets
} from '../domain';
import { PlanGeneratorPort } from '../ports';

export interface GateTargetContractParams {
  readonly planGenerator?: PlanGeneratorPort;
  readonly planPath: string | null;
  readonly dryRun?: boolean;
}

/** Throws ValidationError('gateTargets', …) unless the plan's targets are executable. */
export function assertGateTargetContract(params: GateTargetContractParams): void {
  const { planGenerator, planPath } = params;
  if (!planGenerator || !planPath) return;

  let content: string;
  try {
    content = planGenerator.readPlanDocument(planPath);
  } catch {
    // An unreadable plan is not a target list; other guards report that.
    return;
  }

  const parsed = parseQualityGateTargets(content);
  const findings: readonly GateTargetFinding[] = [
    ...lintQualityGateTargets(parsed.targets),
    ...lintGateTargetRejections(parsed)
  ];
  if (findings.length === 0) return;

  const reason = `${formatGateTargetContractViolations(findings)} (plan: ${planPath})`;
  if (params.dryRun) {
    console.warn(`[codeloop] Warning: ${reason}`);
    return;
  }

  throw new ValidationError('gateTargets', planPath, reason);
}
