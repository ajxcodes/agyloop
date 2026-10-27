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
  STAGE_IMPLEMENT,
  STAGE_COMPLETED,
  MODE_PLAN,
  ExecutionMode,
  NOTE_INITIATED_DISCOVERY_RCA,
  NOTE_GENERATING_SPECS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  NOTE_AWAITING_REVIEW,
  NOTE_REOPENED_PLAN_FROM_IMPLEMENT,
  SUMMARY_STAGE_DISCOVERY,
  SUMMARY_STAGE_PLAN_REVIEW,
  SUMMARY_STATUS_IN_PROGRESS,
  SUMMARY_STATUS_COMPLETED,
  SUMMARY_STATUS_PENDING,
  SUMMARY_STATUS_SKIPPED,
  ROLE_DISCOVERY,
  IssueNumber,
  PreFlightHaltError,
  ValidationError,
  VALIDATION_FIELD_PLAN_PATH,
  DiscoveryReport,
  isPlanContentSubstantive
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
  /**
   * An operator-supplied plan file (issue #267). When present it WINS over
   * `planDir` and no scaffold is created.
   */
  readonly planPath?: string | null;
  /** An operator-supplied plan directory (issue #267). */
  readonly planDir?: string | null;
}

/**
 * The RCA-gate evidence (issue #283): what was read, and where.
 *
 * `checkedPaths` exists so the park can NAME the files it inspected instead of
 * claiming a populated report is "an unpopulated scaffold".
 */
export interface DiscoveryReportEvidence {
  readonly populated: boolean;
  readonly populatedPath: string | null;
  readonly checkedPaths: readonly string[];
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
  /** The operator-supplied plan this run will execute (issue #267). */
  readonly suppliedPlanPath?: string | null;
  /** The RCA-gate evidence, including every path that was checked. */
  readonly discoveryReportEvidence: DiscoveryReportEvidence;
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
        // Issue #284 (D6): this only fires once `fetchIssue` ASKS for
        // `milestone`. The `gh --json` field list omitted it, so every
        // checkpoint recorded `milestoneTitle: null` — do not "simplify" the
        // field list back, and do not rely on a milestone arriving unless it
        // was requested.
        sm.setMilestoneTitle(issueData.milestone.title);
      }
    }

    const planTitle =
      params.title || (issueData && !issueData.error && issueData.title ? issueData.title : 'Task Plan');
    const planLabels = (issueData && !issueData.error ? issueData.labels : []) || [];
    const planType = params.type || 'auto';

    // 3. Scaffold plan directory (or accept the operator-supplied plan)
    let scaffoldInfo: ScaffoldResult | null = null;
    let suppliedPlanPath: string | null = null;
    // Captured BEFORE the scaffold can repoint `sm.planDir`, because after the
    // repoint the original value is unrecoverable: this is the plan directory
    // the checkpoint itself tracked, which is the only record of where the
    // discovery report for THIS run actually lives (issue #237, BLOCKER 2).
    const checkpointPlanDir = sm.planDir;

    if (params.planPath) {
      // Issue #267: a supplied plan is the plan the lifecycle executes. It WINS
      // over `planDir`, and NOTHING is scaffolded — a competing empty directory
      // would otherwise be created beside it.
      const resolved = this.planGenerator.resolvePlanFile({
        projectRoot: workspace,
        issue: activeIssue,
        planPath: params.planPath,
        planDir: params.planDir || checkpointPlanDir
      });
      if (!resolved) {
        throw new ValidationError(
          VALIDATION_FIELD_PLAN_PATH,
          params.planPath,
          `The supplied plan file was not found: ${params.planPath}`
        );
      }
      const suppliedContent = this.planGenerator.readPlanDocument(resolved.planPath);
      if (!isPlanContentSubstantive(suppliedContent)) {
        throw new ValidationError(
          VALIDATION_FIELD_PLAN_PATH,
          resolved.planPath,
          `The supplied plan is blank: ${resolved.planPath}. Write a plan with implementation steps (or run \`codeloop plan\` to scaffold one).`
        );
      }
      suppliedPlanPath = resolved.planPath;
      // Persist the FILE, not its directory: `dirname(supplied)` is often the
      // repo root, and adopting it as `planDir` made a later plan/yolo pass
      // scaffold `[Implementation] - …`, `implementation_plan.md` and the
      // summary INTO that directory, beside the supplied plan (issue #267).
      sm.setPlanPath(resolved.planPath);
    } else if (!params.dryRun) {
      scaffoldInfo = this.planGenerator.scaffoldPlanDirectory({
        projectRoot: workspace,
        issue: activeIssue,
        title: planTitle,
        type: planType,
        labels: planLabels,
        planDir: params.planDir ?? checkpointPlanDir
      });
      // Adopt the returned directory when:
      //  - the checkpoint has no plan directory of its own (first run), or
      //  - the caller explicitly supplied one, or
      //  - the generator ADOPTED an existing populated directory (the #283 heal).
      //
      // Every other case keeps the #237 guard: a scaffold that returns a
      // different, freshly created directory must never repoint an existing
      // checkpoint.
      const shouldAdopt =
        !sm.planDir || Boolean(params.planDir) || scaffoldInfo?.adoptedExisting === true;
      if (shouldAdopt && scaffoldInfo && scaffoldInfo.planDir) {
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
    // Issue #284 (AC4): the Discovery row names the subagent that PERFORMED
    // discovery, not the planner. Under the default config this resolves to
    // `inherit` (there is no `models.discovery` mapping), which is the model
    // actually dispatched — the old `pro` cell came from the planner's
    // descriptor and was never the discovery subagent's.
    const discoveryDef = this.resolveSubagentUseCase.execute({
      role: ROLE_DISCOVERY,
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
    let discoveryReportEvidence: DiscoveryReportEvidence = {
      populated: false,
      populatedPath: null,
      checkedPaths: []
    };

    if (suppliedPlanPath !== null) {
      // A non-blank supplied plan is itself the completion evidence: the RCA
      // gate has nothing left to protect. Re-open PLAN from the early stages;
      // an IMPLEMENT checkpoint keeps its stage so the operator can go straight
      // to the implementer directive.
      if (sm.currentStage === STAGE_INITIALIZED || sm.currentStage === STAGE_DISCOVERY) {
        sm.transition(STAGE_PLAN, {
          note: `Plan supplied by the operator: ${suppliedPlanPath}`,
          suppliedPlan: suppliedPlanPath
        });
      }
    } else if (sm.currentStage === STAGE_APPROVAL && params.userFeedback) {
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
      discoveryReportEvidence = this.inspectDiscoveryReport(
        workspace,
        activeIssue,
        sm,
        scaffoldInfo,
        checkpointPlanDir,
        planTitle
      );
      const decision = resolveDiscoveryReentry({
        currentStage: sm.currentStage,
        discoveryReportPresent: discoveryReportEvidence.populated,
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
    } else if (sm.currentStage === STAGE_IMPLEMENT) {
      // Issue #267: re-planning from IMPLEMENT is the supported recovery from
      // the blank-plan park. `IMPLEMENT -> PLAN` is a legal transition now, and
      // the planner payload is produced at PLAN.
      sm.transition(STAGE_PLAN, { note: NOTE_REOPENED_PLAN_FROM_IMPLEMENT });
    }

    // 6. Checkpoint state and update summary log
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      const summaryPath = this.resolveSummaryPath(workspace, scaffoldInfo, checkpointPlanDir);
      if (summaryPath) {
        if (sm.currentStage === STAGE_DISCOVERY) {
          this.planGenerator.updateSummaryLog(summaryPath, {
            stage: SUMMARY_STAGE_DISCOVERY,
            subagent: discoveryDef.name,
            model: discoveryDef.model,
            status: SUMMARY_STATUS_IN_PROGRESS
          });
        } else if (sm.currentStage === STAGE_PLAN) {
          this.planGenerator.updateSummaryLog(summaryPath, {
            stage: SUMMARY_STAGE_DISCOVERY,
            subagent: discoveryDef.name,
            model: discoveryDef.model,
            status: params.skipDiscovery ? SUMMARY_STATUS_SKIPPED : SUMMARY_STATUS_COMPLETED
          });
          this.planGenerator.updateSummaryLog(summaryPath, {
            stage: SUMMARY_STAGE_PLAN_REVIEW,
            subagent: plannerDef.name,
            model: plannerDef.model,
            status: SUMMARY_STATUS_IN_PROGRESS,
            planRevisionCount: sm.planRevisionCount
          });
        } else {
          this.planGenerator.updateSummaryLog(summaryPath, {
            stage: SUMMARY_STAGE_DISCOVERY,
            subagent: discoveryDef.name,
            model: discoveryDef.model,
            status: params.skipDiscovery ? SUMMARY_STATUS_SKIPPED : SUMMARY_STATUS_COMPLETED
          });
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
      discoveryReentry,
      suppliedPlanPath,
      discoveryReportEvidence
    };
  }

  /**
   * Content-based evidence that an RCA report exists for this checkpoint
   * (issues #237, #283).
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
   * Every candidate directory is inspected (the checkpoint's own, the
   * scaffold's, and the best `<issue>-*` candidate) and every path that was
   * read is returned, so a park can NAME what it checked instead of claiming a
   * populated report is "an unpopulated scaffold" (#283, AC3).
   */
  private inspectDiscoveryReport(
    workspace: string,
    activeIssue: number | string | null,
    sm: StateMachine,
    scaffoldInfo: ScaffoldResult | null,
    checkpointPlanDir: string | null,
    planTitle: string
  ): DiscoveryReportEvidence {
    const checkedPaths: string[] = [];
    let populatedPath: string | null = null;

    try {
      // `findPlanDirectory` ranks a POPULATED candidate first (issue #283), so
      // even a directory this checkpoint never tracked is considered.
      const foundPlanDir =
        activeIssue !== null && typeof this.planGenerator.findPlanDirectory === 'function'
          ? this.planGenerator.findPlanDirectory(workspace, activeIssue, planTitle)
          : null;

      const candidateDirs = [
        checkpointPlanDir,
        scaffoldInfo ? scaffoldInfo.planDir : null,
        foundPlanDir
      ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);

      const candidates: string[] = [];
      if (scaffoldInfo && scaffoldInfo.planPath) {
        candidates.push(scaffoldInfo.planPath);
      }
      for (const planDir of candidateDirs) {
        const resolved = this.planGenerator.resolvePlanFile({
          projectRoot: workspace,
          issue: sm.issue,
          planDir,
          // DISCOVERY resolution now ranks a POPULATED `[Discovery]` artifact
          // ahead of a pristine sibling, then any discovery artifact, so one
          // empty sibling can never mask a populated one.
          stage: STAGE_DISCOVERY
        });
        if (resolved && resolved.planPath) {
          candidates.push(resolved.planPath);
        }
      }

      for (const candidate of new Set(candidates)) {
        checkedPaths.push(candidate);
        try {
          const markdown = this.planGenerator.readPlanDocument(candidate);
          if (DiscoveryReport.fromMarkdown(markdown).isPopulated) {
            populatedPath = candidate;
            break;
          }
        } catch {
          // Fail closed: a read failure is not evidence.
        }
      }
    } catch {
      // Fail closed on any resolver error.
    }

    return {
      populated: populatedPath !== null,
      populatedPath,
      checkedPaths
    };
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
