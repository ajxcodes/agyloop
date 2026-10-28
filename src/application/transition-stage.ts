/**
 * agyloop - TransitionStageUseCase
 *
 * Rehydrates StateMachine, executes pure transition, and persists checkpoint.
 */

import {
  StateMachine,
  StageName,
  ExecutionMode,
  MODE_STANDARD,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  SUMMARY_STAGE_DISCOVERY,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STAGE_IMPLEMENTATION,
  SUMMARY_STAGE_QUALITY_GATES,
  SUMMARY_STAGE_AI_REVIEW,
  SUMMARY_STAGE_COMMIT_PR,
  SUMMARY_STATUS_PENDING,
  SUMMARY_STATUS_IN_PROGRESS,
  SUMMARY_STATUS_COMPLETED,
  SUMMARY_STATUS_FAILED,
  SUMMARY_STATUS_NOT_RECORDED,
  DURATION_NOT_RECORDED,
  EVIDENCE_NOT_RECORDED,
  GATE_VERDICT_NOT_RECORDED,
  STATUS_PASSED,
  STATUS_FAILED,
  GateResultReport,
  GateReportNotRun,
  resolveGateRound,
  normaliseGateTests,
  splitSmokeChecks,
  consumedHumanWaitMs,
  deriveStageDuration,
  formatGateReportedDuration,
  measureStageWindowMs,
  parseQualityGateTargets,
  formatActNotRunReason,
  isHumanWaitStage,
  WorktreeCreationError,
  PreFlightHaltError,
  HALT_TYPE_MISSING_PLAN_DIR,
  ValidationError,
  MSG_PLAN_MODIFIED_DURING_GATE,
  formatGateEvidenceRequiredMessage,
  formatTransitionRecoveryCommands
} from '../domain';
import {
  StateRepository,
  WorktreeManagerPort,
  PlanGeneratorPort,
  GateReportRepositoryPort,
  SummaryNotRunEntry,
  SummarySmokeCheck
} from '../ports';
import { InferBaseBranchUseCase } from './infer-base-branch';

export interface TransitionParams {
  readonly targetStage: string | StageName;
  readonly metadata?: Record<string, unknown>;
  readonly mode?: ExecutionMode;
  readonly issue?: number | string | null;
  readonly dryRun?: boolean;
  readonly noWorktree?: boolean;
  readonly baseBranch?: string | null;
  readonly workspaceDir?: string;
  readonly title?: string | null;
}

export class TransitionStageUseCase {
  private readonly stateRepo: StateRepository;
  private readonly worktreeManager?: WorktreeManagerPort;
  private readonly inferBaseBranchUseCase?: InferBaseBranchUseCase;
  private readonly planGenerator?: PlanGeneratorPort;
  /**
   * The gate evidence channel (issue #284). Optional so every existing call
   * site and test keeps working: without it, the gate row is honestly reported
   * as `NOT RECORDED` instead of inheriting a value nobody filed.
   */
  private readonly gateReportRepo?: GateReportRepositoryPort;

  constructor(
    stateRepo: StateRepository,
    worktreeManager?: WorktreeManagerPort,
    inferBaseBranchUseCase?: InferBaseBranchUseCase,
    planGenerator?: PlanGeneratorPort,
    gateReportRepo?: GateReportRepositoryPort
  ) {
    this.stateRepo = stateRepo;
    this.worktreeManager = worktreeManager;
    this.inferBaseBranchUseCase = inferBaseBranchUseCase;
    this.planGenerator = planGenerator;
    this.gateReportRepo = gateReportRepo;
  }

  public async execute(params: TransitionParams): Promise<StateMachine> {
    const snapshot = await this.stateRepo.load();
    let sm: StateMachine;

    if (snapshot) {
      sm = StateMachine.fromSnapshot(snapshot);
      if (params.mode) sm.setMode(params.mode);
      if (params.issue !== undefined && params.issue !== null && params.issue !== '') {
        sm.setIssue(params.issue);
      }
      if (params.baseBranch !== undefined && params.baseBranch !== null && params.baseBranch.trim() !== '') {
        sm.setBaseBranch(params.baseBranch);
      }
    } else {
      sm = StateMachine.createInitial({
        mode: params.mode || MODE_STANDARD,
        issue: params.issue,
        baseBranch: params.baseBranch
      });
    }

    const targetStageStr =
      typeof params.targetStage === 'string'
        ? params.targetStage.toUpperCase()
        : params.targetStage;

    if (targetStageStr === STAGE_PLAN && !sm.planDir) {
      throw new PreFlightHaltError(
        'Cannot transition to PLAN stage without an active plan directory. Use `codeloop plan` or `codeloop <issue>` to initialize the planning phase.',
        HALT_TYPE_MISSING_PLAN_DIR
      );
    }

    const prevStage = sm.currentStage;
    // Issue #284 (AC5): ONE wait measurement, taken by the ONLY code that banks
    // wait. `resumeFromGate()` is already a no-op when there is no pause, so it
    // is called unconditionally — the two pause shapes (gate name + timestamp,
    // timestamp alone) converge here instead of diverging between call sites.
    // What this transition consumed is `after - before`, never the cumulative
    // total: subtracting the whole run's bank from one stage's window is what
    // printed a minutes-long implementation as `0s`.
    const waitBefore = sm.totalHumanWaitMs;
    sm.resumeFromGate();
    const humanWaitMs = consumedHumanWaitMs(waitBefore, sm.totalHumanWaitMs);

    // Issue #284 (D1): ingest the gate's filed evidence BEFORE the transition,
    // so the entry this transition writes carries the verdict, the test count
    // and the measured duration. One source: the checkpoint metadata and the
    // summary cannot disagree, and a gate with nothing filed says `not
    // recorded` rather than inheriting `PENDING` or a previous PASSED.
    const activeIssue = sm.issue || params.issue || null;
    let gateEvidence: GateResultReport | null = null;
    /** AC-16: the normalised `PASSED (<n> passed)` cell, when a report was ingested. */
    let gateTestsStatus: string | null = null;
    /** AC-17: commands only — smoke-check labels are partitioned out at ingest. */
    let gateCommands: readonly string[] = [];
    let gateSmokeChecks: readonly SummarySmokeCheck[] = [];
    let gateNotRun: readonly SummaryNotRunEntry[] = [];
    let transitionMetadata: Record<string, unknown> = { ...(params.metadata || {}) };
    if (prevStage === STAGE_QUALITY_GATE && targetStageStr !== STAGE_QUALITY_GATE) {
      const gateRound = resolveGateRound(sm.history);
      const filed = this.gateReportRepo ? this.gateReportRepo.load(activeIssue) : null;
      const usable = filed !== null && filed.gateRound === gateRound;

      // Issue #327 (Defect 3): the exit to REVIEW CERTIFIES a gate round, so it
      // consumes that round's evidence or it does not exit. The old branch
      // printed a warning and advanced anyway — and the command it advised
      // (`gate-report`) then refused, because filing is legal only at
      // QUALITY_GATE. The refusal below runs BEFORE `sm.transition`, the
      // worktree provisioning, the save and the summary writer: nothing is
      // written and the on-disk checkpoint is byte-identical.
      //
      // It fails CLOSED when the repository is not injected: a test double may
      // not certify by omission. Non-certifying exits (-> IMPLEMENT / -> TRIAGE)
      // keep the honest `NOT RECORDED` record: refusing them would block a
      // legitimate "the gates failed, go fix it" transition.
      if (targetStageStr === STAGE_REVIEW && !usable) {
        throw new ValidationError(
          'gateEvidence',
          filed ? filed.gateRound : null,
          formatGateEvidenceRequiredMessage(
            activeIssue,
            gateRound,
            filed ? filed.gateRound : null
          )
        );
      }

      if (usable) {
        gateEvidence = filed;

        // Issue #325 (AC-16, absorbed): `testsPassed` is UNIQUE tests. The #311
        // gate ran an 86-test targeted subset and then `npm test` (1867, which
        // already included those 86) and filed the sum: 1953. Normalise once,
        // here, and warn when the report's own arithmetic was rewritten.
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
        gateTestsStatus = normalisedTests.testsStatus;

        // Issue #325 (AC-17, absorbed): `executedCommands` holds COMMANDS only.
        // A legacy block that mixed smoke-check labels into it is partitioned
        // here so the command count matches the plan's target count.
        const partitioned = splitSmokeChecks(filed.executedCommands);
        gateCommands = partitioned.commands;
        gateSmokeChecks =
          filed.smokeChecks.length > 0 ? filed.smokeChecks : partitioned.smokeChecks;
        gateNotRun = this.resolveNotRunReasons(filed.notRun, sm, params);

        transitionMetadata = {
          ...transitionMetadata,
          gateVerdict: filed.verdict,
          gateTests: gateTestsStatus,
          // Issue #315 (AC-15): the gate's self-timer travels under its own
          // name. `stageDurationMs` means "this stage measured itself", and the
          // gate is a DIFFERENT stage from the one being entered.
          ...(filed.durationMs !== null ? { gateReportedDurationMs: filed.durationMs } : {}),
          gateExecutedCommands: gateCommands,
          ...(gateSmokeChecks.length > 0 ? { gateSmokeChecks } : {}),
          ...(gateNotRun.length > 0 ? { gateNotRun } : {})
        };
      } else {
        transitionMetadata = {
          ...transitionMetadata,
          gateVerdict: GATE_VERDICT_NOT_RECORDED
        };
        // Issue #327 (AC-7): advice must be executable from the state that
        // prints it. After this non-certifying exit the checkpoint sits at the
        // TARGET, and `gate-report` refuses anywhere but QUALITY_GATE — so the
        // hint names the legal walk BACK to the gate instead.
        //
        // Issue #315 (AC-10, Defect N1): `-> PLAN` is the "fix the plan and
        // re-approve it" recovery. Warning it to walk back into the gate it
        // just abandoned contradicts the action the operator took, so that exit
        // names the re-plan sequence and nothing else. `-> IMPLEMENT` /
        // `-> TRIAGE` keep the walk-back (they genuinely are "go fix it" exits
        // that will need evidence next round).
        if (targetStageStr === STAGE_PLAN) {
          const rePlan = formatTransitionRecoveryCommands(
            STAGE_PLAN,
            STAGE_IMPLEMENT,
            activeIssue,
            sm.mode
          );
          console.warn(
            '[codeloop] Note: this exit records no gate evidence — the plan is being re-worked.' +
              (rePlan === null || rePlan === '' ? '' : ` Continue with: ${rePlan}.`)
          );
        } else {
          const walkBack = formatTransitionRecoveryCommands(
            targetStageStr,
            STAGE_QUALITY_GATE,
            activeIssue,
            sm.mode
          );
          console.warn(
            '[codeloop] Warning: no gate evidence was filed for this round; the summary will say "not recorded".' +
              (walkBack === null
                ? ''
                : ` To file it, return to the gate: ${walkBack}, then run \`codeloop gate-report --issue <n> --report-file <path>\`.`)
          );
        }
      }
    }

    // #226: legality FIRST. `transition()` is the single thrower of
    // `InvalidTransitionError` (`state-machine.ts:332`), and it now runs before the
    // worktree guardrail below, so a rejected target can no longer have created a
    // worktree and a branch on disk. Nothing is persisted until the save below, so
    // the on-disk checkpoint is byte-identical on the failure path either way.
    sm.transition(params.targetStage, transitionMetadata);

    // Consume-on-ingest (issue #284): one filed report certifies exactly one
    // gate round, so the same PASSED can never be applied to a later run. A
    // report whose round did not match is discarded too — it is stale evidence.
    // A dry run only READS: it must never consume evidence it did not use.
    if (!params.dryRun && prevStage === STAGE_QUALITY_GATE && targetStageStr !== STAGE_QUALITY_GATE) {
      this.gateReportRepo?.clear(activeIssue);
    }

    // Issue #298: the approved plan is frozen for the whole IMPLEMENT ->
    // QUALITY_GATE -> REVIEW loop. Entering IMPLEMENT from a fresh approval
    // records the digest; entering from a retry/self-correction preserves it.
    if (targetStageStr === STAGE_IMPLEMENT && !params.dryRun) {
      const fromFreshApproval =
        prevStage === STAGE_PLAN || prevStage === STAGE_APPROVAL || prevStage === STAGE_COMPLETED;
      if (fromFreshApproval || !sm.approvedPlanDigest) {
        this.recordApprovedPlanDigest(sm, params);
      }
    }

    // Certification requires the artifact that was approved. A plan edited
    // after approval cannot be certified by the stage that follows the gate.
    if (
      prevStage === STAGE_QUALITY_GATE &&
      targetStageStr === STAGE_REVIEW &&
      !params.dryRun
    ) {
      this.assertApprovedPlanUnchanged(sm, params);
    }

    // Issue #283: DISCOVERY is where the RCA report is written, so the stage
    // that opens it must ALSO create the canonical plan directory.
    //
    // Issue #301 (P10): the scaffold runs AFTER the checkpoint save below. A
    // REFUSED save therefore scaffolds nothing — the tree stays byte-identical
    // and the command exits non-zero, instead of writing artifacts for a
    // transition that never happened.

    if (targetStageStr === STAGE_APPROVAL || targetStageStr === STAGE_COMMIT) {
      sm.pauseAtGate(targetStageStr);
    }

    // Guardrail: auto-provision worktree on entering IMPLEMENT stage.
    // Only reachable once the transition is known to be legal.
    if (targetStageStr === STAGE_IMPLEMENT) {
      // `dryRun` is part of `skipWorktree`, not just `noWorktree`: the save below
      // is gated on `!params.dryRun`, so provisioning here would leave a real
      // `.worktrees/<id>` + branch on disk paired with NO checkpoint referencing it —
      // an orphan the operator had to prune by hand (#226).
      const skipWorktree =
        params.noWorktree === true || params.metadata?.noWorktree === true || params.dryRun === true;

      if (!skipWorktree) {
        // Auto-provision worktree if not yet registered in state
        if (!sm.worktree && this.worktreeManager) {
          const workspace = params.workspaceDir || process.cwd();
          const activeIssue = params.issue || sm.issue;
          const taskId = activeIssue || 'adhoc';

          let baseBranch = params.baseBranch || sm.baseBranch || undefined;
          let branchPrefix: string | undefined = undefined;

          if (this.inferBaseBranchUseCase) {
            try {
              const inference = await this.inferBaseBranchUseCase.execute({
                issueNumber: activeIssue,
                title: params.title,
                explicitBaseBranch: baseBranch,
                workspaceDir: workspace
              });
              baseBranch = inference.baseBranch;
              branchPrefix = inference.taskBranchPrefix;
            } catch {
              // Non-fatal inference fallback
            }
          }

          try {
            const descriptor = await this.worktreeManager.createWorktree({
              taskId,
              baseBranch,
              branchPrefix,
              title: params.title,
              workspaceDir: workspace
            });
            sm.setWorktree(descriptor);
            if (baseBranch) {
              sm.setBaseBranch(baseBranch);
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            throw new WorktreeCreationError(
              'createWorktree',
              `Failed to auto-provision worktree for IMPLEMENT transition: ${errMsg}`
            );
          }
        }

        // Hard invariant: cannot enter IMPLEMENT without active worktree descriptor
        if (!sm.worktree) {
          throw new WorktreeCreationError(
            'transitionStage',
            'Cannot transition to IMPLEMENT stage without an active worktree descriptor. An isolated worktree must be provisioned (pass --no-worktree to bypass).'
          );
        }
      }
    }

    if (!params.dryRun) {
      // Issue #284: entering the gate invalidates any stale report BEFORE the
      // save, so a re-run that files nothing cannot inherit the previous PASSED.
      if (targetStageStr === STAGE_QUALITY_GATE && prevStage !== STAGE_QUALITY_GATE) {
        this.gateReportRepo?.clear(activeIssue);
      }
      await this.stateRepo.save(sm.toSnapshot());

      // Issue #283: DISCOVERY is where the RCA report is written, so the stage
      // that opens it must ALSO create the canonical plan directory. Otherwise
      // the discovery subagent invents its own slug and a later `codeloop plan`
      // scaffolds a second directory for the same issue.
      //
      // Only when an issue is known (an ad-hoc run has no artifact to attribute).
      // The type is forced to `discovery`: this stage's deliverable is the RCA,
      // and a bare `--issue` invocation has no GitHub gateway to read the issue
      // labels from.
      //
      // Issue #301 (P10): this runs AFTER the save above — a refused save means
      // nothing is scaffolded, so the tree stays byte-identical.
      if (targetStageStr === STAGE_DISCOVERY && this.planGenerator) {
        const scaffoldWorkspace = params.workspaceDir || process.cwd();
        const scaffoldIssue = params.issue || sm.issue;
        if (scaffoldIssue) {
          try {
            const scaffold = this.planGenerator.scaffoldPlanDirectory({
              projectRoot: scaffoldWorkspace,
              issue: scaffoldIssue,
              type: 'discovery',
              title: params.title || 'Task Plan',
              planDir: sm.planDir
            });
            if (scaffold?.planDir && sm.planDir !== scaffold.planDir) {
              sm.setPlanDir(scaffold.planDir);
              // Second save records the adopted directory. Best effort: the
              // artifact already exists and the next run adopts it via
              // findPlanDirectory.
              await this.stateRepo.save(sm.toSnapshot());
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[codeloop] Warning: the plan directory could not be scaffolded: ${msg}`);
          }
        }
      }

      if (this.planGenerator) {
        const workspace = params.workspaceDir || process.cwd();
        const activeIssue = sm.issue || params.issue;
        const resolvedPlan = this.planGenerator.resolvePlanFile({
          projectRoot: workspace,
          issue: activeIssue,
          planDir: sm.planDir
        });
        if (resolvedPlan && resolvedPlan.summaryPath) {
          const stageMap: Record<string, string> = {
            [STAGE_DISCOVERY]: SUMMARY_STAGE_DISCOVERY,
            [STAGE_PLAN]: SUMMARY_STAGE_PLAN_REVIEW,
            [STAGE_APPROVAL]: SUMMARY_STAGE_PLAN_REVIEW,
            [STAGE_IMPLEMENT]: SUMMARY_STAGE_IMPLEMENTATION,
            [STAGE_QUALITY_GATE]: SUMMARY_STAGE_QUALITY_GATES,
            [STAGE_REVIEW]: SUMMARY_STAGE_AI_REVIEW,
            [STAGE_COMMIT]: SUMMARY_STAGE_COMMIT_PR,
            [STAGE_COMPLETED]: SUMMARY_STAGE_COMMIT_PR
          };

          // Issue #284 (AC5): the duration of the stage that ENDED.
          //
          // A stage that measured itself records the measurement on the entry
          // this transition just wrote (`stageDurationMs` always describes the
          // stage that ended). The history window is only the fallback, and it
          // is subtracted by the wait THIS transition consumed — never by the
          // cumulative `totalHumanWaitMs`.
          //
          // Issue #315 (AC-15): the GATE's own timer is NOT a stage
          // self-measurement — it is `gateReportedDurationMs`, because the gate
          // ran out of process and the stage the transition enters is a
          // different one. It is rendered by name (AC-18), never as a plain
          // `stageDurationMs`.
          //
          // A human-wait gate row has no work of its own. Without a
          // self-measurement it writes NO duration (`undefined`), which leaves
          // the work stage's cell in place instead of printing the human idle
          // time as stage work.
          const exitedStage = prevStage;
          const writtenMetadata = sm.history[sm.history.length - 1]?.metadata ?? {};
          const selfMeasuredMs =
            typeof writtenMetadata.stageDurationMs === 'number'
              ? writtenMetadata.stageDurationMs
              : undefined;
          const gateReportedMs =
            typeof writtenMetadata.gateReportedDurationMs === 'number'
              ? writtenMetadata.gateReportedDurationMs
              : undefined;
          const prevDurationStr: string | undefined =
            isHumanWaitStage(exitedStage) && selfMeasuredMs === undefined
              ? undefined
              : deriveStageDuration(sm.history, exitedStage, {
                  stageDurationMs: selfMeasuredMs,
                  humanWaitMs
                });

          const prevMappedStage = stageMap[prevStage];
          const mappedStage = stageMap[targetStageStr];

          // 1. Mark preceding stage as COMPLETED if transitioning forward
          if (prevMappedStage && prevMappedStage !== mappedStage) {
            if (exitedStage === STAGE_QUALITY_GATE) {
              // Issue #284 (AC1/AC2): the gate row reports the gate that
              // actually ran — verdict, build system, test count and measured
              // duration — from the metadata this transition just wrote, so the
              // checkpoint and the summary cannot disagree. With no filed
              // evidence the row says `NOT RECORDED`, never `PENDING`.
              const writtenVerdict =
                typeof writtenMetadata.gateVerdict === 'string'
                  ? writtenMetadata.gateVerdict
                  : GATE_VERDICT_NOT_RECORDED;
              const gateRowStatus =
                writtenVerdict === STATUS_PASSED
                  ? SUMMARY_STATUS_COMPLETED
                  : writtenVerdict === STATUS_FAILED
                    ? SUMMARY_STATUS_FAILED
                    : SUMMARY_STATUS_NOT_RECORDED;

              this.planGenerator.updateSummaryLog(resolvedPlan.summaryPath, {
                stage: prevMappedStage,
                status: gateRowStatus,
                // Issue #315 (AC-15/AC-18): the cell names the clock it shows.
                // The gate ran OUTSIDE this process: only a filed report can
                // measure its duration, and `(gate-reported; … wall)` keeps the
                // self-timer from posing as the stage's wall clock. With no
                // evidence the cell is `-`, never a guess.
                duration:
                  gateReportedMs !== undefined
                    ? formatGateReportedDuration(
                        gateReportedMs,
                        // Measurable once this transition has left the gate: its
                        // entry is the penultimate one. `null` means the label
                        // names only the clock it is showing.
                        measureStageWindowMs(sm.history, STAGE_QUALITY_GATE),
                      )
                    : DURATION_NOT_RECORDED,
                buildStatus: gateEvidence ? gateEvidence.buildStatus : EVIDENCE_NOT_RECORDED,
                testsStatus: gateTestsStatus ?? EVIDENCE_NOT_RECORDED,
                ...(gateEvidence
                  ? {
                      buildSystem: gateEvidence.buildSystem,
                      executedCommands: gateCommands
                    }
                  : {}),
                ...(gateSmokeChecks.length > 0 ? { smokeChecks: gateSmokeChecks } : {}),
                ...(gateNotRun.length > 0 ? { notRun: gateNotRun } : {})
              });
            } else {
              this.planGenerator.updateSummaryLog(resolvedPlan.summaryPath, {
                stage: prevMappedStage,
                status: SUMMARY_STATUS_COMPLETED,
                ...(prevDurationStr !== undefined ? { duration: prevDurationStr } : {})
              });
            }
          } else if (prevMappedStage && prevDurationStr !== undefined) {
            this.planGenerator.updateSummaryLog(resolvedPlan.summaryPath, {
              stage: prevMappedStage,
              duration: prevDurationStr
            });
          }

          // 2. Update current target stage
          if (mappedStage) {
            const statusMap: Record<string, string> = {
              [STAGE_APPROVAL]: SUMMARY_STATUS_PENDING,
              [STAGE_IMPLEMENT]: SUMMARY_STATUS_IN_PROGRESS,
              [STAGE_COMPLETED]: SUMMARY_STATUS_COMPLETED
            };
            this.planGenerator.updateSummaryLog(resolvedPlan.summaryPath, {
              stage: mappedStage,
              status: statusMap[targetStageStr] || SUMMARY_STATUS_IN_PROGRESS,
              notes: (params.metadata?.note as string) || undefined
            });
          }
        }
      }
    }

    return sm;
  }

  /**
   * Rewrites the `Not Run` reasons the TOOL can evidence (issue #325.4, AC-19).
   *
   * An agent's own explanation for omitting `act` is not evidence: the #311
   * gate claimed "no CI-workflow simulation in scope" while
   * `.github/workflows/` existed, and the real cause was precedence — approved
   * plan targets outrank `resolveActCommand`, and `act` was not installed. So
   * when the plan DOES declare verification targets, the `act` reason is the
   * tool's ("plan targets took precedence"). Every other entry, and every case
   * the tool cannot evidence, passes through untouched.
   */
  private resolveNotRunReasons(
    notRun: readonly GateReportNotRun[],
    sm: StateMachine,
    params: TransitionParams
  ): readonly SummaryNotRunEntry[] {
    if (!Array.isArray(notRun) || notRun.length === 0) {
      return [];
    }
    const mentionsAct = notRun.some((entry) => TransitionStageUseCase.isActEntry(entry));
    const planTargetCount = mentionsAct ? this.countPlanTargets(sm, params) : 0;
    return notRun.map((entry) =>
      planTargetCount > 0 && TransitionStageUseCase.isActEntry(entry)
        ? {
            id: entry.id,
            label: entry.label,
            reason: formatActNotRunReason({ planTargetCount, actSkip: 'plan-precedence' })
          }
        : { id: entry.id, label: entry.label, reason: entry.reason }
    );
  }

  /** The plan's declared verification target count, or 0 when unreadable. */
  private countPlanTargets(sm: StateMachine, params: TransitionParams): number {
    if (!this.planGenerator) {
      return 0;
    }
    const resolved = this.resolveCurrentPlan(sm, params);
    if (!resolved) {
      return 0;
    }
    try {
      return parseQualityGateTargets(this.planGenerator.readPlanDocument(resolved.planPath)).commands
        .length;
    } catch {
      // An unreadable plan is not a target list; keep the reporter's own text.
      return 0;
    }
  }

  /** True when a not-run entry names the `act` CI simulation. */
  private static isActEntry(entry: GateReportNotRun): boolean {
    return /^act\b/i.test(entry.id) || /^act\b/i.test(entry.label);
  }

  /** Resolves the current plan document, or null when nothing is resolvable. */
  private resolveCurrentPlan(
    sm: StateMachine,
    params: TransitionParams
  ): { planPath: string } | null {
    if (!this.planGenerator) return null;
    const workspace = params.workspaceDir || process.cwd();
    const resolved = this.planGenerator.resolvePlanFile({
      projectRoot: workspace,
      issue: sm.issue || params.issue,
      planPath: sm.planPath ?? sm.approvedPlanPath ?? undefined,
      planDir: sm.planDir
    });
    if (resolved?.planPath) {
      return { planPath: resolved.planPath };
    }
    return sm.approvedPlanPath ? { planPath: sm.approvedPlanPath } : null;
  }

  private hashPlan(planPath: string): string | null {
    if (!this.planGenerator || typeof this.planGenerator.hashPlanDocument !== 'function') {
      return null;
    }
    return this.planGenerator.hashPlanDocument(planPath);
  }

  private recordApprovedPlanDigest(sm: StateMachine, params: TransitionParams): void {
    const resolved = this.resolveCurrentPlan(sm, params);
    if (!resolved) return;
    const digest = this.hashPlan(resolved.planPath);
    if (digest) {
      sm.recordApprovedPlan(resolved.planPath, digest);
    }
  }

  private assertApprovedPlanUnchanged(sm: StateMachine, params: TransitionParams): void {
    const expected = sm.approvedPlanDigest;
    if (!expected) return;

    const resolved = this.resolveCurrentPlan(sm, params);
    const planPath = resolved?.planPath ?? sm.approvedPlanPath;
    const actual = planPath ? this.hashPlan(planPath) : null;

    if (actual !== null && actual === expected) {
      return;
    }

    throw new ValidationError(
      'approvedPlanDigest',
      actual,
      MSG_PLAN_MODIFIED_DURING_GATE
        .replace('{path}', planPath ?? '(unknown plan path)')
        .replace('{expected}', expected)
        .replace('{actual}', actual ?? '(unreadable)')
    );
  }
}
