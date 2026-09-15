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
  STAGE_COMMIT,
  STAGE_COMPLETED,
  MODE_YOLO,
  NOTE_COMMIT_CONFIRMED,
  NOTE_COMMIT_AUTO_APPROVED,
  PROMPT_CONFIRM_COMMIT,
  SUMMARY_STAGE_COMMIT_PR,
  SUMMARY_STATUS_COMPLETED,
  CommitMessage,
  CommitExecutionError,
  InvalidTransitionError
} from '../domain';
import {
  StateRepository,
  CommandExecutorPort,
  PlanGeneratorPort,
  ConfirmationPromptPort
} from '../ports';

export interface ExecuteCommitParams {
  readonly commitMessage?: CommitMessage | string | null;
  readonly confirmed?: boolean;
  readonly bypassConfirmation?: boolean;
  readonly staged?: boolean;
  readonly workspaceDir?: string;
  readonly dryRun?: boolean;
  readonly issue?: number | string | null;
}

export interface ExecuteCommitResult {
  readonly success: boolean;
  readonly confirmed: boolean;
  readonly commitHash: string | null;
  readonly commitMessage: CommitMessage;
  readonly currentStage: string;
  readonly stateMachine: StateMachine;
  readonly summaryUpdated: boolean;
}

export class ExecuteCommitUseCase {
  private readonly stateRepo: StateRepository;
  private readonly commandExecutor: CommandExecutorPort;
  private readonly planGenerator?: PlanGeneratorPort;
  private readonly confirmationPrompt?: ConfirmationPromptPort;

  constructor(
    stateRepo: StateRepository,
    commandExecutor: CommandExecutorPort,
    planGenerator?: PlanGeneratorPort,
    confirmationPrompt?: ConfirmationPromptPort
  ) {
    this.stateRepo = stateRepo;
    this.commandExecutor = commandExecutor;
    this.planGenerator = planGenerator;
    this.confirmationPrompt = confirmationPrompt;
  }

  public async execute(params: ExecuteCommitParams = {}): Promise<ExecuteCommitResult> {
    const cwd = params.workspaceDir || process.cwd();
    const snapshot = await this.stateRepo.load();
    const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : StateMachine.createInitial();

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

    if (isExplicitlyConfirmed || isBypassed) {
      userConfirmed = true;
    } else if (this.confirmationPrompt) {
      const promptQuery = `\nProposed Conventional Commit:\n  ${commitMessage.toSingleLine()}\n\nFull Message:\n${commitMessage.toFullMessage()}\n\n${PROMPT_CONFIRM_COMMIT}`;
      userConfirmed = await this.confirmationPrompt.confirm(promptQuery, false);
      if (!userConfirmed) {
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
    } else {
      // Hard invariant: Never commit silently without explicit confirmation
      throw new CommitExecutionError(
        'ExecuteCommit',
        'Human confirmation gate requires explicit approval before committing. Pass confirmed: true, bypassConfirmation: true, or supply ConfirmationPromptPort.'
      );
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

    // Update Summary Log
    let summaryUpdated = false;
    if (this.planGenerator) {
      const issue = sm.issue || params.issue;
      const planLoc = this.planGenerator.resolvePlanFile({
        projectRoot: cwd,
        issue
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
      summaryUpdated
    };
  }
}
