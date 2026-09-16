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
  STAGE_IMPLEMENT,
  WorktreeCreationError
} from '../domain';
import { StateRepository, WorktreeManagerPort } from '../ports';
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

  constructor(
    stateRepo: StateRepository,
    worktreeManager?: WorktreeManagerPort,
    inferBaseBranchUseCase?: InferBaseBranchUseCase
  ) {
    this.stateRepo = stateRepo;
    this.worktreeManager = worktreeManager;
    this.inferBaseBranchUseCase = inferBaseBranchUseCase;
  }

  public async execute(params: TransitionParams): Promise<StateMachine> {
    const snapshot = await this.stateRepo.load();
    let sm: StateMachine;

    if (snapshot) {
      sm = StateMachine.fromSnapshot(snapshot);
      if (params.mode) sm.setMode(params.mode);
      if (params.issue !== undefined) sm.setIssue(params.issue);
      if (params.baseBranch) sm.setBaseBranch(params.baseBranch);
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

    sm.transition(params.targetStage, params.metadata || {});

    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());
    }

    return sm;
  }
}
