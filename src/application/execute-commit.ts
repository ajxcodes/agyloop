/**
 * agyloop - ExecuteCommitUseCase (Application Layer)
 *
 * Coordinates commit execution & human confirmation gate:
 * 1. Validates pipeline stage (must be at STAGE_COMMIT).
 * 2. Resolves CommitMessage (from params or drafting).
 * 3. Enforces Human Approval Confirmation Gate (never commits silently in standard mode).
 * 4. Executes git commit via CommandExecutorPort upon confirmation.
 * 5. Advances StateMachine transition: STAGE_COMMIT -> STAGE_COMPLETED.
 * 6. Updates AgyLoop Summary.md stage Commit / PR with commit hash, message, and timestamp.
 * 7. Checkpoints state to StateRepository.
 *
 * Strict Hexagonal Architecture: zero direct I/O, zero Node.js built-ins.
 */

import {
  StateMachine,
  StageName,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  MODE_YOLO,
  NOTE_COMMIT_CONFIRMED,
  NOTE_COMMIT_AUTO_APPROVED,
  PROMPT_CONFIRM_COMMIT,
  SUMMARY_STAGE_COMMIT_PR,
  SUMMARY_STATUS_COMPLETED,
  CommitMessage,
  CommitExecutionError,
  InvalidTransitionError,
  buildGitTokenRedirectConfig
} from '../domain';
import {
  StateRepository,
  CommandExecutorPort,
  PlanGeneratorPort,
  ConfirmationPromptPort,
  WorktreeManagerPort
} from '../ports';

export interface ExecuteCommitParams {
  readonly commitMessage?: CommitMessage | string | null;
  readonly confirmed?: boolean;
  readonly bypassConfirmation?: boolean;
  readonly staged?: boolean;
  readonly workspaceDir?: string;
  readonly rootWorkspaceDir?: string;
  readonly dryRun?: boolean;
  readonly issue?: number | string | null;
  readonly keepWorktree?: boolean;
  readonly rejectionTarget?: 'IMPLEMENT' | 'PLAN' | StageName | null;
  readonly rejectionDirective?: 'replan' | 'implement' | string | null;
  readonly rejectionFeedback?: string | null;
  readonly rejectionReason?: string | null;
}

export interface ExecuteCommitResult {
  readonly success: boolean;
  readonly confirmed: boolean;
  readonly commitHash: string | null;
  readonly commitMessage: CommitMessage;
  readonly currentStage: string;
  readonly stateMachine: StateMachine;
  readonly summaryUpdated: boolean;
  readonly prBaseBranch?: string;
  readonly prCommand?: string;
  readonly worktreeTornDown?: boolean;
  readonly pushError?: string;
  readonly fallbackUsed?: boolean;
}

export class ExecuteCommitUseCase {
  private readonly stateRepo: StateRepository;
  private readonly commandExecutor: CommandExecutorPort;
  private readonly planGenerator?: PlanGeneratorPort;
  private readonly confirmationPrompt?: ConfirmationPromptPort;
  private readonly worktreeManager?: WorktreeManagerPort;

  constructor(
    stateRepo: StateRepository,
    commandExecutor: CommandExecutorPort,
    planGenerator?: PlanGeneratorPort,
    confirmationPrompt?: ConfirmationPromptPort,
    worktreeManager?: WorktreeManagerPort
  ) {
    this.stateRepo = stateRepo;
    this.commandExecutor = commandExecutor;
    this.planGenerator = planGenerator;
    this.confirmationPrompt = confirmationPrompt;
    this.worktreeManager = worktreeManager;
  }

  public async execute(params: ExecuteCommitParams = {}): Promise<ExecuteCommitResult> {
    const initialDir = params.workspaceDir || process.cwd();
    const snapshot = await this.stateRepo.load();
    const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : StateMachine.createInitial();
    const cwd = sm.worktree?.worktreePath || initialDir;
    const rootDir = params.rootWorkspaceDir || initialDir;

    if (sm.currentStage !== STAGE_COMMIT) {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_COMPLETED,
        sm.mode,
        `Cannot execute commit: Pipeline is at stage '${sm.currentStage}'. Current stage must be '${STAGE_COMMIT}'.`
      );
    }

    // Resolve CommitMessage
    let commitMessage: CommitMessage;
    if (params.commitMessage instanceof CommitMessage) {
      commitMessage = params.commitMessage;
    } else if (typeof params.commitMessage === 'string' && params.commitMessage.trim()) {
      try {
        commitMessage = CommitMessage.parse(params.commitMessage.trim());
      } catch {
        commitMessage = CommitMessage.create({
          type: 'feat',
          description: params.commitMessage.trim(),
          issueNumber: sm.issue
        });
      }
    } else {
      throw new CommitExecutionError(
        'ExecuteCommit',
        'Commit message is required. Please provide a valid CommitMessage.'
      );
    }

    // Dry-run mode: return simulated execution result immediately without prompting
    if (params.dryRun) {
      return {
        success: true,
        confirmed: true,
        commitHash: 'dry-run-simulated-commit-hash',
        commitMessage,
        currentStage: sm.currentStage,
        stateMachine: sm,
        summaryUpdated: false
      };
    }

    // Human Confirmation Gate Evaluation
    const isYolo = sm.mode === MODE_YOLO;
    const isExplicitlyConfirmed = params.confirmed === true;
    const isBypassed = params.bypassConfirmation === true || isYolo;

    let userConfirmed = false;

    if (params.confirmed === false) {
      userConfirmed = false;
    } else if (isExplicitlyConfirmed || isBypassed) {
      userConfirmed = true;
    } else if (this.confirmationPrompt) {
      const promptQuery = `\nProposed Conventional Commit:\n  ${commitMessage.toSingleLine()}\n\nFull Message:\n${commitMessage.toFullMessage()}\n\n${PROMPT_CONFIRM_COMMIT}`;
      userConfirmed = await this.confirmationPrompt.confirm(promptQuery, false);
    } else {
      // Hard invariant: Never commit silently without explicit confirmation
      throw new CommitExecutionError(
        'ExecuteCommit',
        'Human confirmation gate requires explicit approval before committing. Pass confirmed: true, bypassConfirmation: true, or supply ConfirmationPromptPort.'
      );
    }

    if (!userConfirmed) {
      const hasDirective =
        params.rejectionDirective !== undefined && params.rejectionDirective !== null ||
        params.rejectionTarget !== undefined && params.rejectionTarget !== null ||
        params.rejectionReason !== undefined && params.rejectionReason !== null ||
        params.rejectionFeedback !== undefined && params.rejectionFeedback !== null;

      if (hasDirective) {
        const rawDirective = String(params.rejectionDirective || '').toLowerCase();
        const rawTarget = String(params.rejectionTarget || '').toUpperCase();
        const target = (rawDirective === 'replan' || rawTarget === 'PLAN') ? STAGE_PLAN : STAGE_IMPLEMENT;
        const reason = params.rejectionReason || params.rejectionFeedback || `Commit rejected: routed to ${target}`;

        sm.transition(target, {
          note: `Commit rejected by developer: Routed to ${target}`,
          rejectionFeedback: reason
        });
        await this.stateRepo.save(sm.toSnapshot());

        let summaryUpdated = false;
        if (this.planGenerator) {
          const issue = sm.issue || params.issue;
          const planLoc = this.planGenerator.resolvePlanFile({
            projectRoot: cwd,
            issue,
            planDir: sm.planDir
          });
          if (planLoc?.summaryPath) {
            summaryUpdated = this.planGenerator.updateSummaryLog(planLoc.summaryPath, {
              stage: SUMMARY_STAGE_COMMIT_PR,
              status: 'REJECTED',
              commitRejection: {
                targetStage: target,
                reason
              }
            });
          }
        }

        return {
          success: false,
          confirmed: false,
          commitHash: null,
          commitMessage,
          currentStage: sm.currentStage,
          stateMachine: sm,
          summaryUpdated
        };
      }

      return {
        success: false,
        confirmed: false,
        commitHash: null,
        commitMessage,
        currentStage: sm.currentStage,
        stateMachine: sm,
        summaryUpdated: false
      };
    }

    // Check git status / uncommitted changes
    const statusRes = await this.commandExecutor.execute('git status --porcelain', { cwd });
    if (!statusRes.stdout.trim()) {
      throw new CommitExecutionError(
        'git status',
        'Working tree clean; no changes available to commit.'
      );
    }

    // Stage changes if not already strictly staged
    if (!params.staged) {
      const addRes = await this.commandExecutor.execute('git add -A', { cwd });
      if (addRes.exitCode !== 0) {
        throw new CommitExecutionError(
          'git add',
          addRes.stderr || addRes.stdout || 'Failed to stage working changes.'
        );
      }
      // Defensive untrack: remove any accidentally staged symlinks (.agyloop, node_modules, artifacts)
      await this.commandExecutor.execute('git rm --cached -rf .agyloop node_modules artifacts || true', { cwd });
    }

    // Execute git commit
    const fullMsg = commitMessage.toFullMessage();
    const escapedMsg = fullMsg.replace(/"/g, '\\"');
    const commitRes = await this.commandExecutor.execute(`git commit -m "${escapedMsg}"`, { cwd });

    if (commitRes.exitCode !== 0) {
      throw new CommitExecutionError(
        'git commit',
        commitRes.stderr || commitRes.stdout || 'Git commit command failed.'
      );
    }

    // Capture commit hash
    const revRes = await this.commandExecutor.execute('git rev-parse HEAD', { cwd });
    const commitHash = revRes.stdout.trim() || 'unknown';

    // Advance StateMachine
    const transitionNote = isYolo ? NOTE_COMMIT_AUTO_APPROVED : NOTE_COMMIT_CONFIRMED;
    sm.transition(STAGE_COMPLETED, {
      note: transitionNote,
      commitHash,
      commitMessage: commitMessage.toSingleLine()
    });

    // Checkpoint state
    await this.stateRepo.save(sm.toSnapshot());

    // Resolve PR target base branch (inferred collector branch or main)
    const prBaseBranch = sm.baseBranch || 'main';

    // Resolve active branch (worktree branch or git rev-parse HEAD fallback)
    let activeBranch = sm.worktree?.branch || '';
    if (!activeBranch) {
      try {
        const branchRes = await this.commandExecutor.execute('git rev-parse --abbrev-ref HEAD', { cwd });
        const detected = branchRes.stdout.trim();
        if (detected && detected !== 'HEAD') {
          activeBranch = detected;
        }
      } catch {
        // Fallback resolution failure non-fatal
      }
    }

    const prCommand = activeBranch
      ? `gh pr create --base "${prBaseBranch}" --head "${activeBranch}"`
      : `gh pr create --base "${prBaseBranch}"`;

    // Remote Task Branch Push with Automated Token Fallback
    let pushFailed = false;
    let pushError: string | undefined;
    let fallbackUsed = false;

    if (activeBranch) {
      try {
        const pushRes = await this.commandExecutor.execute(`git push -u origin "${activeBranch}"`, { cwd });
        if (pushRes.exitCode !== 0) {
          const standardError = (pushRes.stderr || pushRes.stdout || 'Git push failed.').trim();

          // Attempt HTTPS token fallback
          const tokenRes = await this.commandExecutor.execute('gh auth token', { cwd });
          const token = tokenRes.stdout.trim();

          if (token && tokenRes.exitCode === 0) {
            const redirectConfig = buildGitTokenRedirectConfig(token);
            const fallbackCmd = `git ${redirectConfig} push -u origin "${activeBranch}"`;

            const fallbackRes = await this.commandExecutor.execute(fallbackCmd, { cwd });
            if (fallbackRes.exitCode === 0) {
              fallbackUsed = true;
            } else {
              pushFailed = true;
              pushError = (fallbackRes.stderr || fallbackRes.stdout || standardError).trim();
            }
          } else {
            pushFailed = true;
            pushError = standardError;
          }
        }
      } catch (err: unknown) {
        pushFailed = true;
        pushError = err instanceof Error ? err.message : String(err);
      }
    }

    // Automated Worktree Teardown
    let worktreeTornDown = false;
    const shouldTeardown = !params.keepWorktree && Boolean(sm.worktree) && Boolean(this.worktreeManager) && !pushFailed;

    if (shouldTeardown && this.worktreeManager && sm.worktree) {
      const wtPath = sm.worktree.worktreePath;

      let doTeardown = false;
      if (isExplicitlyConfirmed || isBypassed) {
        doTeardown = true;
      } else if (this.confirmationPrompt) {
        doTeardown = await this.confirmationPrompt.confirm(
          `\nTeardown isolated git worktree at ${wtPath}?`,
          true
        );
      }

      if (doTeardown) {
        try {
          await this.worktreeManager.removeWorktree({
            worktreePath: wtPath,
            workspaceDir: rootDir,
            force: true,
            prune: true
          });
          sm.setWorktree(null);
          await this.stateRepo.save(sm.toSnapshot());
          worktreeTornDown = true;
        } catch {
          // Teardown failure non-fatal
        }
      }
    }

    // Best-effort cleanup of stale external subagent worktrees
    if (this.worktreeManager) {
      try {
        await this.worktreeManager.cleanOrphanedWorktrees({
          workspaceDir: rootDir,
          subagents: true
        });
      } catch {
        // Non-blocking best effort cleanup
      }
    }

    // Update Summary Log
    let summaryUpdated = false;
    if (this.planGenerator) {
      const issue = sm.issue || params.issue;
      const planLoc = this.planGenerator.resolvePlanFile({
        projectRoot: rootDir,
        issue,
        planDir: sm.planDir
      });
      const summaryPath = planLoc?.summaryPath;
      if (summaryPath) {
        summaryUpdated = this.planGenerator.updateSummaryLog(summaryPath, {
          stage: SUMMARY_STAGE_COMMIT_PR,
          status: SUMMARY_STATUS_COMPLETED,
          commitHash,
          commitMessage: commitMessage.toSingleLine(),
          commitTimestamp: new Date().toISOString()
        });
      }
    }

    return {
      success: true,
      confirmed: true,
      commitHash,
      commitMessage,
      currentStage: sm.currentStage,
      stateMachine: sm,
      summaryUpdated,
      prBaseBranch,
      prCommand,
      worktreeTornDown,
      pushError,
      fallbackUsed
    };
  }
}
