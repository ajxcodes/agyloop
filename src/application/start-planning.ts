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
  STAGE_COMPLETED,
  MODE_PLAN,
  NOTE_INITIATED_DISCOVERY_RCA,
  NOTE_GENERATING_SPECS,
  NOTE_AWAITING_REVIEW,
  SUMMARY_STAGE_DISCOVERY,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STATUS_IN_PROGRESS,
  SUMMARY_STATUS_COMPLETED,
  SUMMARY_STATUS_PENDING,
  IssueNumber,
  PreFlightHaltError
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
  readonly userFeedback?: string | null;
  readonly previousPlanContent?: string | null;
  readonly skipDiscovery?: boolean;
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
    const isNewIssue =
      params.issue !== undefined &&
      params.issue !== null &&
      snapshot !== null &&
      snapshot.issue !== null &&
      String(params.issue) !== String(snapshot.issue);

    if (snapshot) {
      sm = StateMachine.fromSnapshot(snapshot);
      if (sm.currentStage === STAGE_COMPLETED || isNewIssue) {
        sm.reset(MODE_PLAN, params.issue ?? sm.issue);
      } else {
        sm.setMode(MODE_PLAN);
      }
    } else {
      sm = StateMachine.createInitial({ mode: MODE_PLAN, issue: params.issue });
    }

    const activeIssue = params.issue || sm.issue;
    if (activeIssue && !isNewIssue && sm.issue !== Number(activeIssue)) {
      sm.setIssue(activeIssue);
    }

    // 2. Fetch issue context if issue is active
    let issueData: GitHubIssueData | null = null;
    const issueVo = IssueNumber.tryFrom(activeIssue);
    if (issueVo) {
      issueData = await this.githubGateway.fetchIssue(issueVo.value, { cwd: workspace });
      if (issueData && issueData.state === 'CLOSED') {
        throw new PreFlightHaltError(`Task #${issueVo.value} is already closed.`, 'CLOSED', {
          issueNumber: issueVo.value
        });
      }
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
      if (scaffoldInfo && scaffoldInfo.planDir) {
        sm.setPlanDir(scaffoldInfo.planDir);
      }
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

    // Detect if task is a bug/defect requiring deep discovery RCA
    const bugKeywords = ['bug', 'defect', 'fix', 'rca', 'root-cause', 'regression', 'crash', 'error'];
    const isBugFromParams = params.type === 'discovery';
    const isBugFromLabels = planLabels.some((l) =>
      bugKeywords.some((kw) => String(l).toLowerCase().includes(kw))
    );
    const titleLower = String(planTitle).toLowerCase();
    const isBugFromTitle = bugKeywords.some((kw) =>
      titleLower.includes(`[${kw}]`) || titleLower.includes(`${kw}:`) || titleLower.includes(`${kw}/`)
    );
    const isBugFromState =
      sm.currentStage === STAGE_DISCOVERY || sm.history.some((h) => h.stage === STAGE_DISCOVERY);
    const isBug =
      isBugFromParams ||
      isBugFromLabels ||
      isBugFromTitle ||
      isBugFromState ||
      scaffoldInfo?.type === 'discovery';

    // 5. State Machine Transitions
    if (sm.currentStage === STAGE_APPROVAL && params.userFeedback) {
      // Iterative plan redirection loop: developer requested re-planning
      sm.transition(STAGE_PLAN, {
        note: 'Plan revision requested based on developer feedback',
        userFeedback: params.userFeedback,
        previousPlanContent: params.previousPlanContent
      });
    } else if (sm.currentStage === STAGE_INITIALIZED) {
      if (params.skipDiscovery) {
        sm.transition(STAGE_PLAN, { note: NOTE_GENERATING_SPECS });
        sm.transition(STAGE_APPROVAL, { note: NOTE_AWAITING_REVIEW });
      } else {
        sm.transition(STAGE_DISCOVERY, {
          note: isBug ? NOTE_INITIATED_DISCOVERY_RCA : 'Context discovery and pre-flight analysis completed'
        });
        if (!isBug) {
          sm.transition(STAGE_PLAN, { note: NOTE_GENERATING_SPECS });
          sm.transition(STAGE_APPROVAL, { note: NOTE_AWAITING_REVIEW });
        }
      }
    } else if (sm.currentStage === STAGE_DISCOVERY) {
      sm.transition(STAGE_PLAN, { note: NOTE_GENERATING_SPECS });
      sm.transition(STAGE_APPROVAL, { note: NOTE_AWAITING_REVIEW });
    } else if (sm.currentStage === STAGE_PLAN) {
      sm.transition(STAGE_APPROVAL, { note: NOTE_AWAITING_REVIEW });
    }

    // 6. Checkpoint state and update summary log
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      if (scaffoldInfo && scaffoldInfo.summaryPath) {
        if (sm.currentStage === STAGE_DISCOVERY) {
          this.planGenerator.updateSummaryLog(scaffoldInfo.summaryPath, {
            stage: SUMMARY_STAGE_DISCOVERY,
            subagent: plannerDef.name,
            model: plannerDef.model,
            status: SUMMARY_STATUS_IN_PROGRESS
          });
        } else if (sm.currentStage === STAGE_PLAN) {
          this.planGenerator.updateSummaryLog(scaffoldInfo.summaryPath, {
            stage: SUMMARY_STAGE_PLAN_REVIEW,
            subagent: plannerDef.name,
            model: plannerDef.model,
            status: SUMMARY_STATUS_IN_PROGRESS,
            planRevisionCount: sm.planRevisionCount
          });
        } else {
          if (!params.skipDiscovery) {
            this.planGenerator.updateSummaryLog(scaffoldInfo.summaryPath, {
              stage: SUMMARY_STAGE_DISCOVERY,
              subagent: plannerDef.name,
              model: plannerDef.model,
              status: SUMMARY_STATUS_COMPLETED
            });
          }
          this.planGenerator.updateSummaryLog(scaffoldInfo.summaryPath, {
            stage: SUMMARY_STAGE_PLAN_REVIEW,
            status: SUMMARY_STATUS_PENDING
          });
        }
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
