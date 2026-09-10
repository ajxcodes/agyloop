/**
 * agyloop - StartPlanningUseCase
 *
 * Orchestrates the planning workflow:
 * 1. Fetches issue context from GitHubGateway (if issue specified)
 * 2. Scaffolds plan directory, templates, and execution log
 * 3. Transitions StateMachine: INITIALIZED -> DISCOVERY -> PLAN -> APPROVAL
 * 4. Checkpoints StateMachine state to StateRepository
 * 5. Updates session execution summary log
 */

import {
  StateMachine,
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  MODE_PLAN,
  IssueNumber
} from '../domain';
import {
  StateRepository,
  GitHubGateway,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubIssueData,
  ScaffoldResult
} from '../ports';
import { ResolveSubagentUseCase, SubagentDescriptor } from './resolve-subagent';

export interface StartPlanningParams {
  readonly issue?: number | string | null;
  readonly title?: string | null;
  readonly type?: string | null;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  readonly workspaceDir?: string;
}

export interface StartPlanningResult {
  readonly stateMachine: StateMachine;
  readonly issueData: GitHubIssueData | null;
  readonly scaffoldInfo: ScaffoldResult | null;
  readonly plannerDef: SubagentDescriptor;
  readonly planTitle: string;
  readonly planType: string;
}

export class StartPlanningUseCase {
  private readonly stateRepo: StateRepository;
  private readonly githubGateway: GitHubGateway;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator: PlanGeneratorPort;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;

  constructor(
    stateRepo: StateRepository,
    githubGateway: GitHubGateway,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort
  ) {
    this.stateRepo = stateRepo;
    this.githubGateway = githubGateway;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.resolveSubagentUseCase = new ResolveSubagentUseCase(configRepo);
  }

  public async execute(params: StartPlanningParams = {}): Promise<StartPlanningResult> {
    const workspace = params.workspaceDir || process.cwd();

    // 1. Rehydrate or initialize StateMachine
    const snapshot = await this.stateRepo.load();
    let sm: StateMachine;
    if (snapshot) {
      sm = StateMachine.fromSnapshot(snapshot);
      sm.setMode(MODE_PLAN);
    } else {
      sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: params.issue });
    }

    const activeIssue = params.issue || sm.issue;
    if (activeIssue) {
      sm.setIssue(activeIssue);
    }

    // 2. Fetch issue context if issue is active
    let issueData: GitHubIssueData | null = null;
    const issueVo = IssueNumber.tryFrom(activeIssue);
    if (issueVo) {
      issueData = await this.githubGateway.fetchIssue(issueVo.value, { cwd: workspace });
    }

    const planTitle =
      params.title || (issueData && !issueData.error && issueData.title ? issueData.title : 'Task Plan');
    const planLabels = (issueData && !issueData.error ? issueData.labels : []) || [];
    const planType = params.type || 'auto';

    // 3. Scaffold plan directory
    let scaffoldInfo: ScaffoldResult | null = null;
    if (!params.dryRun) {
      scaffoldInfo = this.planGenerator.scaffoldPlanDirectory({
        projectRoot: workspace,
        issue: activeIssue,
        title: planTitle,
        type: planType,
        labels: planLabels
      });
    }

    // 4. Resolve planner subagent definition
    const config = this.configRepo.loadConfig({
      customPath: params.configPath,
      cwd: workspace
    });
    const plannerDef = this.resolveSubagentUseCase.execute({
      customConfig: config,
      workspaceDir: workspace
    });

    // 5. Advance StateMachine transitions to APPROVAL gate
    if (sm.currentStage === STAGE_INITIALIZED) {
      sm.transition(STAGE_DISCOVERY, { note: 'Initiated planning mode' });
    }
    if (sm.currentStage === STAGE_DISCOVERY) {
      sm.transition(STAGE_PLAN, { note: 'Generating plan specifications' });
    }
    if (sm.currentStage === STAGE_PLAN) {
      sm.transition(STAGE_APPROVAL, { note: 'Awaiting human review' });
    }

    // 6. Checkpoint state
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      if (scaffoldInfo && scaffoldInfo.summaryPath) {
        this.planGenerator.updateSummaryLog(scaffoldInfo.summaryPath, {
          stage: 'Discovery',
          subagent: plannerDef.name,
          model: plannerDef.model,
          status: 'COMPLETED'
        });
        this.planGenerator.updateSummaryLog(scaffoldInfo.summaryPath, {
          stage: 'Plan Review',
          status: 'PENDING'
        });
      }
    }

    return {
      stateMachine: sm,
      issueData,
      scaffoldInfo,
      plannerDef,
      planTitle,
      planType
    };
  }
}
