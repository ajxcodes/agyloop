/**
 * agyloop - StartImplementationUseCase
 *
 * Coordinates implementation phase execution:
 * 1. Validates lifecycle stage rules (must be APPROVAL, or YOLO bypass, or resuming IMPLEMENT)
 * 2. Advances StateMachine transition: APPROVAL -> IMPLEMENT
 * 3. Resolves and reads approved plan document from artifacts/plans/<target>/
 * 4. Resolves implementer subagent configuration with write permissions
 * 5. Generates focused, token-minimized handoff prompt
 * 6. Checkpoints state to StateRepository and updates AgyLoop Summary.md
 */

import {
  StateMachine,
  STAGE_NONE,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  STAGE_COMPLETED,
  MODE_STANDARD,
  MODE_YOLO,
  ROLE_IMPLEMENTER,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STAGE_IMPLEMENTATION,
  SUMMARY_STATUS_APPROVED,
  SUMMARY_STATUS_IN_PROGRESS,
  NOTE_DEVELOPER_APPROVED,
  NOTE_AUTO_APPROVED_YOLO,
  NOTE_IMPLICIT_APPROVAL,
  NOTE_REOPEN_IMPLEMENTATION_COMPLETED,
  VALIDATION_FIELD_PLAN_PATH,
  IssueNumber,
  InvalidTransitionError,
  ValidationError,
  WorktreeCreationError
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubGateway,
  GitHubIssueData,
  WorktreeManagerPort,
  CommandExecutorPort
} from '../ports';
import { ResolveSubagentUseCase, SubagentDescriptor } from './resolve-subagent';
import { InferBaseBranchUseCase } from './infer-base-branch';
import { SyncUseCase } from './sync';

export interface StartImplementationParams {
  readonly issue?: number | string | null;
  readonly planPath?: string | null;
  readonly planDir?: string | null;
  readonly userInstructions?: string | null;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  readonly workspaceDir?: string;
  readonly failureDiagnostics?: string | null;
  readonly selfCorrectionPayload?: string | null;
  readonly noWorktree?: boolean;
  readonly baseBranch?: string | null;
  readonly hasMergeConflicts?: boolean;
  readonly mergeBaseBranch?: string | null;
}

export interface StartImplementationResult {
  readonly stateMachine: StateMachine;
  readonly planDir: string | null;
  readonly planPath: string | null;
  readonly planContent: string;
  readonly implementerDef: SubagentDescriptor;
  readonly taskPrompt: string;
  readonly resumed: boolean;
  readonly isSelfCorrection?: boolean;
  readonly failureDiagnostics?: string | null;
}

export class StartImplementationUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator: PlanGeneratorPort;
  private readonly githubGateway?: GitHubGateway;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;
  private readonly worktreeManager?: WorktreeManagerPort;
  private readonly inferBaseBranchUseCase?: InferBaseBranchUseCase;
  private readonly commandExecutor?: CommandExecutorPort;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort,
    githubGateway?: GitHubGateway,
    resolveSubagentUseCase?: ResolveSubagentUseCase,
    worktreeManager?: WorktreeManagerPort,
    inferBaseBranchUseCase?: InferBaseBranchUseCase,
    commandExecutor?: CommandExecutorPort
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.githubGateway = githubGateway;
    this.resolveSubagentUseCase =
      resolveSubagentUseCase ?? new ResolveSubagentUseCase(configRepo, githubGateway);
    this.worktreeManager = worktreeManager;
    this.inferBaseBranchUseCase = inferBaseBranchUseCase;
    this.commandExecutor = commandExecutor;
  }

  public async execute(params: StartImplementationParams = {}): Promise<StartImplementationResult> {
    const workspace = params.workspaceDir || process.cwd();

    // 0. Best-effort remote sync of the base collector branch
    if (this.commandExecutor && this.worktreeManager && this.githubGateway && !params.dryRun && !params.noWorktree) {
      try {
        const syncUseCase = new SyncUseCase(
          this.commandExecutor,
          this.githubGateway,
          this.stateRepo,
          this.worktreeManager
        );
        await syncUseCase.execute({ workspaceDir: workspace });
      } catch (e) {
        console.warn('Auto-sync before implementation failed:', e instanceof Error ? e.message : String(e));
      }
    }

    // 1. Load active pipeline state checkpoint
    const snapshot = await this.stateRepo.load();
    if (!snapshot) {
      throw new InvalidTransitionError(
        STAGE_NONE,
        STAGE_IMPLEMENT,
        MODE_STANDARD,
        'Cannot start implementation: No pipeline state found. Run "agyloop plan" first.'
      );
    }

    const sm = StateMachine.fromSnapshot(snapshot);
    const activeIssue = params.issue || sm.issue;
    if (activeIssue) {
      sm.setIssue(activeIssue);
    }

    // 2. Enforce lifecycle transition rules
    let resumed = false;
    if (sm.currentStage === STAGE_APPROVAL) {
      sm.transition(STAGE_IMPLEMENT, { note: NOTE_DEVELOPER_APPROVED });
    } else if (sm.currentStage === STAGE_PLAN) {
      if (sm.mode === MODE_YOLO) {
        sm.transition(STAGE_IMPLEMENT, { note: NOTE_AUTO_APPROVED_YOLO });
      } else {
        sm.transition(STAGE_APPROVAL, { note: NOTE_IMPLICIT_APPROVAL });
        sm.transition(STAGE_IMPLEMENT, { note: NOTE_DEVELOPER_APPROVED });
      }
    } else if (sm.currentStage === STAGE_IMPLEMENT) {
      resumed = true;
    } else if (sm.currentStage === STAGE_COMPLETED) {
      sm.transition(STAGE_IMPLEMENT, { note: NOTE_REOPEN_IMPLEMENTATION_COMPLETED });
    } else {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_IMPLEMENT,
        sm.mode,
        `Cannot start implementation from stage '${sm.currentStage}'. Pipeline must be in '${STAGE_PLAN}', '${STAGE_APPROVAL}', or '${STAGE_COMPLETED}'.`
      );
    }

    // 3. Worktree Guardrail: auto-provision worktree if needed when entering IMPLEMENT
    const skipWorktree = params.noWorktree === true;
    if (!skipWorktree && this.worktreeManager) {
      if (!sm.worktree) {
        const taskId = activeIssue || 'adhoc';
        let baseBranch = params.baseBranch || sm.baseBranch || undefined;
        let branchPrefix: string | undefined = undefined;

        if (this.inferBaseBranchUseCase) {
          try {
            const inference = await this.inferBaseBranchUseCase.execute({
              issueNumber: activeIssue,
              explicitBaseBranch: params.baseBranch || undefined,
              workspaceDir: workspace
            });
            baseBranch = inference.baseBranch;
            branchPrefix = inference.taskBranchPrefix;
          } catch {
            // Non-fatal fallback
          }
        }

        try {
          const descriptor = await this.worktreeManager.createWorktree({
            taskId,
            baseBranch,
            branchPrefix,
            workspaceDir: workspace
          });
          sm.setWorktree(descriptor);
          if (baseBranch) sm.setBaseBranch(baseBranch);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          throw new WorktreeCreationError(
            'createWorktree',
            `Failed to auto-provision worktree for IMPLEMENT stage: ${errMsg}`
          );
        }
      }

      if (!sm.worktree) {
        throw new WorktreeCreationError(
          'startImplementation',
          'Cannot start implementation without an active worktree descriptor. An isolated worktree must be provisioned (pass --no-worktree to bypass).'
        );
      }
    }

    // 3. Resolve plan directory & plan file via PlanGeneratorPort
    const resolved = this.planGenerator.resolvePlanFile({
      projectRoot: workspace,
      issue: activeIssue,
      planPath: params.planPath,
      planDir: params.planDir || sm.planDir
    });

    if (!resolved && !resumed) {
      throw new ValidationError(
        VALIDATION_FIELD_PLAN_PATH,
        params.planPath || null,
        `Approved plan document could not be found${activeIssue ? ` for issue #${activeIssue}` : ''}. Ensure a plan exists in artifacts/plans/.`
      );
    }

    if (!sm.planDir && resolved?.planDir) {
      sm.setPlanDir(resolved.planDir);
    }

    const planContent = resolved ? this.planGenerator.readPlanDocument(resolved.planPath) : '';

    // 4. Resolve GitHub issue context if available
    let issueData: GitHubIssueData | null = null;
    const issueVo = IssueNumber.tryFrom(activeIssue);
    if (issueVo && this.githubGateway) {
      try {
        issueData = await this.githubGateway.fetchIssue(issueVo.value, { cwd: workspace });
      } catch {
        // Issue fetch failure non-blocking for implementation
      }
    }

    // 5. Resolve implementer subagent definition & model
    const config = this.configRepo.loadConfig({
      customPath: params.configPath,
      cwd: workspace
    });

    const implementerDef = this.resolveSubagentUseCase.execute({
      role: ROLE_IMPLEMENTER,
      customConfig: config,
      workspaceDir: workspace
    });

    // 6. Format token-minimized handoff prompt (with automated self-correction diagnostics if applicable)
    let failureDiagnostics: string | undefined = params.failureDiagnostics || undefined;
    let selfCorrectionPayload: string | undefined = params.selfCorrectionPayload || undefined;
    let isSelfCorrection = Boolean(failureDiagnostics || selfCorrectionPayload);

    if (!isSelfCorrection && sm.history.length > 0) {
      const lastEntry = sm.history[sm.history.length - 1];
      if (lastEntry.metadata) {
        if (typeof lastEntry.metadata.selfCorrectionPayload === 'string') {
          selfCorrectionPayload = lastEntry.metadata.selfCorrectionPayload;
          isSelfCorrection = true;
        }
        if (typeof lastEntry.metadata.failureSnippet === 'string') {
          failureDiagnostics = lastEntry.metadata.failureSnippet;
          isSelfCorrection = true;
        }
      }
    }

    // 6a. Merge conflict pre-flight: fetch remote changes, attempt merge, extract conflict markers
    const effectiveMergeConflicts = params.hasMergeConflicts === true;
    const effectiveMergeBaseBranch = params.mergeBaseBranch || null;

    if (effectiveMergeConflicts && effectiveMergeBaseBranch && this.commandExecutor) {
      const mergeConflictPayload = await this._resolveMergeConflicts(
        workspace,
        effectiveMergeBaseBranch
      );
      if (mergeConflictPayload) {
        // Prepend conflict context to selfCorrectionPayload so the implementer is aware
        selfCorrectionPayload = selfCorrectionPayload
          ? `${mergeConflictPayload}\n\n${selfCorrectionPayload}`
          : mergeConflictPayload;
        isSelfCorrection = true;
      }
    }

    const taskPrompt = this.resolveSubagentUseCase.buildImplementationTaskPrompt({
      planContent,
      planPath: resolved?.planPath,
      issueNumber: activeIssue,
      issueTitle: issueData && !issueData.error ? issueData.title : undefined,
      issueBody: issueData && !issueData.error ? issueData.body : undefined,
      userInstructions: params.userInstructions,
      workspaceDir: sm.worktree?.worktreePath || workspace,
      config,
      failureDiagnostics,
      selfCorrectionPayload
    });

    // 7. Checkpoint state and update summary log
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      if (resolved?.summaryPath) {
        this.planGenerator.updateSummaryLog(resolved.summaryPath, {
          stage: SUMMARY_STAGE_PLAN_REVIEW,
          status: SUMMARY_STATUS_APPROVED
        });
        this.planGenerator.updateSummaryLog(resolved.summaryPath, {
          stage: SUMMARY_STAGE_IMPLEMENTATION,
          subagent: implementerDef.name,
          model: implementerDef.model,
          status: SUMMARY_STATUS_IN_PROGRESS
        });
      }
    }

    return {
      stateMachine: sm,
      planDir: resolved?.planDir ?? null,
      planPath: resolved?.planPath ?? null,
      planContent,
      implementerDef,
      taskPrompt,
      resumed,
      isSelfCorrection,
      failureDiagnostics: failureDiagnostics ?? null
    };
  }

  /**
   * Attempts to fetch and merge the remote base branch into the current worktree.
   * On conflict, collects conflict marker snippets from all conflicting files
   * and returns a structured payload string for the implementer's self-correction context.
   *
   * Returns null when no conflicts are detected or when the executor is unavailable.
   */
  private async _resolveMergeConflicts(
    workspaceDir: string,
    mergeBaseBranch: string
  ): Promise<string | null> {
    if (!this.commandExecutor) {
      return null;
    }

    // Step 1: Fetch remote branch
    const fetchResult = await this.commandExecutor.execute(
      `git fetch origin ${mergeBaseBranch}`,
      { cwd: workspaceDir }
    );

    if (fetchResult.exitCode !== 0) {
      // Fetch failure is non-fatal; surface as a diagnostic note
      return [
        '### Merge Conflict Pre-Flight (Fetch Failed):',
        `Unable to fetch \`origin/${mergeBaseBranch}\`. Verify network access and remote configuration.`,
        '```',
        (fetchResult.stderr || fetchResult.stdout).trim(),
        '```'
      ].join('\n');
    }

    // Step 2: Attempt merge
    const mergeResult = await this.commandExecutor.execute(
      `git merge origin/${mergeBaseBranch}`,
      { cwd: workspaceDir }
    );

    if (mergeResult.exitCode === 0) {
      // Clean merge — no conflict payload needed
      return null;
    }

    // Step 3: Collect conflicting file paths
    const conflictListResult = await this.commandExecutor.execute(
      'git diff --name-only --diff-filter=U',
      { cwd: workspaceDir }
    );

    const conflictingFiles = (conflictListResult.stdout || '')
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);

    const conflictBlocks: string[] = [];

    // Step 4: Extract conflict marker blocks from each conflicting file
    for (const filePath of conflictingFiles) {
      const readResult = await this.commandExecutor.execute(
        `cat ${filePath}`,
        { cwd: workspaceDir }
      );

      if (readResult.exitCode !== 0 || !readResult.stdout) {
        continue;
      }

      const fileContent = readResult.stdout;
      const snippets = StartImplementationUseCase._extractConflictSnippets(fileContent);

      if (snippets.length > 0) {
        conflictBlocks.push(`#### \`${filePath}\`\n\`\`\`\n${snippets.join('\n...\n')}\n\`\`\``);
      }
    }

    const fileList = conflictingFiles.map((f) => `- \`${f}\``).join('\n');
    const lines: string[] = [
      '### Merge Conflict Pre-Flight:',
      `The PR branch has merge conflicts with \`origin/${mergeBaseBranch}\`. The following files require manual conflict resolution before implementation can proceed:`,
      '',
      fileList
    ];

    if (conflictBlocks.length > 0) {
      lines.push('', '#### Conflict Marker Snippets:', '', ...conflictBlocks);
    }

    lines.push(
      '',
      '**Resolution Instructions**: Resolve all conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in the listed files, then stage the resolved files with `git add <file>` and run `git commit` to complete the merge before continuing implementation.'
    );

    return lines.join('\n');
  }

  /**
   * Extracts conflict marker blocks (<<<<<<< ... >>>>>>>) from file content.
   * Returns an array of raw conflict block strings.
   */
  private static _extractConflictSnippets(content: string): string[] {
    const snippets: string[] = [];
    const lines = content.split('\n');
    let inConflict = false;
    let currentBlock: string[] = [];

    for (const line of lines) {
      if (line.startsWith('<<<<<<<')) {
        if (inConflict && currentBlock.length > 0) {
          snippets.push(currentBlock.join('\n'));
        }
        inConflict = true;
        currentBlock = [line];
      } else if (inConflict) {
        currentBlock.push(line);
        if (line.startsWith('>>>>>>>')) {
          snippets.push(currentBlock.join('\n'));
          inConflict = false;
          currentBlock = [];
        }
      }
    }

    if (inConflict && currentBlock.length > 0) {
      snippets.push(currentBlock.join('\n'));
    }

    return snippets;
  }
}
