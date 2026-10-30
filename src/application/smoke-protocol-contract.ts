/**
 * agyloop - Smoke protocol approval guard (issue #388, Defect 2)
 *
 * `SmokeProtocol.fromPlan` is the static validator the gate relies on. Before
 * #388 it had no rule for a block that WRITES a path without creating the
 * parent directory, so the #382 plan's Smoke 6/7 seeds
 * (`.agyloop/tasks/382.json` with no `mkdir -p .agyloop/tasks`) were reported
 * as `9 checks / 0 findings / executable: true`. Every assertion in those blocks
 * died before any product code ran, and the gate had to edit the frozen script.
 *
 * This guard is the SHARED enforcement for both approval entry points
 * (`codeloop implement` and `codeloop transition APPROVAL`), mirroring
 * `gate-target-contract.ts`. A plan whose protocol is declared but not
 * executable is refused BEFORE approval, so the implementer never receives a
 * protocol that cannot start. Under `--dry-run` the same findings are WARNED.
 */

import {
  MSG_SMOKE_PROTOCOL_NOT_EXECUTABLE,
  SmokeProtocol,
  ValidationError
} from '../domain';
import { PlanGeneratorPort } from '../ports';

export interface SmokeProtocolContractParams {
  readonly planGenerator?: PlanGeneratorPort;
  readonly planPath: string | null;
  readonly dryRun?: boolean;
}

/** Throws `ValidationError('smokeProtocol', …)` unless the frozen protocol runs. */
export function assertSmokeProtocolContract(params: SmokeProtocolContractParams): void {
  const { planGenerator, planPath } = params;
  if (!planGenerator || !planPath) return;

  let content: string;
  try {
    content = planGenerator.readPlanDocument(planPath);
  } catch {
    // An unreadable plan is not a protocol; other guards report that.
    return;
  }

  const protocol = SmokeProtocol.fromPlan(content);
  if (!protocol.declared || protocol.executable) return;

  const lines = protocol.findings.map((finding) =>
    MSG_SMOKE_PROTOCOL_NOT_EXECUTABLE.replace('{check}', () => finding.label)
      .replace('{line}', () => String(finding.line))
      .replace('{rule}', () => finding.rule)
      .replace('{excerpt}', () => finding.excerpt)
  );
  const reason = [
    'The approved plan declares a Manual Smoke Test Protocol that cannot be executed as written; approval is refused before the gate or the implementer receives it.',
    ...lines,
    `(plan: ${planPath})`
  ].join('\n');

  if (params.dryRun) {
    console.warn(`[codeloop] Warning: ${reason}`);
    return;
  }

  throw new ValidationError('smokeProtocol', planPath, reason);
}
