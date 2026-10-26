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
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
  WorktreeCreationError,
  PreFlightHaltError,
  HALT_TYPE_MISSING_PLAN_DIR,
  ValidationError,
  MSG_PLAN_MODIFIED_DURING_GATE
} from '../domain';
import { StateRepository, WorktreeManagerPort, PlanGeneratorPort } from '../ports';
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

  constructor(
    stateRepo: StateRepository,
    worktreeManager?: WorktreeManagerPort,
    inferBaseBranchUseCase?: InferBaseBranchUseCase,
    planGenerator?: PlanGeneratorPort
  ) {
    this.stateRepo = stateRepo;
    this.worktreeManager = worktreeManager;
    this.inferBaseBranchUseCase = inferBaseBranchUseCase;
    this.planGenerator = planGenerator;
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
        'Cannot transition to PLAN stage without an active plan directory. Use `bin/agyloop plan` or `bin/agyloop <issue>` to initialize the planning phase.',
        HALT_TYPE_MISSING_PLAN_DIR
      );
    }

    const prevStage = sm.currentStage;
    let gateWaitMs = 0;
    if (sm.pausedAtGate && sm.pausedAtTimestamp) {
      gateWaitMs = Math.max(0, Date.now() - new Date(sm.pausedAtTimestamp).getTime());
    }

    if (sm.pausedAtGate) {
      sm.resumeFromGate();
    }

    // #226: legality FIRST. `transition()` is the single thrower of
    // `InvalidTransitionError` (`state-machine.ts:332`), and it now runs before the
    // worktree guardrail below, so a rejected target can no longer have created a
    // worktree and a branch on disk. Nothing is persisted until the save below, so
    // the on-disk checkpoint is byte-identical on the failure path either way.
    sm.transition(params.targetStage, params.metadata || {});

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
    // that opens it must ALSO create the canonical plan directory. Otherwise
    // the discovery subagent invents its own slug and a later `codeloop plan`
    // scaffolds a second directory for the same issue.
    //
    // Only when an issue is known (an ad-hoc run has no artifact to attribute)
    // and never on a dry run. The type is forced to `discovery`: this stage's
    // deliverable is the RCA, and a bare `--issue` invocation has no GitHub
    // gateway to read the issue labels from.
    if (targetStageStr === STAGE_DISCOVERY && !params.dryRun && this.planGenerator) {
      const workspace = params.workspaceDir || process.cwd();
      const activeIssue = params.issue || sm.issue;
      if (activeIssue) {
        const scaffold = this.planGenerator.scaffoldPlanDirectory({
          projectRoot: workspace,
          issue: activeIssue,
          type: 'discovery',
          title: params.title || 'Task Plan',
          planDir: sm.planDir
        });
        if (scaffold && scaffold.planDir) {
          sm.setPlanDir(scaffold.planDir);
        }
      }
    }

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
      await this.stateRepo.save(sm.toSnapshot());

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

          const formatDuration = (ms: number): string => {
            const totalSeconds = Math.max(0, Math.round(ms / MS_PER_SECOND));
            const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
            const seconds = totalSeconds % SECONDS_PER_MINUTE;
            if (minutes > 0) {
              return `${minutes}m ${seconds}s`;
            }
            return `${seconds}s`;
          };

          // Compute duration for the stage just exited
          let prevDurationStr: string | undefined = undefined;
          const history = sm.history;
          if (history.length >= 2) {
            const currentEntry = history[history.length - 1];
            const prevEntry = history[history.length - 2];
            const startTime = new Date(prevEntry.timestamp).getTime();
            const endTime = new Date(currentEntry.timestamp).getTime();
            let durationMs = Math.max(0, endTime - startTime);
            const waitMsForStage = gateWaitMs > 0 ? gateWaitMs : (prevStage === STAGE_IMPLEMENT ? sm.totalHumanWaitMs : 0);
            if (waitMsForStage > 0) {
              durationMs = Math.max(0, durationMs - waitMsForStage);
            }
            prevDurationStr = formatDuration(durationMs);
          }

          const prevMappedStage = stageMap[prevStage];
          const mappedStage = stageMap[targetStageStr];

          // 1. Mark preceding stage as COMPLETED if transitioning forward
          if (prevMappedStage && prevMappedStage !== mappedStage) {
            this.planGenerator.updateSummaryLog(resolvedPlan.summaryPath, {
              stage: prevMappedStage,
              status: SUMMARY_STATUS_COMPLETED,
              duration: prevDurationStr
            });
          } else if (prevMappedStage && prevDurationStr) {
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
