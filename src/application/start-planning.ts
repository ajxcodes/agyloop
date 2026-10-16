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
  ExecutionMode,
  NOTE_INITIATED_DISCOVERY_RCA,
  NOTE_GENERATING_SPECS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  NOTE_AWAITING_REVIEW,
  SUMMARY_STAGE_DISCOVERY,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STATUS_IN_PROGRESS,
  SUMMARY_STATUS_COMPLETED,
  SUMMARY_STATUS_PENDING,
  IssueNumber,
  PreFlightHaltError,
  DiscoveryReport
} from '../domain';
import {
  StateRepository,
  GitHubGateway,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubIssueData,
  ScaffoldResult,
  CommandExecutorPort,
  WorktreeManagerPort
} from '../ports';
import { ResolveSubagentUseCase, SubagentDescriptor } from './resolve-subagent';
import { SyncUseCase } from './sync';
import { DiscoveryReentryDecision, resolveDiscoveryReentry } from './lifecycle-reentry-policy';

export interface StartPlanningParams {
  readonly mode?: ExecutionMode;
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
  /**
   * Set only when this invocation was a re-entry into a checkpoint already
   * resting at DISCOVERY (issue #237). Undefined on every other path, so
   * callers can distinguish "first-run park" from "re-entry park" without
   * re-inferring it from the stage they observe.
   */
  readonly discoveryReentry?: DiscoveryReentryDecision;
}

export class StartPlanningUseCase {
  private readonly stateRepo: StateRepository;
  private readonly githubGateway: GitHubGateway;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator: PlanGeneratorPort;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;
  private readonly commandExecutor?: CommandExecutorPort;
  private readonly worktreeManager?: WorktreeManagerPort;

  constructor(
    stateRepo: StateRepository,
    githubGateway: GitHubGateway,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort,
    commandExecutor?: CommandExecutorPort,
    worktreeManager?: WorktreeManagerPort
  ) {
    this.stateRepo = stateRepo;
    this.githubGateway = githubGateway;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.commandExecutor = commandExecutor;
    this.worktreeManager = worktreeManager;
    this.resolveSubagentUseCase = new ResolveSubagentUseCase(configRepo);
  }

  public async execute(params: StartPlanningParams = {}): Promise<StartPlanningResult> {
    const workspace = params.workspaceDir || process.cwd();

    // 0. Best-effort remote sync of the base collector branch
    if (this.commandExecutor && this.worktreeManager && !params.dryRun) {
      try {
        const syncUseCase = new SyncUseCase(
          this.commandExecutor,
          this.githubGateway,
          this.stateRepo,
          this.worktreeManager
        );
        await syncUseCase.execute({ workspaceDir: workspace });
      } catch (e) {
        console.warn('Auto-sync before planning failed:', e instanceof Error ? e.message : String(e));
      }
    }

    // 1. Rehydrate or initialize StateMachine
    const snapshot = await this.stateRepo.load();
    let sm: StateMachine;
    const isNewIssue =
      params.issue !== undefined &&
      params.issue !== null &&
      snapshot !== null &&
      snapshot.issue !== null &&
      String(params.issue) !== String(snapshot.issue);

    const targetMode = params.mode ?? MODE_PLAN;

    if (snapshot) {
      sm = StateMachine.fromSnapshot(snapshot);
      if (sm.currentStage === STAGE_COMPLETED || isNewIssue) {
        sm.reset(targetMode, params.issue ?? sm.issue);
      } else {
        sm.setMode(targetMode);
      }
    } else {
      sm = StateMachine.createInitial({ mode: targetMode, issue: params.issue });
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
      if (issueData?.milestone?.title) {
        sm.setMilestoneTitle(issueData.milestone.title);
      }
    }

    const planTitle =
      params.title || (issueData && !issueData.error && issueData.title ? issueData.title : 'Task Plan');
    const planLabels = (issueData && !issueData.error ? issueData.labels : []) || [];
    const planType = params.type || 'auto';

    // 3. Scaffold plan directory
    let scaffoldInfo: ScaffoldResult | null = null;
    // Captured BEFORE the scaffold can repoint `sm.planDir`, because after the
    // repoint the original value is unrecoverable: this is the plan directory
    // the checkpoint itself tracked, which is the only record of where the
    // discovery report for THIS run actually lives (issue #237, BLOCKER 2).
    const checkpointPlanDir = sm.planDir;
    if (!params.dryRun) {
      scaffoldInfo = this.planGenerator.scaffoldPlanDirectory({
        projectRoot: workspace,
        issue: activeIssue,
        title: planTitle,
        type: planType,
        labels: planLabels
      });
      // Only adopt the fresh scaffold when the checkpoint has no plan directory
      // of its own.
      //
      // Why the gate matters: `scaffoldPlanDirectory` re-derives the folder name
      // by slugifying the issue title, and a natural re-entry
      // (`codeloop yolo --issue 237`, no `--title`) re-derives that slug from the
      // issue text — which need not equal the slug the original run used.
      // Repointing unconditionally then stranded the real directory (a populated
      // `237-bug-probe-crash` orphaned in favour of a brand-new empty
      // `237-task-plan`), and because `hasPopulatedDiscoveryReport` read
      // `sm.planDir` it was scoped to the EMPTY scaffold — so the operator was
      // told their populated report "is still an unpopulated scaffold". Failing
      // closed is right; failing closed at the wrong directory is not.
      if (!sm.planDir && scaffoldInfo && scaffoldInfo.planDir) {
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
    // Only set when this invocation re-enters a checkpoint already resting at
    // DISCOVERY (issue #237); undefined on every other path.
    let discoveryReentry: DiscoveryReentryDecision | undefined;
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
      } else {
        sm.transition(STAGE_DISCOVERY, {
          note: isBug ? NOTE_INITIATED_DISCOVERY_RCA : 'Context discovery and pre-flight analysis completed'
        });
        if (!isBug || targetMode === MODE_PLAN) {
          sm.transition(STAGE_PLAN, { note: NOTE_GENERATING_SPECS });
        }
      }
    } else if (sm.currentStage === STAGE_DISCOVERY) {
      // One rule, one chokepoint: the RCA gate is no longer implied by "the
      // stage is DISCOVERY". It requires either content evidence that a
      // discovery report was populated, or the operator's explicit
      // --skip-discovery opt-in. Without one of those the checkpoint stays
      // parked here and the summary-log leg below records
      // Discovery / IN PROGRESS — the caller's park leg then returns a
      // checkpointed, actionable message instead of streaming an unattended run
      // out of a pristine scaffold.
      const decision = resolveDiscoveryReentry({
        currentStage: sm.currentStage,
        discoveryReportPresent: this.hasPopulatedDiscoveryReport(
          workspace,
          sm,
          scaffoldInfo,
          checkpointPlanDir
        ),
        skipDiscovery: params.skipDiscovery === true
      });
      discoveryReentry = decision;
      if (decision === 'ADVANCE_TO_PLAN') {
        sm.transition(STAGE_PLAN, {
          note: NOTE_GENERATING_SPECS,
          // Auditable trail: a bypassed RCA gate is recorded in history metadata.
          skipDiscovery: params.skipDiscovery === true
        });
      }
      // PARK_AT_DISCOVERY: intentionally NO transition is issued.
    }

    // 6. Checkpoint state and update summary log
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      const summaryPath = this.resolveSummaryPath(workspace, scaffoldInfo, checkpointPlanDir);
      if (summaryPath) {
        if (sm.currentStage === STAGE_DISCOVERY) {
          this.planGenerator.updateSummaryLog(summaryPath, {
            stage: SUMMARY_STAGE_DISCOVERY,
            subagent: plannerDef.name,
            model: plannerDef.model,
            status: SUMMARY_STATUS_IN_PROGRESS
          });
        } else if (sm.currentStage === STAGE_PLAN) {
          if (!params.skipDiscovery) {
            this.planGenerator.updateSummaryLog(summaryPath, {
              stage: SUMMARY_STAGE_DISCOVERY,
              subagent: plannerDef.name,
              model: plannerDef.model,
              status: SUMMARY_STATUS_COMPLETED
            });
          }
          this.planGenerator.updateSummaryLog(summaryPath, {
            stage: SUMMARY_STAGE_PLAN_REVIEW,
            subagent: plannerDef.name,
            model: plannerDef.model,
            status: SUMMARY_STATUS_IN_PROGRESS,
            planRevisionCount: sm.planRevisionCount
          });
        } else {
          if (!params.skipDiscovery) {
            this.planGenerator.updateSummaryLog(summaryPath, {
              stage: SUMMARY_STAGE_DISCOVERY,
              subagent: plannerDef.name,
              model: plannerDef.model,
              status: SUMMARY_STATUS_COMPLETED
            });
          }
          this.planGenerator.updateSummaryLog(summaryPath, {
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
      planType,
      discoveryReentry
    };
  }

  /**
   * Content-based evidence that an RCA report exists for this checkpoint
   * (issue #237).
   *
   * Existence is not evidence: the generator always writes the plan file when it
   * scaffolds a fresh directory, so "a discovery file exists" is true for a
   * pristine scaffold. Only the CONTENT distinguishes "an untouched template"
   * from "an RCA ran".
   *
   * Reached exclusively through the injected `PlanGeneratorPort` — never `fs` —
   * so the application layer stays I/O-free. Fails CLOSED on every error: a
   * read failure must never open the RCA gate.
   *
   * `checkpointPlanDir` is the directory the checkpoint tracked before this run
   * scaffolded anything. It is passed separately from `sm` because the scaffold
   * may have repointed `sm.planDir`, and after that the original value is
   * unrecoverable — see BLOCKER 2 below.
   */
  private hasPopulatedDiscoveryReport(
    workspace: string,
    sm: StateMachine,
    scaffoldInfo: ScaffoldResult | null,
    checkpointPlanDir: string | null
  ): boolean {
    try {
      // Which ROOT to read is subtler than it looks, and is why this tries two
      // rather than trusting one.
      //
      // `scaffoldPlanDirectory` re-derives the folder slug from the issue title,
      // and a natural re-entry (no `--title`) re-derives it from the issue text —
      // so the freshly scaffolded directory is frequently NOT the directory this
      // checkpoint's discovery report lives in. Reading only it scoped the whole
      // check to an empty scaffold, and the operator was told their populated
      // report "is still an unpopulated scaffold" (BLOCKER 2). So the
      // checkpoint's own directory is tried FIRST, and EITHER root releases the
      // park: the evidence is about whether an RCA ran, not about which directory
      // it happens to be filed under.
      const scaffoldPlanDir = scaffoldInfo ? scaffoldInfo.planDir : null;
      const candidateDirs = [checkpointPlanDir, scaffoldPlanDir].filter(
        (dir): dir is string => typeof dir === 'string' && dir.length > 0
      );

      const candidates: string[] = [];
      // The scaffold's own discovery report is read before the port's
      // resolution: `resolvePlanFile({ stage: DISCOVERY })` selects a
      // DISCOVERY-first candidate list, but that list contains the
      // `implementation_plan.md` alias — and `scaffoldPlanDirectory` writes BOTH
      // `[Discovery] - <title>.md` and an `implementation_plan.md` mirror into
      // the same directory. On a real bug task the resolver therefore hands back
      // the pristine implementation mirror, never the RCA. So the scaffold's own
      // plan path — the artifact the discovery subagent actually fills in — is
      // read first, and the port's resolution is consulted as the second
      // candidate (it is all we have on a dry run, where no scaffold is
      // produced).
      if (scaffoldInfo && scaffoldInfo.planPath) {
        candidates.push(scaffoldInfo.planPath);
      }
      for (const planDir of candidateDirs) {
        const resolved = this.planGenerator.resolvePlanFile({
          projectRoot: workspace,
          issue: sm.issue,
          planDir,
          // Selects the DISCOVERY-first candidate list inside the generator.
          stage: STAGE_DISCOVERY
        });
        if (resolved && resolved.planPath) {
          candidates.push(resolved.planPath);
        }
      }

      // Every candidate lives inside one of this task's own plan directories, so
      // a populated report in any of them is the same content evidence.
      for (const candidate of new Set(candidates)) {
        const markdown = this.planGenerator.readPlanDocument(candidate);
        if (DiscoveryReport.fromMarkdown(markdown).isPopulated) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * The execution log this run records its progress in.
   *
   * Explicit decision: on a re-entry the freshly scaffolded directory is NOT
   * adopted (see the `setPlanDir` gate above), so `scaffoldInfo.summaryPath`
   * points at a directory nothing tracks any more. Progress notes written there
   * would be invisible to whoever reads the checkpoint's own log, so the
   * checkpoint's directory is preferred and the scaffold's log is only the
   * fallback — the case for a first run, where no checkpoint planDir exists.
   *
   * Read through `resolvePlanFile`, never `fs`, so the application layer stays
   * I/O-free.
   */
  private resolveSummaryPath(
    workspace: string,
    scaffoldInfo: ScaffoldResult | null,
    checkpointPlanDir: string | null
  ): string | null {
    if (checkpointPlanDir) {
      try {
        const resolved = this.planGenerator.resolvePlanFile({
          projectRoot: workspace,
          planDir: checkpointPlanDir
        });
        if (resolved && resolved.summaryPath) {
          return resolved.summaryPath;
        }
      } catch {
        // Fall through to the scaffold's own log rather than losing the update.
      }
    }
    return scaffoldInfo ? scaffoldInfo.summaryPath : null;
  }
}
