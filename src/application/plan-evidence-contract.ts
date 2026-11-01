/**
 * agyloop - the ONE plan-evidence path guard (issue #432, AC4/AC6)
 *
 * An acceptance criterion or checklist step that targets a commit-excluded
 * path (`artifacts/`, `.agyloop/`, `node_modules/`) — or a path that lexically
 * escapes the workspace — can never be satisfied by the delivered PR. The
 * approval gate refuses it, naming the path, the plan line and the target, so
 * the operator chooses an explicit resolution: deliver the correction as a
 * tracked document, or declare it out of scope in the plan.
 *
 * A plan that names no such path is untouched (AC7).
 */

import {
  MSG_PLAN_EVIDENCE_EXCLUDED_PATH,
  ValidationError,
  lintPlanEvidencePaths,
  type PlanEvidenceFinding
} from '../domain';
import { PlanGeneratorPort } from '../ports';

export interface PlanEvidenceContractParams {
  readonly planGenerator?: PlanGeneratorPort;
  readonly planPath: string | null;
  readonly workspaceDir: string;
  readonly dryRun?: boolean;
}

function formatFinding(finding: PlanEvidenceFinding): string {
  return MSG_PLAN_EVIDENCE_EXCLUDED_PATH.replace('{target}', finding.target)
    .replace('{path}', finding.path)
    .replace('{line}', String(finding.line))
    .replace('{reason}', finding.reason);
}

/**
 * Throws `ValidationError('planEvidencePaths', …)` when the plan's AC or
 * checklist names a path the delivered change set can never contain.
 */
export function assertPlanEvidenceContract(params: PlanEvidenceContractParams): void {
  const { planGenerator, planPath } = params;
  if (!planGenerator || !planPath) return;

  let content: string;
  try {
    content = planGenerator.readPlanDocument(planPath);
  } catch {
    // An unreadable plan is not a path list; other guards report that.
    return;
  }

  const findings = lintPlanEvidencePaths(content, params.workspaceDir);
  if (findings.length === 0) return;

  const reason = `${findings.map(formatFinding).join(' ')} (plan: ${planPath})`;
  if (params.dryRun) {
    console.warn(`[codeloop] Warning: ${reason}`);
    return;
  }

  throw new ValidationError('planEvidencePaths', planPath, reason);
}
