/**
 * agyloop - Plan baseline contract guard (issue #388, Defect 1)
 *
 * Nothing used to compare a plan-declared baseline with measurement. The
 * declared value travelled through APPROVAL as normative, and the first actor
 * asked to satisfy it was the implementer. On the #382 run `DA-METRICS-1`
 * declared `{ additions: 3, deletions: 0 }` while the fixture measured four
 * additions — an implementer following the plan would have changed a correct
 * metric to a wrong one.
 *
 * This guard has three layers:
 *
 *   - STRUCTURAL: `BaselineEvidence` refuses a header that claims reproduction
 *     without a `### Baseline Evidence` section, an incomplete claim, or a body
 *     line that restates a claim id with a different value. None of that runs a
 *     command.
 *   - BUILD REFUSAL: every claim's `Command` is scanned for a build-like
 *     construct BEFORE anything executes. A baseline command must never rebuild
 *     the workspace root — the root build is the tool executing the gate.
 *   - MEASURED: each claim's `Command` is executed (outside `--dry-run`) with a
 *     bounded timeout, once per claim, and `evaluateBaselineClaim` decides the
 *     `Declared`/`Output` verdict against the fresh stdout. `Declared` and
 *     `Output` are both checked; a prose `Declared` passes only when `Output`
 *     verifies, and the author is warned to copy the literal stdout.
 *
 * Mirrors `gate-target-contract.ts`: unreadable plans are left to the other
 * guards, and `--dry-run` WARNS instead of throwing so a preview can never
 * report success for an approval the real run refuses.
 */

import {
  BASELINE_DECLARED_SHAPE_SENTENCE,
  BASELINE_RULE_BODY_MISMATCH,
  BASELINE_RULE_MISSING_COMMAND,
  BASELINE_RULE_MISSING_EVIDENCE,
  BASELINE_RULE_MISSING_OUTPUT,
  BASELINE_RULE_MISSING_VALUE,
  BASELINE_VERDICT_OUTPUT_MISMATCH,
  BASELINE_VERDICT_PROSE_OUTPUT_VERIFIED,
  BaselineEvidence,
  BaselineFinding,
  DEFAULT_BASELINE_TIMEOUT_SECONDS,
  MSG_PLAN_BASELINE_BODY_MISMATCH,
  MSG_PLAN_BASELINE_COMMAND_FAILED,
  MSG_PLAN_BASELINE_EVIDENCE_MISSING,
  MSG_PLAN_BASELINE_INCOMPLETE,
  MSG_PLAN_BASELINE_MISMATCH,
  MSG_PLAN_BASELINE_OUTPUT_MISMATCH,
  MSG_PLAN_BASELINE_ROOT_BUILD,
  ValidationError,
  detectRootBuildCommand,
  evaluateBaselineClaim
} from '../domain';
import { CommandExecutorPort, PlanGeneratorPort } from '../ports';

export interface PlanBaselineContractParams {
  readonly planGenerator?: PlanGeneratorPort;
  readonly planPath: string | null;
  readonly workspaceDir: string;
  readonly commandExecutor?: CommandExecutorPort;
  readonly dryRun?: boolean;
}

const MAX_STDERR_IN_MESSAGE = 400;

function truncateDetail(text: string): string {
  const trimmed = String(text ?? '').trim();
  return trimmed.length > MAX_STDERR_IN_MESSAGE
    ? `${trimmed.slice(0, MAX_STDERR_IN_MESSAGE)}…`
    : trimmed;
}

function formatStructuralFindings(findings: readonly BaselineFinding[]): string {
  return findings
    .map((finding) => {
      if (finding.rule === BASELINE_RULE_MISSING_EVIDENCE) {
        return MSG_PLAN_BASELINE_EVIDENCE_MISSING.replace('{detail}', () => finding.excerpt);
      }
      if (finding.rule === BASELINE_RULE_MISSING_VALUE) {
        return MSG_PLAN_BASELINE_INCOMPLETE.replace('{claim}', () => finding.claim ?? '(unknown)')
          .replace('{line}', () => String(finding.line))
          .replace('{detail}', () => 'the declared value is missing');
      }
      if (finding.rule === BASELINE_RULE_MISSING_COMMAND) {
        return MSG_PLAN_BASELINE_INCOMPLETE.replace('{claim}', () => finding.claim ?? '(unknown)')
          .replace('{line}', () => String(finding.line))
          .replace('{detail}', () => 'the measuring command is missing');
      }
      if (finding.rule === BASELINE_RULE_MISSING_OUTPUT) {
        return MSG_PLAN_BASELINE_INCOMPLETE.replace('{claim}', () => finding.claim ?? '(unknown)')
          .replace('{line}', () => String(finding.line))
          .replace('{detail}', () => 'the command output is missing');
      }
      if (finding.rule === BASELINE_RULE_BODY_MISMATCH) {
        return MSG_PLAN_BASELINE_BODY_MISMATCH.replace('{claim}', () => finding.claim ?? '(unknown)')
          .replace('{line}', () => String(finding.line))
          .replace('{declared}', () => finding.declared ?? '(unknown)')
          .replace('{restated}', () => finding.restated ?? '(unknown)')
          .replace('{excerpt}', () => finding.excerpt);
      }
      return `${finding.rule} at plan line ${finding.line}: ${finding.excerpt}`;
    })
    .join('\n');
}

/**
 * Throws `ValidationError('planBaseline', …)` unless the plan's declared
 * baselines are carried by evidence and match measurement.
 */
export async function assertPlanBaselineContract(
  params: PlanBaselineContractParams
): Promise<void> {
  const { planGenerator, planPath } = params;
  if (!planGenerator || !planPath) return;

  let content: string;
  try {
    content = planGenerator.readPlanDocument(planPath);
  } catch {
    // An unreadable plan is not a baseline list; other guards report that.
    return;
  }

  const evidence = BaselineEvidence.fromPlan(content);

  if (evidence.findings.length > 0) {
    const reason = `${formatStructuralFindings(evidence.findings)} (plan: ${planPath})`;
    if (params.dryRun) {
      console.warn(`[codeloop] Warning: ${reason}`);
      return;
    }
    throw new ValidationError('planBaseline', planPath, reason);
  }

  if (evidence.claimedReproduction && evidence.claims.length === 0) {
    const reason = `${MSG_PLAN_BASELINE_EVIDENCE_MISSING.replace(
      '{detail}',
      () => 'the header claims reproduction but no claim was found'
    )} (plan: ${planPath})`;
    if (params.dryRun) {
      console.warn(`[codeloop] Warning: ${reason}`);
      return;
    }
    throw new ValidationError('planBaseline', planPath, reason);
  }

  // A preview must not run plan-authored code.
  if (params.dryRun) {
    if (evidence.claims.length > 0) {
      console.warn(
        `[codeloop] Warning: --dry-run: ${evidence.claims.length} plan baseline claim(s) were NOT measured; a real approval executes each command and refuses a mismatch.`
      );
    }
    for (const claim of evidence.claims) {
      if (claim.command.length === 0) continue;
      const match = detectRootBuildCommand(claim.command, { workspaceDir: params.workspaceDir });
      if (!match) continue;
      console.warn(
        `[codeloop] Warning: --dry-run: claim "${claim.id}" runs a build-like command (${match.label}); a real approval refuses it.`
      );
    }
    return;
  }

  const executor = params.commandExecutor;
  if (!executor) {
    if (evidence.claims.length > 0) {
      console.warn(
        '[codeloop] Warning: plan baseline commands were not measured — no command executor is wired.'
      );
    }
    return;
  }

  // PRE-FLIGHT (issue #402, D2): a build-like baseline command is refused BY
  // NAME before anything executes, so the guard can never rebuild the root
  // build — the tool executing the pipeline — mid-run.
  for (const claim of evidence.claims) {
    if (claim.command.length === 0) continue;
    const match = detectRootBuildCommand(claim.command, {
      workspaceDir: params.workspaceDir
    });
    if (!match) continue;

    throw new ValidationError(
      'planBaseline',
      planPath,
      MSG_PLAN_BASELINE_ROOT_BUILD.replace('{claim}', () => claim.id)
        .replace('{line}', () => String(claim.line))
        .replace('{command}', () => claim.command)
        .replace('{match}', () => match.label)
    );
  }

  for (const claim of evidence.claims) {
    if (claim.command.length === 0) continue;

    const result = await executor.execute(claim.command, {
      cwd: params.workspaceDir,
      timeoutMs: DEFAULT_BASELINE_TIMEOUT_SECONDS * 1000
    });

    if (result.timedOut || result.exitCode !== 0) {
      const detail = result.timedOut
        ? `timed out after ${DEFAULT_BASELINE_TIMEOUT_SECONDS}s`
        : `exited ${result.exitCode}: ${truncateDetail(result.stderr || result.combinedOutput)}`;
      throw new ValidationError(
        'planBaseline',
        planPath,
        MSG_PLAN_BASELINE_COMMAND_FAILED.replace('{claim}', () => claim.id)
          .replace('{line}', () => String(claim.line))
          .replace('{command}', () => claim.command)
          .replace('{detail}', () => detail)
      );
    }

    const verdict = evaluateBaselineClaim(claim, result.stdout);

    if (verdict.reason === BASELINE_VERDICT_PROSE_OUTPUT_VERIFIED) {
      console.warn(
        `[codeloop] Warning: plan baseline claim "${claim.id}" was accepted on its verified Output, but its Declared label is prose. ${BASELINE_DECLARED_SHAPE_SENTENCE}`
      );
    }
    if (verdict.accepted) continue;

    if (verdict.reason === BASELINE_VERDICT_OUTPUT_MISMATCH) {
      throw new ValidationError(
        'planBaseline',
        planPath,
        MSG_PLAN_BASELINE_OUTPUT_MISMATCH.replace('{claim}', () => claim.id)
          .replace('{line}', () => String(claim.line))
          .replace('{declared}', () => claim.declared)
          .replace('{output}', () => claim.output)
          .replace('{measured}', () => verdict.measured)
          .replace('{command}', () => claim.command)
      );
    }

    throw new ValidationError(
      'planBaseline',
      planPath,
      MSG_PLAN_BASELINE_MISMATCH.replace('{claim}', () => claim.id)
        .replace('{line}', () => String(claim.line))
        .replace('{declared}', () => claim.declared)
        .replace('{measured}', () => verdict.measured)
        .replace('{command}', () => claim.command)
    );
  }
}
