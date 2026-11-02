/**
 * agyloop - the ONE certifying `QUALITY_GATE -> REVIEW` chokepoint (issue #455)
 *
 * The exit to REVIEW CERTIFIES a gate round (#327), so it consumes that round's
 * evidence or it does not exit. Before #455 that contract lived inline in
 * `TransitionStageUseCase`, while `codeloop review` performed the same hop with
 * no evidence check at all: a REVIEW — and a COMMIT — could be recorded for a
 * gate round that never ran.
 *
 * This module owns the WHOLE certifying contract in the existing order:
 *
 *   round -> filed/usable evidence (#327) -> plan digest (#421) ->
 *   declared-target coverage (#408) -> measured test total (#415) ->
 *   unacknowledged deviations (#432)
 *
 * Both entry points call it before they perform the hop, so a future guard
 * cannot be added to one and forgotten on the other (AC3). Every refusal runs
 * before any caller writes anything, and `--dry-run` warns instead of throwing.
 */

import {
  GateResultReport,
  StateMachine,
  ValidationError,
  formatGateEvidenceRequiredMessage,
  formatGateReportPreservedNote,
  formatGateSmokeCoverageRefusal,
  formatGateTargetCoverageRefusal,
  formatGateZeroTestRefusal,
  formatPlanDeviationUnacknowledgedMessage,
  gateTestEvidenceRefusal,
  isUnacknowledged,
  normaliseGateTests,
  resolveGateRound,
  splitSmokeChecks,
  GATE_TEST_EVIDENCE_GAP_UNMEASURED
} from '../domain';
import { GateReportRepositoryPort, PlanGeneratorPort, SummarySmokeCheck } from '../ports';
import { assertApprovedPlanUnchanged } from './plan-digest-contract';
import { assessGateEvidenceCoverage } from './gate-evidence-coverage';

export interface CertifyReviewExitParams {
  readonly stateMachine: StateMachine;
  /**
   * The gate evidence channel. An undefined repository is treated as "nothing
   * filed" — NEVER as "skip the check": a test double may not certify by
   * omission (the same fail-closed rule `transition REVIEW` already applies).
   */
  readonly gateReportRepo?: GateReportRepositoryPort;
  readonly planGenerator?: PlanGeneratorPort;
  /** The plan path the CALLER resolved. Never re-resolved for the digest. */
  readonly planPath: string | null;
  readonly planDir?: string | null;
  readonly issue?: number | string | null;
  readonly workspaceDir: string;
  readonly dryRun?: boolean;
}

export interface CertifiedGateEvidence {
  readonly report: GateResultReport;
  readonly round: number;
  /** Normalised `PASSED (<n> passed)` cell (AC-16). */
  readonly testsStatus: string | null;
  /** Commands only — smoke-check labels partitioned out (AC-17). */
  readonly commands: readonly string[];
  readonly smokeChecks: readonly SummarySmokeCheck[];
  /** Metadata the certifying `REVIEW` entry records (`gateNotRun` is added by the caller). */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Certifies the current gate round for the `QUALITY_GATE -> REVIEW` exit.
 *
 * Returns `null` ONLY when a `--dry-run` refused (it warned instead of
 * throwing). Callers must not treat `null` as "certified": the transition path
 * writes `gateVerdict: NOT_RECORDED`, and the review path records no gate
 * metadata and never consumes the report.
 */
export function certifyReviewExit(
  params: CertifyReviewExitParams
): CertifiedGateEvidence | null {
  const sm = params.stateMachine;
  const issue = params.issue ?? null;
  const round = resolveGateRound(sm.history);
  const filed = params.gateReportRepo ? params.gateReportRepo.load(issue) : null;
  const usable = filed !== null && filed.gateRound === round;

  // #327: the exit CERTIFIES a gate round, so it consumes that round's evidence
  // or it does not exit. Fails CLOSED when no repository was injected.
  if (!usable) {
    const message = formatGateEvidenceRequiredMessage(
      issue,
      round,
      filed ? filed.gateRound : null
    );
    if (params.dryRun) {
      console.warn(`[codeloop] Warning: ${message}`);
    } else {
      throw new ValidationError('gateEvidence', filed ? filed.gateRound : null, message);
    }
  }

  // #421: a plan edited after approval cannot be certified by the stage that
  // follows the gate. The suffix says the evidence survived the refusal, but
  // only when a usable report exists (a digest refusal must not claim evidence
  // it does not have).
  assertApprovedPlanUnchanged({
    planGenerator: params.planGenerator,
    planPath: params.planPath ?? sm.approvedPlanPath,
    expectedDigest: sm.approvedPlanDigest,
    boundary: 'gate',
    dryRun: params.dryRun,
    suffix: usable ? ` ${formatGateReportPreservedNote(issue, round)}` : ''
  });

  if (usable && filed) {
    // #408: a PASSED report must have executed the plan's declared targets.
    const coverage = assessGateEvidenceCoverage({
      planGenerator: params.planGenerator,
      workspaceDir: params.workspaceDir,
      issue,
      planPath: params.planPath,
      planDir: params.planDir ?? null,
      report: filed
    });
    if (coverage.assessed && !coverage.covered) {
      const message = formatGateTargetCoverageRefusal(
        coverage.missing,
        coverage.declared.length,
        issue,
        'ingest'
      );
      if (params.dryRun) {
        console.warn(`[codeloop] Warning: ${message}`);
      } else {
        throw new ValidationError('executedCommands', coverage.missing, message);
      }
    }

    // #444: a PASSED report must also evidence the plan's declared Manual Smoke
    // Test Protocol. The same assessment the filing side ran, so the two cannot
    // disagree about whether this block certifies the round.
    const smoke = coverage.smoke;
    if (smoke.assessed && !smoke.covered) {
      const message = formatGateSmokeCoverageRefusal({
        reason: smoke.reason,
        protocol: filed.smokeProtocol,
        declaredCount: smoke.declared.length,
        missing: smoke.missing,
        skipped: smoke.skipped,
        failed: smoke.failed,
        unknown: smoke.unknown,
        duplicate: smoke.duplicate,
        issue,
        channel: 'ingest'
      });
      if (params.dryRun) {
        console.warn(`[codeloop] Warning: ${message}`);
      } else if (
        smoke.reason === 'protocol-not-declared' ||
        smoke.reason === 'protocol-missing' ||
        smoke.reason === 'protocol-failed'
      ) {
        throw new ValidationError('smokeProtocol', filed.smokeProtocol, message);
      } else {
        throw new ValidationError('smokeChecks', smoke.missing, message);
      }
    }

    // #415: a PASSED report that ran a test command must record a measured
    // positive unique total.
    const testRefusal = gateTestEvidenceRefusal(filed);
    if (testRefusal) {
      const message = formatGateZeroTestRefusal(
        testRefusal.commands,
        issue,
        'ingest',
        testRefusal.gap
      );
      if (params.dryRun) {
        console.warn(`[codeloop] Warning: ${message}`);
      } else {
        throw new ValidationError(
          'testsPassed',
          testRefusal.gap === GATE_TEST_EVIDENCE_GAP_UNMEASURED ? null : 0,
          message
        );
      }
    }
  }

  // #432: an unacknowledged plan deviation must be an explicit decision before
  // the round is certified.
  const unacknowledged = sm.planDeviations.filter(isUnacknowledged);
  if (unacknowledged.length > 0) {
    const message = formatPlanDeviationUnacknowledgedMessage(unacknowledged, issue);
    if (params.dryRun) {
      console.warn(`[codeloop] Warning: ${message}`);
    } else {
      throw new ValidationError(
        'planDeviations',
        unacknowledged.map((record) => record.id),
        message
      );
    }
  }

  // The only way to reach here without usable evidence is a dry run that
  // already warned: a real run threw at the top.
  if (!usable || !filed) {
    return null;
  }

  // Issue #325 (AC-16): `testsPassed` is UNIQUE tests. Normalise once, here,
  // and warn when the report's own arithmetic was rewritten.
  const normalisedTests = normaliseGateTests(filed);
  if (normalisedTests.rewritten) {
    console.warn(
      `[codeloop] Warning: the gate's test total was normalised from "${filed.testsStatus}" to "${normalisedTests.testsStatus}" — \`testsPassed\` counts UNIQUE tests, and a targeted subset is already inside the full suite.`
    );
  } else if (normalisedTests.suspectDoubleCount) {
    // No per-command counts: the total cannot be checked, only challenged.
    console.warn(
      '[codeloop] Warning: `executedCommands` names a command that contains another. `testsPassed` counts UNIQUE tests, so a targeted subset must not be added to the full suite that already ran it.'
    );
  }
  const testsStatus = normalisedTests.testsStatus;

  // Issue #325 (AC-17): `executedCommands` holds COMMANDS only. A legacy block
  // that mixed smoke-check labels into it is partitioned here so the command
  // count matches the plan's target count.
  const partitioned = splitSmokeChecks(filed.executedCommands);
  const commands = partitioned.commands;
  const smokeChecks: readonly SummarySmokeCheck[] =
    filed.smokeChecks.length > 0 ? filed.smokeChecks : partitioned.smokeChecks;

  const metadata: Record<string, unknown> = {
    gateVerdict: filed.verdict,
    gateTests: testsStatus,
    // Issue #315 (AC-15): the gate's self-timer travels under its own name.
    ...(filed.durationMs !== null ? { gateReportedDurationMs: filed.durationMs } : {}),
    gateExecutedCommands: commands,
    ...(smokeChecks.length > 0 ? { gateSmokeChecks: smokeChecks } : {}),
    // Issue #444 (AC3): the certified protocol reaches the REVIEW history entry,
    // so the summary can say which protocol the PASSED block evidenced.
    ...(filed.smokeProtocol !== null ? { smokeProtocol: filed.smokeProtocol } : {})
  };

  return {
    report: filed,
    round,
    testsStatus,
    commands,
    smokeChecks,
    metadata: Object.freeze(metadata)
  };
}
