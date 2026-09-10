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
  MODE_STANDARD,
  MODE_YOLO,
  ROLE_IMPLEMENTER,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STAGE_IMPLEMENTATION,
  SUMMARY_STATUS_APPROVED,
  SUMMARY_STATUS_IN_PROGRESS,
  NOTE_DEVELOPER_APPROVED,
  NOTE_AUTO_APPROVED_YOLO,
  VALIDATION_FIELD_PLAN_PATH,
  IssueNumber,
  InvalidTransitionError,
  ValidationError
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubGateway,
  GitHubIssueData
} from '../ports';
import { ResolveSubagentUseCase, SubagentDescriptor } from './resolve-subagent';

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

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort,
    githubGateway?: GitHubGateway,
    resolveSubagentUseCase?: ResolveSubagentUseCase
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.githubGateway = githubGateway;
    this.resolveSubagentUseCase =
      resolveSubagentUseCase ?? new ResolveSubagentUseCase(configRepo, githubGateway);
  }

  public async execute(params: StartImplementationParams = {}): Promise<StartImplementationResult> {
    const workspace = params.workspaceDir || process.cwd();

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
    } else if (sm.currentStage === STAGE_PLAN && sm.mode === MODE_YOLO) {
      sm.transition(STAGE_IMPLEMENT, { note: NOTE_AUTO_APPROVED_YOLO });
    } else if (sm.currentStage === STAGE_IMPLEMENT) {
      resumed = true;
    } else {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_IMPLEMENT,
        sm.mode,
        `Cannot start implementation from stage '${sm.currentStage}'. Pipeline must be in '${STAGE_APPROVAL}' (or in '${STAGE_PLAN}' with YOLO mode).`
      );
    }

    // 3. Resolve plan directory & plan file via PlanGeneratorPort
    const resolved = this.planGenerator.resolvePlanFile({
      projectRoot: workspace,
      issue: activeIssue,
      planPath: params.planPath,
      planDir: params.planDir
    });

    if (!resolved) {
      throw new ValidationError(
        VALIDATION_FIELD_PLAN_PATH,
        params.planPath || null,
        `Approved plan document could not be found${activeIssue ? ` for issue #${activeIssue}` : ''}. Ensure a plan exists in artifacts/plans/.`
      );
    }

    const planContent = this.planGenerator.readPlanDocument(resolved.planPath);

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

    const taskPrompt = this.resolveSubagentUseCase.buildImplementationTaskPrompt({
      planContent,
      planPath: resolved.planPath,
      issueNumber: activeIssue,
      issueTitle: issueData && !issueData.error ? issueData.title : undefined,
      issueBody: issueData && !issueData.error ? issueData.body : undefined,
      userInstructions: params.userInstructions,
      workspaceDir: workspace,
      config,
      failureDiagnostics,
      selfCorrectionPayload
    });

    // 7. Checkpoint state and update summary log
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      if (resolved.summaryPath) {
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
      planDir: resolved.planDir,
      planPath: resolved.planPath,
      planContent,
      implementerDef,
      taskPrompt,
      resumed,
      isSelfCorrection,
      failureDiagnostics: failureDiagnostics ?? null
    };
  }
}
