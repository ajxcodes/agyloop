/**
 * agyloop - RunLifecycleUseCase (Application Layer)
 *
 * Coordinates the full Antigravity development lifecycle orchestration:
 * INITIALIZED -> DISCOVERY -> PLAN -> APPROVAL -> IMPLEMENT -> QUALITY_GATE -> REVIEW -> COMMIT -> COMPLETED
 *
 * Supports operational modes:
 * - standard: Continuous development loop with human approval gates at APPROVAL and COMMIT.
 * - yolo: Unattended fast-path (auto-approves APPROVAL, streams straight into implement -> gates -> review).
 * - plan: Plan-only mode; scaffolds persistent plan in artifacts/plans/ and stops at APPROVAL gate.
 * - implement: Resumes execution directly from approved plan.
 * - gates: Standalone quality gate execution followed by AI PR review on working diff.
 * - commit: Conventional commit drafting and interactive approval gate.
 *
 * Opt-in Automated Commit:
 * - commitAfter: Automatically drafts and executes commit upon green gates and review.
 * - yolo + commitAfter: 100% end-to-end unattended continuous loop.
 *
 * Strict Hexagonal Architecture: Zero direct I/O, zero Node.js built-ins.
 */

import {
  StateMachine,
  IssueNumber,
  StageName,
  ExecutionMode,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_TRIAGE,
  MODE_STANDARD,
  MODE_YOLO,
  MODE_PLAN,
  MODE_IMPLEMENT,
  MODE_GATES,
  MODE_COMMIT,
  GATE_APPROVAL,
  GATE_COMMIT,
  GATE_TRIAGE,
  NOTE_LIFECYCLE_STARTED,
  NOTE_LIFECYCLE_COMPLETED,
  NOTE_PAUSED_APPROVAL_GATE,
  NOTE_PAUSED_COMMIT_GATE,
  NOTE_PAUSED_TRIAGE_GATE,
  NOTE_AUTO_APPROVED_PLAN,
  NOTE_COMMIT_AFTER_EXECUTED,
  NOTE_ALREADY_COMPLETED,
  GateCommandDefinition,
  WorktreeDescriptor
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubGateway,
  CommandExecutorPort,
  BuildDetectorPort,
  StandardsRepository,
  CritiquePort,
  CritiqueInstallerPort,
  ConfirmationPromptPort,
  WorktreeManagerPort
} from '../ports';
import { StartPlanningUseCase, StartPlanningResult } from './start-planning';
import { StartImplementationUseCase, StartImplementationResult } from './start-implementation';
import { RunQualityGateUseCase, QualityGateRunResult } from './run-quality-gate';
import { RunReviewUseCase, RunReviewResult } from './run-review';
import { DraftCommitUseCase, DraftCommitResult } from './draft-commit';
import { ExecuteCommitUseCase, ExecuteCommitResult } from './execute-commit';
import { ResolveSubagentUseCase } from './resolve-subagent';
import { RunPreFlightCheckUseCase } from './run-preflight-check';
import { InferBaseBranchUseCase } from './infer-base-branch';

export interface RunLifecycleParams {
  readonly mode?: ExecutionMode;
  readonly issue?: number | string | null;
  readonly title?: string | null;
  readonly type?: string | null;
  readonly commitAfter?: boolean;
  readonly yes?: boolean;
  readonly staged?: boolean;
  readonly message?: string | null;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  readonly workspaceDir?: string;
  readonly workingDiff?: string | null;
  readonly commands?: readonly string[] | readonly GateCommandDefinition[];
  readonly timeoutSeconds?: number;
  readonly baseRef?: string;
  readonly baseBranch?: string;
  readonly standardsPath?: string | null;
  readonly planPath?: string | null;
  readonly planDir?: string | null;
  readonly userInstructions?: string | null;
  readonly interactiveCommit?: boolean;
  readonly worktree?: boolean;
}

export interface RunLifecycleResult {
  readonly success: boolean;
  readonly mode: ExecutionMode;
  readonly currentStage: StageName;
  readonly stateMachine: StateMachine;
  readonly pausedAtGate?: typeof GATE_APPROVAL | typeof GATE_COMMIT | typeof GATE_TRIAGE | null;
  readonly planResult?: StartPlanningResult;
  readonly implementationResult?: StartImplementationResult;
  readonly qualityGateResult?: QualityGateRunResult;
  readonly reviewResult?: RunReviewResult;
  readonly draftCommitResult?: DraftCommitResult;
  readonly executeCommitResult?: ExecuteCommitResult;
  readonly worktree?: WorktreeDescriptor | null;
  readonly message?: string;
}

export interface RunLifecycleDependencies {
  readonly stateRepo: StateRepository;
  readonly configRepo: ConfigRepository;
  readonly planGenerator: PlanGeneratorPort;
  readonly githubGateway: GitHubGateway;
  readonly commandExecutor: CommandExecutorPort;
  readonly buildDetector?: BuildDetectorPort;
  readonly standardsRepo?: StandardsRepository;
  readonly critique?: CritiquePort;
  readonly aiReviewer?: CritiquePort;
  readonly critiqueInstaller?: CritiqueInstallerPort;
  readonly confirmationPrompt?: ConfirmationPromptPort;
  readonly startPlanningUseCase?: StartPlanningUseCase;
  readonly startImplementationUseCase?: StartImplementationUseCase;
  readonly runQualityGateUseCase?: RunQualityGateUseCase;
  readonly runReviewUseCase?: RunReviewUseCase;
  readonly draftCommitUseCase?: DraftCommitUseCase;
  readonly executeCommitUseCase?: ExecuteCommitUseCase;
  readonly worktreeManager?: WorktreeManagerPort;
  readonly runPreFlightCheckUseCase?: RunPreFlightCheckUseCase;
  readonly inferBaseBranchUseCase?: InferBaseBranchUseCase;
}

export class RunLifecycleUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator: PlanGeneratorPort;
  private readonly githubGateway: GitHubGateway;
  private readonly commandExecutor: CommandExecutorPort;
  private readonly buildDetector?: BuildDetectorPort;
  private readonly standardsRepo?: StandardsRepository;
  private readonly critique?: CritiquePort;
  private readonly confirmationPrompt?: ConfirmationPromptPort;
  private readonly worktreeManager?: WorktreeManagerPort;

  private readonly startPlanningUseCase: StartPlanningUseCase;
  private readonly startImplementationUseCase: StartImplementationUseCase;
  private readonly runQualityGateUseCase: RunQualityGateUseCase;
  private readonly runReviewUseCase: RunReviewUseCase;
  private readonly draftCommitUseCase: DraftCommitUseCase;
  private readonly executeCommitUseCase: ExecuteCommitUseCase;
  private readonly runPreFlightCheckUseCase: RunPreFlightCheckUseCase;
  private readonly inferBaseBranchUseCase?: InferBaseBranchUseCase;

  constructor(deps: RunLifecycleDependencies) {
    this.stateRepo = deps.stateRepo;
    this.configRepo = deps.configRepo;
    this.planGenerator = deps.planGenerator;
    this.githubGateway = deps.githubGateway;
    this.commandExecutor = deps.commandExecutor;
    this.buildDetector = deps.buildDetector;
    this.standardsRepo = deps.standardsRepo;
    this.critique = deps.critique ?? deps.aiReviewer;
    this.confirmationPrompt = deps.confirmationPrompt;
    this.worktreeManager = deps.worktreeManager;

    const resolveSubagentUseCase = new ResolveSubagentUseCase(
      this.configRepo,
      this.githubGateway
    );

    this.startPlanningUseCase =
      deps.startPlanningUseCase ??
      new StartPlanningUseCase(
        this.stateRepo,
        this.githubGateway,
        this.configRepo,
        this.planGenerator
      );

    this.startImplementationUseCase =
      deps.startImplementationUseCase ??
      new StartImplementationUseCase(
        this.stateRepo,
        this.configRepo,
        this.planGenerator,
        this.githubGateway,
        resolveSubagentUseCase,
        this.worktreeManager,
        this.inferBaseBranchUseCase
      );

    this.runQualityGateUseCase =
      deps.runQualityGateUseCase ??
      new RunQualityGateUseCase(
        this.stateRepo,
        this.configRepo,
        this.planGenerator,
        this.commandExecutor,
        this.buildDetector,
        resolveSubagentUseCase
      );

    this.runReviewUseCase =
      deps.runReviewUseCase ??
      new RunReviewUseCase(
        this.stateRepo,
        this.configRepo,
        this.planGenerator,
        this.standardsRepo,
        this.critique,
        this.commandExecutor,
        resolveSubagentUseCase,
        deps.critiqueInstaller,
        this.confirmationPrompt
      );

    this.draftCommitUseCase =
      deps.draftCommitUseCase ??
      new DraftCommitUseCase(
        this.stateRepo,
        this.commandExecutor,
        this.githubGateway,
        this.planGenerator
      );

    this.executeCommitUseCase =
      deps.executeCommitUseCase ??
      new ExecuteCommitUseCase(
        this.stateRepo,
        this.commandExecutor,
        this.planGenerator,
        this.confirmationPrompt,
        this.worktreeManager
      );

    this.runPreFlightCheckUseCase =
      deps.runPreFlightCheckUseCase ??
      new RunPreFlightCheckUseCase(this.githubGateway, this.worktreeManager, this.stateRepo);

    this.inferBaseBranchUseCase =
      deps.inferBaseBranchUseCase ??
      (this.worktreeManager ? new InferBaseBranchUseCase(this.worktreeManager, this.githubGateway, this.stateRepo) : undefined);
  }

  public async execute(params: RunLifecycleParams = {}): Promise<RunLifecycleResult> {
    const workspace = params.workspaceDir || process.cwd();

    // 1. Load active configuration
    const config = this.configRepo.loadConfig({
      customPath: params.configPath,
      cwd: workspace
    });

    const commitAfter = params.commitAfter ?? config.options.commitAfter ?? false;

    // Auto-infer issue context if not explicitly provided
    let effectiveIssue =
      params.issue !== undefined && params.issue !== null && String(params.issue).trim() !== ''
        ? Number(params.issue)
        : null;

    if (!effectiveIssue) {
      let inferred = IssueNumber.inferFromPath(workspace);
      if (!inferred && this.worktreeManager && this.worktreeManager.resolveBaseBranch) {
        try {
          const curBranch = await this.worktreeManager.resolveBaseBranch(workspace);
          inferred = IssueNumber.inferFromBranch(curBranch);
        } catch {
          // Non-fatal
        }
      }
      if (inferred) {
        effectiveIssue = inferred;
      }
    }

    // Run Pre-Flight Task Check (Anti-Duplicate & Resume Mode)
    const activeIssueToCheck = effectiveIssue;
    let preflightResult = undefined;
    if (activeIssueToCheck && !params.dryRun) {
      preflightResult = await this.runPreFlightCheckUseCase.execute({
        issueNumber: activeIssueToCheck,
        workspaceDir: workspace,
        trackerRepo: config.migration?.trackerRepo
      });
    }

    // 2. Load state checkpoint and determine execution mode
    const snapshot = await this.stateRepo.load();
    let sm: StateMachine;
    let activeMode: ExecutionMode = params.mode || MODE_STANDARD;
    const isNewIssue =
      params.issue !== undefined &&
      params.issue !== null &&
      snapshot !== null &&
      snapshot.issue !== null &&
      String(params.issue) !== String(snapshot.issue);

    if (snapshot) {
      sm = StateMachine.fromSnapshot(snapshot);
      if (
        (activeMode === MODE_PLAN && (sm.currentStage === STAGE_COMPLETED || isNewIssue)) ||
        (isNewIssue && (activeMode === MODE_STANDARD || activeMode === MODE_YOLO))
      ) {
        sm.reset(activeMode, params.issue ?? sm.issue);
        if (!params.dryRun) {
          await this.stateRepo.save(sm.toSnapshot());
        }
      } else {
        if (params.mode) {
          activeMode = params.mode;
          sm.setMode(activeMode);
          if (!params.dryRun) {
            await this.stateRepo.save(sm.toSnapshot());
          }
        } else {
          activeMode = sm.mode || MODE_STANDARD;
        }
      }
    } else {
      activeMode = params.mode || MODE_STANDARD;
      sm = StateMachine.createInitial({
        mode: activeMode,
        issue: params.issue
      });
      if (!params.dryRun) {
        await this.stateRepo.save(sm.toSnapshot());
      }
    }

    const finalIssue = params.issue ?? effectiveIssue;
    if (finalIssue && !isNewIssue && sm.issue !== Number(finalIssue)) {
      sm.setIssue(finalIssue);
      if (!params.dryRun) {
        await this.stateRepo.save(sm.toSnapshot());
      }
    }

    // If preflight check detected resume mode with PR review comments, route to STAGE_TRIAGE
    if (
      preflightResult &&
      preflightResult.isResume &&
      ((preflightResult.prReviewComments && preflightResult.prReviewComments.length > 0) || preflightResult.prHasChangesRequested) &&
      sm.currentStage !== STAGE_TRIAGE
    ) {
      if (sm.canTransition(STAGE_TRIAGE)) {
        sm.transition(STAGE_TRIAGE, {
          note: NOTE_PAUSED_TRIAGE_GATE,
          prNumber: preflightResult.resumePrNumber,
          commentsCount: preflightResult.prReviewComments?.length ?? 0
        });
      }
      sm.pauseAtGate(GATE_TRIAGE);
      if (!params.dryRun) {
        await this.stateRepo.save(sm.toSnapshot());
      }
      return {
        success: true,
        mode: activeMode,
        currentStage: sm.currentStage,
        stateMachine: sm,
        pausedAtGate: GATE_TRIAGE,
        message: NOTE_PAUSED_TRIAGE_GATE
      };
    }

    if (sm.currentStage === STAGE_TRIAGE) {
      sm.pauseAtGate(GATE_TRIAGE);
      return {
        success: true,
        mode: activeMode,
        currentStage: sm.currentStage,
        stateMachine: sm,
        pausedAtGate: GATE_TRIAGE,
        message: NOTE_PAUSED_TRIAGE_GATE
      };
    }

    // 3. Dispatch based on operational mode
    switch (activeMode) {
      case MODE_PLAN:
        return this.executePlanMode(sm, params, workspace);

      case MODE_IMPLEMENT:
        return this.executeImplementMode(sm, params, workspace);

      case MODE_GATES:
        return this.executeGatesMode(sm, params, commitAfter, workspace);

      case MODE_COMMIT:
        return this.executeCommitMode(sm, params, workspace);

      case MODE_YOLO:
        return this.executeYoloMode(sm, params, commitAfter, workspace);

      case MODE_STANDARD:
      default:
        return this.executeStandardMode(sm, params, commitAfter, workspace);
    }
  }

  /**
   * Plan-only mode: runs discovery & planning, scaffolds persistent plan, halts at APPROVAL gate.
   */
  private async executePlanMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    workspace: string
  ): Promise<RunLifecycleResult> {
    const planResult = await this.startPlanningUseCase.execute({
      issue: sm.issue,
      title: params.title,
      type: params.type,
      dryRun: params.dryRun,
      configPath: params.configPath,
      workspaceDir: workspace
    });

    return {
      success: true,
      mode: MODE_PLAN,
      currentStage: planResult.stateMachine.currentStage,
      stateMachine: planResult.stateMachine,
      pausedAtGate: GATE_APPROVAL,
      planResult,
      message: NOTE_PAUSED_APPROVAL_GATE
    };
  }

  /**
   * Helper: resolves an isolated git worktree if enabled for the active task.
   */
  private async resolveWorktree(
    sm: StateMachine,
    params: RunLifecycleParams,
    rootWorkspace: string
  ): Promise<WorktreeDescriptor | null> {
    if (params.dryRun || !this.worktreeManager || params.worktree === false) {
      return null;
    }

    const taskId = sm.issue || params.issue;
    if (taskId === null || taskId === undefined) {
      return null;
    }

    try {
      let baseBranch = params.baseRef || params.baseBranch;
      let branchPrefix: string | undefined = undefined;

      if (this.inferBaseBranchUseCase) {
        try {
          const inference = await this.inferBaseBranchUseCase.execute({
            issueNumber: taskId,
            title: params.title,
            explicitBaseBranch: baseBranch,
            workspaceDir: rootWorkspace
          });
          baseBranch = inference.baseBranch;
          branchPrefix = inference.taskBranchPrefix;
        } catch {
          // Fallback if inference fails
        }
      }

      const descriptor = await this.worktreeManager.createWorktree({
        taskId,
        baseBranch,
        branchPrefix,
        title: params.title,
        workspaceDir: rootWorkspace
      });

      sm.setWorktree(descriptor);
      if (baseBranch) {
        sm.setBaseBranch(baseBranch);
      }
      return descriptor;
    } catch {
      return null;
    }
  }

  /**
   * Helper: detaches and removes an isolated worktree upon task completion.
   */
  private async teardownWorktree(
    worktree: WorktreeDescriptor | null | undefined,
    rootWorkspace: string
  ): Promise<void> {
    if (!worktree || !this.worktreeManager) {
      return;
    }

    try {
      await this.worktreeManager.removeWorktree({
        worktreePath: worktree.worktreePath,
        workspaceDir: rootWorkspace,
        force: true,
        prune: true
      });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Implement mode: resumes execution directly from approved plan specification.
   */
  private async executeImplementMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    workspace: string
  ): Promise<RunLifecycleResult> {
    const worktree = await this.resolveWorktree(sm, params, workspace);
    const activeWorkspace = worktree ? worktree.worktreePath : workspace;

    const implResult = await this.startImplementationUseCase.execute({
      issue: sm.issue,
      planPath: params.planPath,
      planDir: params.planDir,
      userInstructions: params.userInstructions,
      configPath: params.configPath,
      dryRun: params.dryRun,
      workspaceDir: activeWorkspace
    });

    return {
      success: true,
      mode: MODE_IMPLEMENT,
      currentStage: implResult.stateMachine.currentStage,
      stateMachine: implResult.stateMachine,
      implementationResult: implResult,
      worktree,
      message: worktree
        ? `Implementation isolated in worktree: ${worktree.worktreePath}`
        : 'Implementation ready for code modifications.'
    };
  }

  /**
   * Standalone Gates mode: runs quality gates followed by AI PR review on working diff.
   * If commitAfter is opted in, automatically drafts and executes conventional commit upon passing.
   */
  private async executeGatesMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    commitAfter: boolean,
    workspace: string
  ): Promise<RunLifecycleResult> {
    const worktree = await this.resolveWorktree(sm, params, workspace);
    const activeWorkspace = worktree ? worktree.worktreePath : workspace;

    // If starting from an earlier stage, advance through valid transitions to IMPLEMENT
    if (sm.currentStage === STAGE_INITIALIZED) {
      sm.transition(STAGE_DISCOVERY, { note: 'Direct gates mode initialization' });
    }
    if (sm.currentStage === STAGE_DISCOVERY) {
      sm.transition(STAGE_PLAN, { note: 'Direct gates mode planning pass' });
    }
    if (sm.currentStage === STAGE_PLAN) {
      sm.setMode(MODE_YOLO);
      sm.transition(STAGE_IMPLEMENT, { note: 'Direct gates mode implementation stage' });
      sm.setMode(MODE_GATES);
    } else if (sm.currentStage === STAGE_APPROVAL) {
      sm.transition(STAGE_IMPLEMENT, { note: 'Direct gates mode execution' });
    }

    if (params.dryRun) {
      return {
        success: true,
        mode: MODE_GATES,
        currentStage: commitAfter ? STAGE_COMPLETED : STAGE_COMMIT,
        stateMachine: sm,
        worktree,
        message: `Simulated quality gates and AI PR review${commitAfter ? ' with --commit-after' : ''}.`
      };
    }

    await this.stateRepo.save(sm.toSnapshot());

    // 1. Run Quality Gate
    const qgResult = await this.runQualityGateUseCase.execute({
      issue: sm.issue,
      planPath: params.planPath,
      planDir: params.planDir,
      commands: params.commands,
      timeoutSeconds: params.timeoutSeconds,
      dryRun: params.dryRun,
      configPath: params.configPath,
      workspaceDir: activeWorkspace
    });

    sm = qgResult.stateMachine;

    if (!qgResult.passed) {
      return {
        success: false,
        mode: MODE_GATES,
        currentStage: sm.currentStage,
        stateMachine: sm,
        qualityGateResult: qgResult,
        worktree,
        message: 'Quality gates failed. Pipeline reverted to IMPLEMENT.'
      };
    }

    // 2. Run AI PR Review
    const reviewResult = await this.runReviewUseCase.execute({
      issue: sm.issue,
      planPath: params.planPath,
      planDir: params.planDir,
      standardsPath: params.standardsPath,
      userInstructions: params.userInstructions,
      workingDiff: params.workingDiff,
      staged: params.staged,
      baseRef: params.baseRef,
      dryRun: params.dryRun,
      configPath: params.configPath,
      workspaceDir: activeWorkspace
    });

    sm = reviewResult.stateMachine;

    if (!reviewResult.passed) {
      return {
        success: false,
        mode: MODE_GATES,
        currentStage: sm.currentStage,
        stateMachine: sm,
        qualityGateResult: qgResult,
        reviewResult,
        worktree,
        message: 'AI review requested changes. Pipeline reverted to IMPLEMENT.'
      };
    }

    // 3. Both passed -> state is at COMMIT
    if (commitAfter) {
      const draftResult = await this.draftCommitUseCase.execute({
        issue: sm.issue,
        staged: params.staged,
        userMessage: params.message,
        workingDiff: params.workingDiff,
        baseRef: params.baseRef,
        workspaceDir: activeWorkspace
      });

      const execResult = await this.executeCommitUseCase.execute({
        commitMessage: draftResult.commitMessage,
        confirmed: true,
        bypassConfirmation: true,
        staged: params.staged,
        dryRun: params.dryRun,
        issue: sm.issue,
        workspaceDir: activeWorkspace,
        rootWorkspaceDir: workspace
      });

      if (execResult.success) {
        await this.teardownWorktree(worktree, workspace);
      }

      return {
        success: execResult.success,
        mode: MODE_GATES,
        currentStage: execResult.currentStage as StageName,
        stateMachine: execResult.stateMachine,
        qualityGateResult: qgResult,
        reviewResult,
        draftCommitResult: draftResult,
        executeCommitResult: execResult,
        worktree: execResult.success ? null : worktree,
        message: NOTE_COMMIT_AFTER_EXECUTED
      };
    }

    return {
      success: true,
      mode: MODE_GATES,
      currentStage: sm.currentStage,
      stateMachine: sm,
      qualityGateResult: qgResult,
      reviewResult,
      worktree,
      message: 'Quality gates and AI review passed. Pipeline ready at COMMIT gate.'
    };
  }

  /**
   * Commit mode: drafts Conventional Commit and executes confirmation gate.
   */
  private async executeCommitMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    workspace: string
  ): Promise<RunLifecycleResult> {
    const worktree = await this.resolveWorktree(sm, params, workspace);
    const activeWorkspace = worktree ? worktree.worktreePath : workspace;

    const draftResult = await this.draftCommitUseCase.execute({
      issue: sm.issue,
      staged: params.staged,
      userMessage: params.message,
      workingDiff: params.workingDiff,
      baseRef: params.baseRef,
      workspaceDir: activeWorkspace
    });

    const bypass = params.yes ?? false;
    const execResult = await this.executeCommitUseCase.execute({
      commitMessage: draftResult.commitMessage,
      confirmed: bypass,
      bypassConfirmation: bypass,
      staged: params.staged,
      dryRun: params.dryRun,
      issue: sm.issue,
      workspaceDir: activeWorkspace,
      rootWorkspaceDir: workspace
    });

    if (execResult.success) {
      await this.teardownWorktree(worktree, workspace);
    }

    return {
      success: execResult.success,
      mode: MODE_COMMIT,
      currentStage: execResult.currentStage as StageName,
      stateMachine: execResult.stateMachine,
      draftCommitResult: draftResult,
      executeCommitResult: execResult,
      worktree: execResult.success ? null : worktree,
      message: execResult.success ? NOTE_LIFECYCLE_COMPLETED : 'Commit not executed.'
    };
  }

  /**
   * YOLO mode: unattended fast-path.
   * Auto-approves APPROVAL gate, streams into implementation, quality gates, and AI review.
   * If commitAfter is set, completes 100% end-to-end unattended to COMPLETED.
   */
  private async executeYoloMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    commitAfter: boolean,
    workspace: string
  ): Promise<RunLifecycleResult> {
    sm.setMode(MODE_YOLO);
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());
    }

    let planResult: StartPlanningResult | undefined;
    let implResult: StartImplementationResult | undefined;

    // In dry-run mode, simulate planning and pipeline progression without modifying disk
    if (params.dryRun) {
      if (sm.currentStage === STAGE_INITIALIZED || sm.currentStage === STAGE_DISCOVERY) {
        planResult = await this.startPlanningUseCase.execute({
          issue: sm.issue,
          title: params.title,
          type: params.type,
          dryRun: true,
          configPath: params.configPath,
          workspaceDir: workspace
        });
      }
      return {
        success: true,
        mode: MODE_YOLO,
        currentStage: commitAfter ? STAGE_COMPLETED : STAGE_COMMIT,
        stateMachine: sm,
        pausedAtGate: commitAfter ? null : GATE_COMMIT,
        planResult,
        message: `Simulated unattended YOLO execution through ${commitAfter ? STAGE_COMPLETED : STAGE_COMMIT}.`
      };
    }

    // A. Planning & Auto-Approval
    if (sm.currentStage === STAGE_INITIALIZED || sm.currentStage === STAGE_DISCOVERY) {
      planResult = await this.startPlanningUseCase.execute({
        issue: sm.issue,
        title: params.title,
        type: params.type,
        dryRun: params.dryRun,
        configPath: params.configPath,
        workspaceDir: workspace
      });

      sm = planResult.stateMachine;
      sm.setMode(MODE_YOLO);
      if (!params.dryRun) {
        await this.stateRepo.save(sm.toSnapshot());
      }
    }

    // Resolve isolated worktree for implementation and verification
    const worktree = await this.resolveWorktree(sm, params, workspace);
    const activeWorkspace = worktree ? worktree.worktreePath : workspace;

    if (sm.currentStage === STAGE_PLAN || sm.currentStage === STAGE_APPROVAL) {
      implResult = await this.startImplementationUseCase.execute({
        issue: sm.issue,
        planPath: params.planPath,
        planDir: params.planDir,
        configPath: params.configPath,
        dryRun: params.dryRun,
        workspaceDir: activeWorkspace
      });

      sm = implResult.stateMachine;
    }

    // B. Quality Gates
    const qgResult = await this.runQualityGateUseCase.execute({
      issue: sm.issue,
      planPath: params.planPath,
      planDir: params.planDir,
      commands: params.commands,
      timeoutSeconds: params.timeoutSeconds,
      dryRun: params.dryRun,
      configPath: params.configPath,
      workspaceDir: activeWorkspace
    });

    sm = qgResult.stateMachine;

    if (!qgResult.passed) {
      return {
        success: false,
        mode: MODE_YOLO,
        currentStage: sm.currentStage,
        stateMachine: sm,
        planResult,
        implementationResult: implResult,
        qualityGateResult: qgResult,
        worktree,
        message: 'Quality gates failed in YOLO mode. Reverted to IMPLEMENT.'
      };
    }

    // C. AI PR Review
    const reviewResult = await this.runReviewUseCase.execute({
      issue: sm.issue,
      planPath: params.planPath,
      planDir: params.planDir,
      standardsPath: params.standardsPath,
      userInstructions: params.userInstructions,
      workingDiff: params.workingDiff,
      staged: params.staged,
      baseRef: params.baseRef,
      dryRun: params.dryRun,
      configPath: params.configPath,
      workspaceDir: activeWorkspace
    });

    sm = reviewResult.stateMachine;

    if (!reviewResult.passed) {
      return {
        success: false,
        mode: MODE_YOLO,
        currentStage: sm.currentStage,
        stateMachine: sm,
        planResult,
        implementationResult: implResult,
        qualityGateResult: qgResult,
        reviewResult,
        worktree,
        message: 'AI review requested changes in YOLO mode. Reverted to IMPLEMENT.'
      };
    }

    // D. Commit Gate
    if (commitAfter) {
      const draftResult = await this.draftCommitUseCase.execute({
        issue: sm.issue,
        staged: params.staged,
        userMessage: params.message,
        workingDiff: params.workingDiff,
        baseRef: params.baseRef,
        workspaceDir: activeWorkspace
      });

      const execResult = await this.executeCommitUseCase.execute({
        commitMessage: draftResult.commitMessage,
        confirmed: true,
        bypassConfirmation: true,
        staged: params.staged,
        dryRun: params.dryRun,
        issue: sm.issue,
        workspaceDir: activeWorkspace,
        rootWorkspaceDir: workspace
      });

      if (execResult.success) {
        await this.teardownWorktree(worktree, workspace);
      }

      return {
        success: execResult.success,
        mode: MODE_YOLO,
        currentStage: execResult.currentStage as StageName,
        stateMachine: execResult.stateMachine,
        planResult,
        implementationResult: implResult,
        qualityGateResult: qgResult,
        reviewResult,
        draftCommitResult: draftResult,
        executeCommitResult: execResult,
        worktree: execResult.success ? null : worktree,
        message: 'YOLO pipeline completed 100% end-to-end with automated commit.'
      };
    }

    return {
      success: true,
      mode: MODE_YOLO,
      currentStage: sm.currentStage,
      stateMachine: sm,
      pausedAtGate: GATE_COMMIT,
      planResult,
      implementationResult: implResult,
      qualityGateResult: qgResult,
      reviewResult,
      worktree,
      message: 'YOLO pipeline passed gates and review. Paused at COMMIT gate.'
    };
  }

  /**
   * Standard mode: continuous development loop with human approval gates at APPROVAL and COMMIT.
   */
  private async executeStandardMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    commitAfter: boolean,
    workspace: string
  ): Promise<RunLifecycleResult> {
    // 1. If at INITIALIZED or DISCOVERY: run planning and halt at APPROVAL gate
    if (sm.currentStage === STAGE_INITIALIZED || sm.currentStage === STAGE_DISCOVERY) {
      const planResult = await this.startPlanningUseCase.execute({
        issue: sm.issue,
        title: params.title,
        type: params.type,
        dryRun: params.dryRun,
        configPath: params.configPath,
        workspaceDir: workspace
      });

      return {
        success: true,
        mode: MODE_STANDARD,
        currentStage: planResult.stateMachine.currentStage,
        stateMachine: planResult.stateMachine,
        pausedAtGate: GATE_APPROVAL,
        planResult,
        message: NOTE_PAUSED_APPROVAL_GATE
      };
    }

    // Resolve isolated worktree for implementation, verification, and commit
    const worktree = await this.resolveWorktree(sm, params, workspace);
    const activeWorkspace = worktree ? worktree.worktreePath : workspace;

    // 2. If at APPROVAL: human review has occurred, start implementation
    let implResult: StartImplementationResult | undefined;
    if (sm.currentStage === STAGE_APPROVAL) {
      implResult = await this.startImplementationUseCase.execute({
        issue: sm.issue,
        planPath: params.planPath,
        planDir: params.planDir,
        userInstructions: params.userInstructions,
        configPath: params.configPath,
        dryRun: params.dryRun,
        workspaceDir: activeWorkspace
      });

      sm = implResult.stateMachine;
    }

    // 3. If at IMPLEMENT: run quality gates
    let qgResult: QualityGateRunResult | undefined;
    if (sm.currentStage === STAGE_IMPLEMENT) {
      qgResult = await this.runQualityGateUseCase.execute({
        issue: sm.issue,
        planPath: params.planPath,
        planDir: params.planDir,
        commands: params.commands,
        timeoutSeconds: params.timeoutSeconds,
        dryRun: params.dryRun,
        configPath: params.configPath,
        workspaceDir: activeWorkspace
      });

      sm = qgResult.stateMachine;

      if (!qgResult.passed) {
        return {
          success: false,
          mode: MODE_STANDARD,
          currentStage: sm.currentStage,
          stateMachine: sm,
          implementationResult: implResult,
          qualityGateResult: qgResult,
          worktree,
          message: 'Quality gates failed. Pipeline reverted to IMPLEMENT.'
        };
      }
    }

    // 4. If at REVIEW (or just advanced from gates): run AI PR review
    let reviewResult: RunReviewResult | undefined;
    if (sm.currentStage === STAGE_QUALITY_GATE || sm.currentStage === STAGE_REVIEW) {
      reviewResult = await this.runReviewUseCase.execute({
        issue: sm.issue,
        planPath: params.planPath,
        planDir: params.planDir,
        standardsPath: params.standardsPath,
        userInstructions: params.userInstructions,
        workingDiff: params.workingDiff,
        staged: params.staged,
        baseRef: params.baseRef,
        dryRun: params.dryRun,
        configPath: params.configPath,
        workspaceDir: activeWorkspace
      });

      sm = reviewResult.stateMachine;

      if (!reviewResult.passed) {
        return {
          success: false,
          mode: MODE_STANDARD,
          currentStage: sm.currentStage,
          stateMachine: sm,
          implementationResult: implResult,
          qualityGateResult: qgResult,
          reviewResult,
          worktree,
          message: 'AI review requested changes. Pipeline reverted to IMPLEMENT.'
        };
      }
    }

    // 5. If at COMMIT
    if (sm.currentStage === STAGE_COMMIT) {
      const draftResult = await this.draftCommitUseCase.execute({
        issue: sm.issue,
        staged: params.staged,
        userMessage: params.message,
        workingDiff: params.workingDiff,
        baseRef: params.baseRef,
        workspaceDir: activeWorkspace
      });

      if (commitAfter || params.yes) {
        const execResult = await this.executeCommitUseCase.execute({
          commitMessage: draftResult.commitMessage,
          confirmed: true,
          bypassConfirmation: true,
          staged: params.staged,
          dryRun: params.dryRun,
          issue: sm.issue,
          workspaceDir: activeWorkspace,
          rootWorkspaceDir: workspace
        });

        if (execResult.success) {
          await this.teardownWorktree(worktree, workspace);
        }

        return {
          success: execResult.success,
          mode: MODE_STANDARD,
          currentStage: execResult.currentStage as StageName,
          stateMachine: execResult.stateMachine,
          implementationResult: implResult,
          qualityGateResult: qgResult,
          reviewResult,
          draftCommitResult: draftResult,
          executeCommitResult: execResult,
          worktree: execResult.success ? null : worktree,
          message: NOTE_LIFECYCLE_COMPLETED
        };
      }

      if (params.interactiveCommit && this.confirmationPrompt) {
        const execResult = await this.executeCommitUseCase.execute({
          commitMessage: draftResult.commitMessage,
          bypassConfirmation: false,
          staged: params.staged,
          dryRun: params.dryRun,
          issue: sm.issue,
          workspaceDir: activeWorkspace,
          rootWorkspaceDir: workspace
        });

        if (execResult.success) {
          await this.teardownWorktree(worktree, workspace);
        }

        return {
          success: execResult.success,
          mode: MODE_STANDARD,
          currentStage: execResult.currentStage as StageName,
          stateMachine: execResult.stateMachine,
          implementationResult: implResult,
          qualityGateResult: qgResult,
          reviewResult,
          draftCommitResult: draftResult,
          executeCommitResult: execResult,
          worktree: execResult.success ? null : worktree,
          message: execResult.success ? NOTE_LIFECYCLE_COMPLETED : NOTE_PAUSED_COMMIT_GATE
        };
      }

      return {
        success: true,
        mode: MODE_STANDARD,
        currentStage: STAGE_COMMIT,
        stateMachine: sm,
        pausedAtGate: GATE_COMMIT,
        implementationResult: implResult,
        qualityGateResult: qgResult,
        reviewResult,
        draftCommitResult: draftResult,
        worktree,
        message: NOTE_PAUSED_COMMIT_GATE
      };
    }

    if (sm.currentStage === STAGE_COMPLETED) {
      return {
        success: true,
        mode: MODE_STANDARD,
        currentStage: STAGE_COMPLETED,
        stateMachine: sm,
        worktree: null,
        message: NOTE_ALREADY_COMPLETED
      };
    }

    return {
      success: true,
      mode: MODE_STANDARD,
      currentStage: sm.currentStage,
      stateMachine: sm,
      implementationResult: implResult,
      qualityGateResult: qgResult,
      reviewResult
    };
  }
}
