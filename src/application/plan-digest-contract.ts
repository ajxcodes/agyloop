/**
 * agyloop - the ONE approved-plan digest guard (issue #421)
 *
 * The approval gate is the only surface where a plan becomes normative. Before
 * #421 the digest was recorded at IMPLEMENT, so a plan edited between the human
 * approval and `codeloop implement` was silently blessed: the certification the
 * operator gave was attached to no bytes.
 *
 * This module owns the COMPARISON (`codeloop implement` and `codeloop transition
 * IMPLEMENT`) and the GATE-EXIT comparison (`QUALITY_GATE -> REVIEW`), mirroring
 * `gate-target-contract.ts` / `plan-baseline-contract.ts`: callers keep their own
 * plan resolution, enforcement is shared. Under `--dry-run` the same finding is
 * WARNED instead of thrown, so a preview can never report a transition the real
 * run refuses.
 */

import {
  MSG_PLAN_MODIFIED_AFTER_APPROVAL,
  MSG_PLAN_MODIFIED_DURING_GATE,
  ValidationError
} from '../domain';
import { PlanGeneratorPort } from '../ports';

/**
 * The boundary a plan is being certified at.
 *
 * - `approval` is `APPROVAL -> IMPLEMENT`: the operator's certification must
 *   still describe the bytes about to run.
 * - `gate` is `QUALITY_GATE -> REVIEW`: a gate cannot certify an artifact it
 *   did not execute.
 */
export type PlanDigestBoundary = 'approval' | 'gate';

export interface ApprovedPlanDigestParams {
  readonly planGenerator?: PlanGeneratorPort;
  readonly planPath: string | null;
  readonly expectedDigest: string | null;
  readonly boundary: PlanDigestBoundary;
  readonly dryRun?: boolean;
  readonly suffix?: string;
}

/**
 * Hashes `planPath` through the plan generator.
 *
 * Returns `null` when the port or path is missing or hashing fails: an
 * unreadable approved plan is reported as `(unreadable)` by the guard, not
 * thrown from the adapter.
 */
export function resolvePlanDigest(
  planGenerator: PlanGeneratorPort | undefined,
  planPath: string | null
): string | null {
  if (!planGenerator || !planPath) return null;
  if (typeof planGenerator.hashPlanDocument !== 'function') return null;
  try {
    return planGenerator.hashPlanDocument(planPath) || null;
  } catch {
    return null;
  }
}

/**
 * Throws `ValidationError('approvedPlanDigest', …)` when the plan on disk no
 * longer matches the recorded digest.
 *
 * A checkpoint with no recorded digest is a no-op: legacy checkpoints and
 * non-gated entries own their own recording.
 */
export function assertApprovedPlanUnchanged(params: ApprovedPlanDigestParams): void {
  const { expectedDigest, planPath } = params;
  if (!expectedDigest) return;

  const actual = resolvePlanDigest(params.planGenerator, planPath);
  if (actual !== null && actual === expectedDigest) {
    return;
  }

  const template =
    params.boundary === 'gate'
      ? MSG_PLAN_MODIFIED_DURING_GATE
      : MSG_PLAN_MODIFIED_AFTER_APPROVAL;
  const message =
    template
      .replace('{path}', planPath ?? '(unknown plan path)')
      .replace('{expected}', expectedDigest)
      .replace('{actual}', actual ?? '(unreadable)') + (params.suffix ?? '');

  if (params.dryRun) {
    console.warn(`[codeloop] Warning: ${message}`);
    return;
  }

  throw new ValidationError('approvedPlanDigest', actual, message);
}
