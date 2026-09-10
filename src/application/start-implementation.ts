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

import * as fs from 'fs';
import * as path from 'path';
import {
  StateMachine,
  STAGE_NONE,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_PLAN,
  MODE_STANDARD,
  MODE_YOLO,
  ROLE_IMPLEMENTER,
  DEFAULT_SUMMARY_FILENAME,
  CANDIDATE_PLAN_FILENAMES,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STAGE_IMPLEMENTATION,
  SUMMARY_STATUS_APPROVED,
  SUMMARY_STATUS_IN_PROGRESS,
  NOTE_DEVELOPER_APPROVED,
  NOTE_AUTO_APPROVED_YOLO,
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
import { CliGitHubGateway } from '../infrastructure/cli-github-gateway';
import { ResolveSubagentUseCase, SubagentDescriptor } from './resolve-subagent';

export interface StartImplementationParams {
  readonly issue?: number | string | null;
  readonly planPath?: string | null;
  readonly planDir?: string | null;
  readonly userInstructions?: string | null;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  readonly workspaceDir?: string;
}

export interface StartImplementationResult {
  readonly stateMachine: StateMachine;
  readonly planDir: string | null;
  readonly planPath: string | null;
  readonly planContent: string;
  readonly implementerDef: SubagentDescriptor;
  readonly taskPrompt: string;
  readonly resumed: boolean;
}

export class StartImplementationUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator: PlanGeneratorPort;
  private readonly githubGateway: GitHubGateway;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort,
    githubGateway: GitHubGateway = new CliGitHubGateway()
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.githubGateway = githubGateway;
    this.resolveSubagentUseCase = new ResolveSubagentUseCase(configRepo);
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

    // 3. Resolve plan directory & plan file
    let resolvedPlanDir: string | null = null;
    let resolvedPlanPath: string | null = null;

    if (params.planPath) {
      resolvedPlanPath = path.isAbsolute(params.planPath)
        ? params.planPath
        : path.resolve(workspace, params.planPath);
      resolvedPlanDir = path.dirname(resolvedPlanPath);
    } else {
      if (params.planDir) {
        resolvedPlanDir = path.isAbsolute(params.planDir)
          ? params.planDir
          : path.resolve(workspace, params.planDir);
      } else if (activeIssue) {
        resolvedPlanDir = this.planGenerator.findPlanDirectory(workspace, activeIssue);
      }

      if (resolvedPlanDir && fs.existsSync(resolvedPlanDir)) {
        for (const candidate of CANDIDATE_PLAN_FILENAMES) {
          const candidatePath = path.join(resolvedPlanDir, candidate);
          if (fs.existsSync(candidatePath)) {
            resolvedPlanPath = candidatePath;
            break;
          }
        }

        // Fallback: search for any .md file that is not summary log
        if (!resolvedPlanPath) {
          try {
            const files = fs.readdirSync(resolvedPlanDir);
            const mdFile = files.find(
              (f) => f.endsWith('.md') && !f.toLowerCase().includes('summary')
            );
            if (mdFile) {
              resolvedPlanPath = path.join(resolvedPlanDir, mdFile);
            }
          } catch {
            // directory read error
          }
        }
      }
    }

    if (!resolvedPlanPath || !fs.existsSync(resolvedPlanPath)) {
      throw new ValidationError(
        'planPath',
        resolvedPlanPath,
        `Approved plan document could not be found${activeIssue ? ` for issue #${activeIssue}` : ''}. Ensure a plan exists in artifacts/plans/.`
      );
    }

    const planContent = fs.readFileSync(resolvedPlanPath, 'utf8');

    // 4. Resolve GitHub issue context if available
    let issueData: GitHubIssueData | null = null;
    const issueVo = IssueNumber.tryFrom(activeIssue);
    if (issueVo) {
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

    // 6. Format token-minimized handoff prompt
    const taskPrompt = this.resolveSubagentUseCase.buildImplementationTaskPrompt({
      planContent,
      planPath: resolvedPlanPath,
      issueNumber: activeIssue,
      issueTitle: issueData && !issueData.error ? issueData.title : undefined,
      issueBody: issueData && !issueData.error ? issueData.body : undefined,
      userInstructions: params.userInstructions,
      workspaceDir: workspace,
      config
    });

    // 7. Checkpoint state and update summary log
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      if (resolvedPlanDir) {
        const summaryPath = path.join(resolvedPlanDir, DEFAULT_SUMMARY_FILENAME);
        if (fs.existsSync(summaryPath)) {
          this.planGenerator.updateSummaryLog(summaryPath, {
            stage: SUMMARY_STAGE_PLAN_REVIEW,
            status: SUMMARY_STATUS_APPROVED
          });
          this.planGenerator.updateSummaryLog(summaryPath, {
            stage: SUMMARY_STAGE_IMPLEMENTATION,
            subagent: implementerDef.name,
            model: implementerDef.model,
            status: SUMMARY_STATUS_IN_PROGRESS
          });
        }
      }
    }

    return {
      stateMachine: sm,
      planDir: resolvedPlanDir,
      planPath: resolvedPlanPath,
      planContent,
      implementerDef,
      taskPrompt,
      resumed
    };
  }
}
