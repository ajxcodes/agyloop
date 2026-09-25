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
  WorktreeCreationError
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

    // Guardrail: Auto-provision worktree on entering IMPLEMENT stage
    if (targetStageStr === STAGE_IMPLEMENT) {
      const skipWorktree = params.noWorktree === true || params.metadata?.noWorktree === true;

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

    const prevStage = sm.currentStage;
    let gateWaitMs = 0;
    if (sm.pausedAtGate && sm.pausedAtTimestamp) {
      gateWaitMs = Math.max(0, Date.now() - new Date(sm.pausedAtTimestamp).getTime());
    }

    if (sm.pausedAtGate) {
      sm.resumeFromGate();
    }

    sm.transition(params.targetStage, params.metadata || {});

    if (targetStageStr === STAGE_APPROVAL || targetStageStr === STAGE_COMMIT) {
      sm.pauseAtGate(targetStageStr);
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
}
