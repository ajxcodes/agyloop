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
 * THE CROSS-MODE INVARIANT (issue #259, S9):
 *
 *   No lifecycle path may advance past IMPLEMENT to QUALITY_GATE without
 *   positive evidence that the implementation exists in the active workspace.
 *
 * The invariant is deliberately phrased as an EVIDENCE rule and not as a
 * DISPATCH rule. agyloop is a dispatcher, not an executor: no path in this
 * repository ever runs a subagent (`codeloop next` hands an
 * `actionType: 'subagent'` payload to an EXTERNAL orchestrator), and
 * `AgentRunnerPort` is deliberately not wired into the lifecycle
 * (`src/application/halt-pipeline.ts`). `codeloop implement` and
 * `codeloop yolo` are therefore EQUALLY incapable of dispatching — the
 * difference is that `implement` STOPS at IMPLEMENT and hands the operator a
 * next step, while `yolo` used to CONTINUE into verification over a tree that
 * nothing had changed.
 *
 * | Path                  | Advances past IMPLEMENT? | What enforces the invariant |
 * |-----------------------|--------------------------|-----------------------------|
 * | `codeloop yolo`       | yes (gates + review)     | the implementation-evidence probe at the IMPLEMENT -> QUALITY_GATE boundary, which PARKS when the tree carries no implementation |
 * | `codeloop implement`  | no — prepares and stops  | already satisfied: it never calls the gate or the review |
 * | `codeloop` (standard) | yes (gates + review)     | the same probe, injected into the gate, which returns VACUOUS and stops the loop before the review |
 * | `codeloop gates` / `codeloop commit` | no implementation stage | not in scope of the invariant |
 *
 * Strict Hexagonal Architecture: Zero direct I/O, zero Node.js built-ins.
 */

import {
  StateMachine,
  StateMachineSnapshot,
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
  MODE_COMMIT,
  GATE_APPROVAL,
  GATE_COMMIT,
  GATE_TRIAGE,
  GATE_CIRCUIT_BREAKER,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  NOTE_LIFECYCLE_STARTED,
  NOTE_LIFECYCLE_COMPLETED,
  NOTE_PAUSED_APPROVAL_GATE,
  NOTE_PAUSED_COMMIT_GATE,
  NOTE_PAUSED_TRIAGE_GATE,
  NOTE_YOLO_PARKED_AT_DISCOVERY,
  withRecordedPauseHint,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  NOTE_AUTO_APPROVED_PLAN,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  NOTE_COMMIT_AFTER_EXECUTED,
  NOTE_ALREADY_COMPLETED,
  NOTE_PAUSED_CIRCUIT_BREAKER_GATE,
  NOTE_YOLO_NO_IMPLEMENTATION,
  NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN,
  NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN_REPEAT,
  NOTE_YOLO_NO_IMPLEMENTATION_UNMEASURABLE,
  PLAN_EMPTY_PARK_REPEAT_THRESHOLD,
  formatDiscoveryParkAwaitingRca,
  isPlanContentSubstantive,
  NOTE_GATES_VACUOUS_STANDARD,
  NOTE_GATES_VACUOUS_YOLO,
  GateCommandDefinition,
  WorktreeDescriptor,
  DEFAULT_CB_MAX_GATE_RETRIES,
  CB_ACTION_PAUSE_FOR_HUMAN,
  CB_ACTION_ABORT,
  CB_ACTION_WARN,
  CircuitBreakerTrippedError,
  QuotaExhaustedError,
  QUOTA_RESUME_COMMAND,
  VERDICT_SKIPPED,
  StateStorageError,
  WorktreeCreationError,
  WorktreeError,
  ValidationError,
  InvalidTransitionError,
  isSamePath
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
  WorktreeManagerPort,
  GateReportRepositoryPort
} from '../ports';
import { StartPlanningUseCase, StartPlanningResult } from './start-planning';
import { StartImplementationUseCase, StartImplementationResult } from './start-implementation';
import { RunQualityGateUseCase, QualityGateRunResult } from './run-quality-gate';
import { DetectImplementationDiffUseCase, ImplementationDiff } from './detect-implementation-diff';
import { RunReviewUseCase, RunReviewResult } from './run-review';
import { DraftCommitUseCase, DraftCommitResult } from './draft-commit';
import { ExecuteCommitUseCase, ExecuteCommitResult } from './execute-commit';
import { ResolveSubagentUseCase } from './resolve-subagent';
import { RunPreFlightCheckUseCase } from './run-preflight-check';
import { InferBaseBranchUseCase } from './infer-base-branch';
import { shouldRouteToTriage } from './lifecycle-reentry-policy';
import { actionableReviewFeedback } from './triage-feedback';
import type { PreFlightCheckResult } from '../domain';

export interface RunLifecycleParams {
  readonly mode?: ExecutionMode;
  readonly issue?: number | string | null;
  readonly title?: string | null;
  readonly type?: string | null;
  readonly commitAfter?: boolean;
  /**
   * Open the delivery PR from the tool (issue #315, AC-22/AC-25). Forwarded to
   * `ExecuteCommitUseCase`; `yolo --commit-after` implies it, because a hands-off
   * run that stops one step short of delivery is not hands-off.
   */
  readonly createPr?: boolean;
  readonly yes?: boolean;
  readonly staged?: boolean;
  readonly message?: string | null;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  /**
   * The repository the WHOLE run is bound to (issue #425): the checkpoint
   * directory *and* the provisioning / measurement / gate cwd. Every path the
   * lifecycle derives — config load, pre-flight, plan scaffolding, the worktree,
   * the baseline measurement, the diff and the gate — comes from this one value.
   * Omitted means the process's current directory, which is today's behaviour
   * for a caller that has no `--workspace`.
   */
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
  /**
   * The dispatched Reviewer subagent's verdict block (issue #269).
   *
   * Forwarded to `RunReviewUseCase` as `reviewOutput` — the domain's chosen
   * seam for "the reviewer's verdict". Omitted, the behaviour is byte-identical
   * to today (the critique-based Tier 1 review, or the #236 advisory
   * fail-open).
   */
  readonly reviewOutput?: string | null;
  readonly interactiveCommit?: boolean;
  /**
   * False when no human can answer prompts (non-TTY, `--json`). Threaded into the
   * stage use cases that own a prompt so a non-interactive run never blocks
   * (issue #218 AC6). Omitted means interactive.
   */
  readonly interactive?: boolean;
  readonly worktree?: boolean;
  readonly step?: boolean;
  /**
   * Explicit operator opt-in that bypasses the DISCOVERY RCA park (issue #237).
   * Threaded into `StartPlanningUseCase` and enforced by
   * `resolveDiscoveryReentry`; recorded in history metadata so a bypassed RCA
   * gate stays auditable. Without it, re-entering a DISCOVERY checkpoint whose
   * report does not yet carry RCA evidence parks instead of advancing.
   */
  readonly skipDiscovery?: boolean;
  readonly onProgress?: (message: string) => void;
}

/**
 * Non-blocking notice about a gate pause that was already on disk when this run
 * started (typically a CIRCUIT_BREAKER halt persisted by a previous invocation).
 *
 * Typed on the result instead of `console.warn`-ed from here so the application
 * layer stays free of I/O policy and the presentation layer owns *where* the
 * notice goes — the breaker diagnostic is contractually stderr-only, and
 * stdout may be parsed by `--json` consumers.
 */
export interface PersistedPauseAdvisory {
  /** Gate name recorded on the loaded checkpoint. */
  readonly gate: string;
  /** ISO instant the pause was recorded; null for a timestamp-less checkpoint. */
  readonly pausedAtTimestamp: string | null;
  /** Fully-qualified command that actually clears the pause. */
  readonly resumeCommand: string;
  /** Operator-facing text, including gate, timestamp and the resume command. */
  readonly message: string;
}

export interface RunLifecycleResult {
  readonly success: boolean;
  readonly mode: ExecutionMode;
  readonly currentStage: StageName;
  readonly stateMachine: StateMachine;
  readonly pausedAtGate?: typeof GATE_APPROVAL | typeof GATE_COMMIT | typeof GATE_TRIAGE | typeof GATE_CIRCUIT_BREAKER | null;
  /**
   * Set when the checkpoint loaded at the start of the run was already paused at a
   * gate. ADVISORY ONLY — the run proceeds and the exit path is unchanged.
   */
  readonly persistedPauseAdvisory?: PersistedPauseAdvisory;
  /**
   * True when the halt was caused by provider quota exhaustion rather than a
   * retry-count circuit breaker. Lets the CLI pick a distinguishable exit code.
   */
  readonly quotaExhausted?: boolean;
  readonly planResult?: StartPlanningResult;
  readonly implementationResult?: StartImplementationResult;
  readonly qualityGateResult?: QualityGateRunResult;
  readonly reviewResult?: RunReviewResult;
  readonly draftCommitResult?: DraftCommitResult;
  readonly executeCommitResult?: ExecuteCommitResult;
  readonly worktree?: WorktreeDescriptor | null;
  readonly message?: string;
  /**
   * True when the run parked because NO implementation was detected (issue
   * #259). The stage stayed at IMPLEMENT: no transition happened, nothing was
   * reverted, and no gate command was executed.
   */
  readonly implementationHalted?: boolean;
  /**
   * The implementation-evidence verdict the run was given (issue #259). It is
   * the operator-facing diagnostic for the park and the `--json` payload for
   * machine consumers.
   */
  readonly implementationDiff?: ImplementationDiff | null;
  /**
   * True when the plan the run was given carries NO implementation steps —
   * the tool's own blank scaffold (issue #259, S10). The fast-path never
   * dispatches the planner, so its plan IS the scaffold; a directive that
   * points at an empty plan is a false instruction, so the park suppresses it
   * and names the plan instead.
   */
  readonly implementationPlanEmpty?: boolean;
  /**
   * How many blank-plan parks have been recorded for this checkpoint
   * (issue #267). 1 on the first park, 2+ on a repeat, so the CLI can say
   * "attempt N, still blank" instead of repeating the same text.
   */
  readonly implementationPlanParkCount?: number;
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
  /**
   * The implementation-evidence probe (issue #259). Injectable so a caller can
   * drive the park deterministically without a real git repository.
   */
  readonly detectImplementationDiffUseCase?: DetectImplementationDiffUseCase;
  /**
   * The gate evidence channel (issue #284). Optional; injected by the CLI
   * composition root so an in-process gate run files the same record a
   * dispatched gate files.
   */
  readonly gateReportRepo?: GateReportRepositoryPort;
}

/**
 * "Did this invocation create it?" evidence captured BEFORE provisioning
 * (issue #420).
 *
 * `createWorktree` can CREATE or ADOPT a worktree, and the descriptor does not
 * say which, so the pre-provisioning worktree list plus the pre-provisioning
 * local branch list are the only reliable provenance evidence.
 */
interface WorktreeProvisioningProvenance {
  /** `null` = the list could not be read; provenance is UNKNOWN, never assume new. */
  readonly existingWorktreePaths: readonly string[] | null;
  /** `null` = unknown; the worktree may still be removed, the branch must not. */
  readonly existingBranches: readonly string[] | null;
}

interface ProvisionedWorktreeCleanup {
  readonly removed: boolean;
  readonly warnings: readonly string[];
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
  private readonly detectImplementationDiffUseCase: DetectImplementationDiffUseCase;

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

    this.inferBaseBranchUseCase =
      deps.inferBaseBranchUseCase ??
      (this.worktreeManager ? new InferBaseBranchUseCase(this.worktreeManager, this.githubGateway, this.stateRepo) : undefined);

    this.startImplementationUseCase =
      deps.startImplementationUseCase ??
      new StartImplementationUseCase(
        this.stateRepo,
        this.configRepo,
        this.planGenerator,
        this.githubGateway,
        resolveSubagentUseCase,
        this.worktreeManager,
        this.inferBaseBranchUseCase,
        this.commandExecutor
      );

    this.runQualityGateUseCase =
      deps.runQualityGateUseCase ??
      new RunQualityGateUseCase(
        this.stateRepo,
        this.configRepo,
        this.planGenerator,
        this.commandExecutor,
        this.buildDetector,
        resolveSubagentUseCase,
        deps.gateReportRepo
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

    this.detectImplementationDiffUseCase =
      deps.detectImplementationDiffUseCase ??
      new DetectImplementationDiffUseCase(this.commandExecutor);
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

    // 2. Load state checkpoint and determine execution mode.
    //
    // Issue #278: this is hoisted ABOVE the pre-flight block because it is a
    // pure READ and the "just look" path needs its answer before anything with
    // a side effect (network / `gh`) can run.
    const snapshot = await this.stateRepo.load();
    const requestedMode: ExecutionMode = params.mode || MODE_STANDARD;
    const isNewIssue =
      params.issue !== undefined &&
      params.issue !== null &&
      snapshot !== null &&
      snapshot.issue !== null &&
      String(params.issue) !== String(snapshot.issue);
    /**
     * A bare `codeloop` against a COMPLETED checkpoint is a read.
     *
     * Before #278 the standard path unconditionally called `sm.setMode()` and
     * `stateRepo.save()`, so the run rewrote `mode` and `updatedAt`, and then
     * provisioned a worktree on a stale branch. `MODE_IMPLEMENT` is
     * deliberately EXCLUDED: `StartImplementationUseCase` legitimately re-opens
     * COMPLETED → IMPLEMENT.
     */
    const isFinishedStandardRun =
      snapshot?.currentStage === STAGE_COMPLETED &&
      requestedMode === MODE_STANDARD &&
      !isNewIssue;

    // Run Pre-Flight Task Check (Anti-Duplicate & Resume Mode)
    const activeIssueToCheck = effectiveIssue;
    let preflightResult = undefined;
    if (activeIssueToCheck && !params.dryRun && !isFinishedStandardRun) {
      preflightResult = await this.runPreFlightCheckUseCase.execute({
        issueNumber: activeIssueToCheck,
        workspaceDir: workspace,
        trackerRepo: config.migration?.trackerRepo
      });
    }

    let sm: StateMachine;
    let activeMode: ExecutionMode = params.mode || MODE_STANDARD;
    if (snapshot) {
      sm = StateMachine.fromSnapshot(snapshot);
      if (isFinishedStandardRun) {
        // Nothing to do, and NOTHING to write: return before the reset/mode
        // legs can touch the checkpoint or provision a worktree.
        return {
          success: true,
          mode: MODE_STANDARD,
          currentStage: STAGE_COMPLETED,
          stateMachine: sm,
          worktree: null,
          message: NOTE_ALREADY_COMPLETED
        };
      }
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
          // Defence in depth for every other mode (#278 AC-278.2): `setMode`
          // is a no-op when the mode is unchanged, so the save is skipped when
          // there is nothing to persist.
          if (sm.mode !== activeMode) {
            sm.setMode(activeMode);
            if (!params.dryRun) {
              await this.stateRepo.save(sm.toSnapshot());
            }
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

    // The RESOLVED checkpoint is authoritative about its own issue (issue #250).
    //
    // With the scope applied, `sm` is the checkpoint the operator's issue (or
    // the scan) named — e.g. `.agyloop/tasks/250.json` while the current branch
    // is `task/251-x`. A path/branch inference may only SUPPLY an issue for a
    // checkpoint that has none; it must never RELABEL a resolved one, or the
    // scoped file would be rewritten with someone else's issue number.
    const finalIssue = params.issue ?? sm.issue ?? effectiveIssue;
    if (finalIssue && !isNewIssue && sm.issue !== Number(finalIssue)) {
      sm.setIssue(finalIssue);
      if (!params.dryRun) {
        await this.stateRepo.save(sm.toSnapshot());
      }
    }

    // Advisory (never blocking) for a pause that was already persisted before this
    // run. This is the single chokepoint every mode flows through, so one check
    // covers `plan`, `implement`, `yolo`, `commit` and the default loop.
    const persistedPauseAdvisory = this.buildPersistedPauseAdvisory(sm);
    const withAdvisory = (result: RunLifecycleResult): RunLifecycleResult =>
      persistedPauseAdvisory ? { ...result, persistedPauseAdvisory } : result;

    // If preflight check detected resume mode with PR review comments, route to STAGE_TRIAGE.
    // The predicate lives in the one lifecycle re-entry policy so this rule and
    // `GetNextActionUseCase`'s COMPLETED path can never drift apart: today's
    // condition was `isResume && (comments.length > 0 || changesRequested) && stage !== TRIAGE`,
    // which is exactly `shouldRouteToTriage({ currentStage, hasOpenReviewFeedback })`.
    // Issue #397: this dispatcher built its payload from the UNCLASSIFIED
    // preflight comments, so a YOLO/lifecycle route put the repository's own
    // summary INSIDE the payload (`commentsCount: 3`) while `next` kept it
    // outside (`commentsCount: 2`). One selector, three call sites.
    const actionableReviewComments = actionableReviewFeedback(
      preflightResult?.prReviewComments ?? []
    );
    const hasOpenReviewFeedback = Boolean(
      preflightResult &&
        preflightResult.isResume &&
        (actionableReviewComments.length > 0 || preflightResult.prHasChangesRequested)
    );

    if (preflightResult && shouldRouteToTriage({ currentStage: sm.currentStage, hasOpenReviewFeedback })) {
      if (sm.canTransition(STAGE_TRIAGE)) {
        if (actionableReviewComments.length > 0) {
          sm.setTriagePayload(actionableReviewComments.map((c) => `- [${c.author || 'Unknown'}]: ${c.body}`).join('\n'));
        }
        sm.transition(STAGE_TRIAGE, {
          note: NOTE_PAUSED_TRIAGE_GATE,
          prNumber: preflightResult.resumePrNumber,
          commentsCount: actionableReviewComments.length
        });
      } else {
        return withAdvisory({
          success: false,
          mode: activeMode,
          currentStage: sm.currentStage,
          stateMachine: sm,
          message: `Cannot transition to TRIAGE from ${sm.currentStage}`
        });
      }
      sm.pauseAtGate(GATE_TRIAGE);
      if (!params.dryRun) {
        await this.stateRepo.save(sm.toSnapshot());
      }
      return withAdvisory({
        success: true,
        mode: activeMode,
        currentStage: sm.currentStage,
        stateMachine: sm,
        pausedAtGate: GATE_TRIAGE,
        message: NOTE_PAUSED_TRIAGE_GATE
      });
    }

    if (sm.currentStage === STAGE_TRIAGE) {
      sm.pauseAtGate(GATE_TRIAGE);
      return withAdvisory({
        success: true,
        mode: activeMode,
        currentStage: sm.currentStage,
        stateMachine: sm,
        pausedAtGate: GATE_TRIAGE,
        message: NOTE_PAUSED_TRIAGE_GATE
      });
    }

    // 3. Dispatch based on operational mode
    //
    // A provider quota rejection (HTTP 429 / RESOURCE_EXHAUSTED) raised by any stage
    // use-case is a recoverable halt, not a crash: checkpoint at the
    // CIRCUIT_BREAKER gate so the next invocation resumes with full context
    // (issue #218 AC4). Every other error propagates untouched.
    try {
      // `return await` (not bare `return`): a returned promise settles OUTSIDE the
      // try block, so the rejection would bypass the quota interception below.
      switch (activeMode) {
        case MODE_PLAN:
          return withAdvisory(await this.executePlanMode(sm, params, workspace));

        case MODE_IMPLEMENT:
          return withAdvisory(
            await this.executeImplementMode(sm, params, workspace, preflightResult, snapshot)
          );

        case MODE_COMMIT:
          return withAdvisory(await this.executeCommitMode(sm, params, workspace));

        case MODE_YOLO:
          return withAdvisory(await this.executeYoloMode(sm, params, commitAfter, workspace, preflightResult));

        case MODE_STANDARD:
        default:
          return withAdvisory(await this.executeStandardMode(sm, params, commitAfter, workspace, preflightResult));
      }
    } catch (err: unknown) {
      if (!(err instanceof QuotaExhaustedError)) {
        throw err;
      }

      sm.pauseAtGate(GATE_CIRCUIT_BREAKER);
      await this.persistCheckpoint(sm, params.dryRun);

      return {
        success: false,
        mode: activeMode,
        currentStage: sm.currentStage,
        stateMachine: sm,
        pausedAtGate: GATE_CIRCUIT_BREAKER,
        quotaExhausted: true,
        message: `${err.message} ${NOTE_PAUSED_CIRCUIT_BREAKER_GATE}: state persisted.`
      };
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
      mode: sm.mode,
      issue: sm.issue,
      title: params.title,
      type: params.type,
      dryRun: params.dryRun,
      configPath: params.configPath,
      skipDiscovery: params.skipDiscovery,
      planPath: params.planPath,
      planDir: params.planDir,
      workspaceDir: workspace
    });

    const isApproval = planResult.stateMachine.currentStage === STAGE_APPROVAL;
    return {
      success: true,
      mode: MODE_PLAN,
      currentStage: planResult.stateMachine.currentStage,
      stateMachine: planResult.stateMachine,
      pausedAtGate: isApproval ? GATE_APPROVAL : undefined,
      planResult,
      message:
        planResult.discoveryParked === true
          ? // Discovery park (issues #237, #379): the RCA never ran, so
            // "advanced to DISCOVERY" would read like progress. Name the
            // outstanding work AND the paths that were actually checked
            // (issue #283, AC3). This now covers the first-run bug entry too.
            this.formatDiscoveryParkMessage(planResult, sm.pausedAtGate)
          : isApproval
            ? NOTE_PAUSED_APPROVAL_GATE
            : `Pipeline advanced to ${planResult.stateMachine.currentStage}.`
    };
  }

  /**
   * The DISCOVERY park message, naming the missing evidence and the paths that
   * were actually read (issues #283, #306). Falls back to the base note when
   * nothing is known.
   */
  private formatDiscoveryParkMessage(
    planResult?: StartPlanningResult | null,
    pausedAtGate?: string | null
  ): string {
    const evidence = planResult?.discoveryReportEvidence;
    return formatDiscoveryParkAwaitingRca(
      (evidence?.checkedPaths ?? []).join(', '),
      evidence?.missingEvidence ?? null,
      evidence?.evaluatedPath ?? null,
      pausedAtGate,
      // #339 (item 3): a title-rejected report gets the kind headline naming
      // the first line the gate saw, never the generic "does not yet contain
      // RCA evidence" claim its content disproves.
      evidence?.kindRejection ?? null
    );
  }

  /**
   * Builds the "you are resuming from a paused checkpoint" notice, or undefined
   * when the loaded checkpoint is not paused.
   *
   * Why this exists: `handleCircuitBreakerTrip` is only reachable from the
   * quality-gate retry path, `GetNextActionUseCase` never reads `pausedAtGate`,
   * and the CLI's `persistedHaltExitCode` only inspects the result of the run
   * that *just* happened. A breaker pause persisted by an earlier invocation was
   * therefore invisible — the next `codeloop plan` / `implement` / `yolo` / bare
   * run silently proceeded as if nothing had ever halted.
   *
   * Advisory by construction: this only *reports*, it never blocks and never
   * mutates state, so the documented resume path (`codeloop implement`) keeps
   * working and a fresh trip keeps its existing exit code.
   */
  private buildPersistedPauseAdvisory(sm: StateMachine): PersistedPauseAdvisory | undefined {
    const gate = sm.pausedAtGate;
    if (!gate) {
      return undefined;
    }

    const pausedAtTimestamp = sm.pausedAtTimestamp;
    const since = pausedAtTimestamp ? ` since ${pausedAtTimestamp}` : '';
    return {
      gate,
      pausedAtTimestamp,
      resumeCommand: QUOTA_RESUME_COMMAND,
      message:
        `Checkpoint is paused at the ${gate} gate${since}. ` +
        `Resolve the blocking condition, then run \`${QUOTA_RESUME_COMMAND}\` to clear the pause. ` +
        `Continuing anyway — this notice is advisory and nothing is lost.`
    };
  }

  /**
   * Helper: resolves an isolated git worktree if enabled for the active task.
   *
   * `null` means "not requested" and NOTHING ELSE (issue #301). The callers that
   * may legitimately skip provisioning are the top guards below: a dry run, an
   * explicit `--no-worktree`, no worktree manager, or no issue. Every failure
   * after that point THROWS — the run never silently degrades to the root
   * workspace while a worktree sits on disk.
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

    const manager = this.worktreeManager;
    let baseBranch = params.baseRef || params.baseBranch;
    let branchPrefix: string | undefined = undefined;

    // Base-branch inference is NON-FATAL: a failed inference falls back to the
    // caller's explicit branch (or the manager's own default).
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

    let descriptor: WorktreeDescriptor;
    try {
      descriptor = await manager.createWorktree({
        taskId,
        baseBranch,
        branchPrefix,
        title: params.title,
        workspaceDir: rootWorkspace
      });
    } catch (err: unknown) {
      // A pre-existing worktree error keeps its own operation/message; anything
      // else is wrapped so the caller always sees a worktree failure.
      if (err instanceof WorktreeError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new WorktreeCreationError(
        'createWorktree',
        `Failed to create the isolated worktree for issue #${taskId}: ${message}`,
        {},
        err
      );
    }

    sm.setWorktree(descriptor);
    if (baseBranch) {
      sm.setBaseBranch(baseBranch);
    }

    // #234/#226 + #301: the descriptor save is part of the provisioning
    // TRANSACTION. `createWorktree` -> `setWorktree` -> `save`; if the save
    // fails, the just-created worktree is torn down before the error is
    // rethrown, so an on-disk worktree can never outlive a `worktree: null`
    // checkpoint. Failing loudly is what stops the run from continuing from the
    // root workspace as if nothing was requested.
    // `dryRun` returns null at the top of this helper, so this save never fires
    // on a dry run.
    try {
      await this.stateRepo.save(sm.toSnapshot());
    } catch (err: unknown) {
      let teardownError: unknown = null;
      try {
        await manager.removeWorktree({
          worktreePath: descriptor.worktreePath,
          workspaceDir: rootWorkspace,
          force: true,
          prune: true,
          tolerateMissing: true,
          allowExternal: true
        });
      } catch (teardownErr: unknown) {
        teardownError = teardownErr;
      }

      const base = err instanceof Error ? err.message : String(err);
      const teardown = teardownError
        ? ` Teardown also failed (${teardownError instanceof Error ? teardownError.message : String(teardownError)}); run \`codeloop worktree prune\`.`
        : ' The just-created worktree was torn down.';
      const suffix = `${teardown} The run did NOT continue from the root workspace.`;

      if (err instanceof StateStorageError) {
        throw new StateStorageError(err.filePath, err.operation, `${err.message}${suffix}`, err);
      }
      throw new StateStorageError(
        this.stateRepo.getStateFilePath(),
        'save',
        `Failed to persist the worktree descriptor for issue #${taskId}: ${base}.${suffix}`,
        err
      );
    }

    return descriptor;
  }

  /**
   * The ONLY lifecycle legs that START IMPLEMENTATION — and therefore the only
   * ones allowed to create a worktree (issue #301).
   *
   * Every other stage honours the descriptor already on the checkpoint, or runs
   * from the workspace root. `mode=implement` provisions explicitly in
   * `executeImplementMode`; it never reaches this helper.
   */
  private shouldProvisionWorktree(stage: StageName, mode: ExecutionMode): boolean {
    if (mode === MODE_YOLO) {
      return stage === STAGE_PLAN || stage === STAGE_APPROVAL;
    }
    return stage === STAGE_APPROVAL;
  }

  /**
   * Measures the working tree against the base branch (issue #259).
   *
   * The base reference follows the same fallback chain the review path uses:
   * an explicit ref -> the inferred base branch -> 'main'.
   */
  private async probeImplementationDiff(
    sm: StateMachine,
    params: RunLifecycleParams,
    workspace: string
  ): Promise<ImplementationDiff> {
    const baseRef = params.baseRef ?? params.baseBranch ?? sm.baseBranch ?? 'main';

    return this.detectImplementationDiffUseCase.execute({
      workspaceDir: workspace,
      baseRef
    });
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
        prune: true,
        // Internal teardown (#282): a worktree deleted out of band must not
        // fail the run, and an adopted worktree may live outside `.worktrees`.
        tolerateMissing: true,
        allowExternal: true
      });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Captures "did this invocation create it?" evidence BEFORE provisioning
   * (issue #420).
   *
   * Defensive by design: a manager without `listWorktrees`/`listBranches`, or a
   * probe that throws, yields `null` — "unknown" — and the cleanup then declines
   * to touch what it cannot prove it created.
   */
  private async captureWorktreeProvisioningProvenance(
    workspace: string
  ): Promise<WorktreeProvisioningProvenance> {
    const manager = this.worktreeManager;
    let existingWorktreePaths: readonly string[] | null = null;
    let existingBranches: readonly string[] | null = null;

    if (manager) {
      try {
        if (typeof manager.listWorktrees === 'function') {
          const worktrees = await manager.listWorktrees({
            workspaceDir: workspace,
            includeExternal: true
          });
          existingWorktreePaths = worktrees.map((worktree) => worktree.worktreePath);
        }
      } catch {
        existingWorktreePaths = null;
      }

      try {
        if (typeof manager.listBranches === 'function') {
          existingBranches = await manager.listBranches({ workspaceDir: workspace, remote: false });
        }
      } catch {
        existingBranches = null;
      }
    }

    return { existingWorktreePaths, existingBranches };
  }

  /**
   * Removes a worktree THIS invocation created and deletes its branch only when
   * the branch is provably new (issue #420).
   *
   * The fail-safe direction is always "leave it": unknown provenance, an adopted
   * or non-canonical worktree, and a failed removal all return
   * `removed === false`, so the caller keeps the descriptor and the surviving
   * worktree stays discoverable through `codeloop status` / `codeloop next`.
   */
  private async discardProvisionedWorktree(
    worktree: WorktreeDescriptor,
    provenance: WorktreeProvisioningProvenance,
    workspace: string
  ): Promise<ProvisionedWorktreeCleanup> {
    const warnings: string[] = [];
    const manager = this.worktreeManager;
    if (!manager) {
      return { removed: false, warnings };
    }

    // Unknown provenance is never "new" (AC5).
    const existingWorktreePaths = provenance.existingWorktreePaths;
    if (existingWorktreePaths === null) {
      return { removed: false, warnings };
    }

    // A worktree already registered before provisioning was adopted, not
    // created here — never remove it (#282, #287).
    if (existingWorktreePaths.some((existing) => isSamePath(existing, worktree.worktreePath))) {
      return { removed: false, warnings };
    }

    // Only the canonical container is ours to remove; an external or custom
    // path is treated as adopted.
    let canonicalPath: string;
    try {
      canonicalPath = await manager.resolveTaskWorktreePath(workspace, worktree.taskId);
    } catch {
      return { removed: false, warnings };
    }
    if (!isSamePath(canonicalPath, worktree.worktreePath)) {
      return { removed: false, warnings };
    }

    try {
      await manager.removeWorktree({
        worktreePath: worktree.worktreePath,
        workspaceDir: workspace,
        force: true,
        prune: true,
        // Internal teardown (#282): a target deleted out of band must not turn
        // a refusal into a cleanup failure. `allowExternal` is deliberately NOT
        // set: this cleanup only ever targets the canonical path proven above.
        tolerateMissing: true
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(
        `The worktree created for issue #${worktree.taskId} at ${worktree.worktreePath} could not be removed (${reason}); run \`codeloop worktree prune\`.`
      );
      return { removed: false, warnings };
    }

    const existingBranches = provenance.existingBranches;
    if (
      existingBranches !== null &&
      !existingBranches.includes(worktree.branch) &&
      typeof manager.deleteBranch === 'function'
    ) {
      try {
        await manager.deleteBranch({ branchName: worktree.branch, workspaceDir: workspace });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        warnings.push(
          `The worktree was removed, but branch '${worktree.branch}' could not be deleted (${reason}); run \`git branch -D ${worktree.branch}\`.`
        );
      }
    }

    return { removed: true, warnings };
  }

  /**
   * Implement mode: resumes execution directly from approved plan specification.
   *
   * Issue #420: this leg provisions the worktree BEFORE the plan guards run
   * inside `StartImplementationUseCase`, so a guard refusal must undo only what
   * THIS invocation created — the worktree directory, the branch and the
   * descriptor `resolveWorktree` wrote. An adopted worktree, unknown provenance
   * or a failed teardown leaves everything in place (descriptor included) so the
   * orphan stays visible; the guard's own error is always rethrown unchanged.
   *
   * The restore target is the checkpoint the run LOADED (`checkpointAtLoad`),
   * not a fresh `sm.toSnapshot()`: `execute` normalizes `mode`/`issue` before
   * dispatch, and AC3 requires a refusal to leave the values the run loaded —
   * including `updatedAt` — so the approval identity stays byte-stable.
   */
  private async executeImplementMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    workspace: string,
    preflightResult?: PreFlightCheckResult,
    checkpointAtLoad?: StateMachineSnapshot | null
  ): Promise<RunLifecycleResult> {
    const hadDescriptor = Boolean(sm.worktree);
    const checkpointBeforeProvisioning = checkpointAtLoad ?? sm.toSnapshot();
    const provenance =
      hadDescriptor || params.dryRun === true || params.worktree === false || !this.worktreeManager
        ? null
        : await this.captureWorktreeProvisioningProvenance(workspace);

    const worktree = await this.resolveWorktree(sm, params, workspace);
    const activeWorkspace = worktree ? worktree.worktreePath : workspace;

    let implResult: StartImplementationResult;
    try {
      implResult = await this.startImplementationUseCase.execute({
        issue: sm.issue,
        planPath: params.planPath,
        planDir: params.planDir,
        userInstructions: params.userInstructions,
        configPath: params.configPath,
        dryRun: params.dryRun,
        // Issue #247: forward the tri-state `worktree === false` (`--no-worktree`)
        // across the boundary so StartImplementationUseCase's `skipWorktree`
        // guardrail really short-circuits instead of re-provisioning through the
        // adopt path. `resolveWorktree` (above) remains the outer layer.
        noWorktree: params.worktree === false,
        workspaceDir: activeWorkspace,
        hasMergeConflicts: preflightResult?.hasMergeConflicts,
        mergeBaseBranch: preflightResult?.candidateBaseBranch
      });
    } catch (err: unknown) {
      // Only a REFUSAL ("this plan/stage cannot start") is torn down. Provisioning
      // failures keep their own transaction teardown in `resolveWorktree`, and a
      // quota halt is intercepted one level up.
      if (
        (err instanceof ValidationError || err instanceof InvalidTransitionError) &&
        !hadDescriptor &&
        worktree &&
        provenance
      ) {
        const cleanup = await this.discardProvisionedWorktree(worktree, provenance, workspace);
        for (const warning of cleanup.warnings) {
          params.onProgress?.(warning);
        }
        if (cleanup.removed) {
          try {
            await this.stateRepo.save(checkpointBeforeProvisioning);
          } catch {
            params.onProgress?.(
              `The worktree was removed, but the checkpoint could not be restored: ${this.stateRepo.getStateFilePath()}. It may still describe the removed worktree.`
            );
          }
        }
      }

      // The guard's own refusal, never a cleanup error (#420 AC4).
      throw err;
    }

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
   * Commit mode: drafts Conventional Commit and executes confirmation gate.
   */
  private async executeCommitMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    workspace: string
  ): Promise<RunLifecycleResult> {
    // Issue #301: `codeloop commit` must commit the tree it was pointed at. It
    // never provisions — a commit is not the start of an implementation.
    const worktree = sm.worktree ?? null;
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
      // Only assert explicit confirmation when the caller asked for it; passing a
      // literal `false` short-circuits the gate and silently cancels the commit.
      confirmed: bypass ? true : undefined,
      bypassConfirmation: bypass,
      staged: params.staged,
      dryRun: params.dryRun,
      issue: sm.issue,
      interactive: params.interactive,
      workspaceDir: activeWorkspace,
      rootWorkspaceDir: workspace,
      createPr: params.createPr
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
    workspace: string,
    preflightResult?: PreFlightCheckResult
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
          mode: sm.mode,
          issue: sm.issue,
          title: params.title,
          type: params.type,
          dryRun: true,
          configPath: params.configPath,
          skipDiscovery: params.skipDiscovery,
          planPath: params.planPath,
          planDir: params.planDir,
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
        mode: sm.mode,
        issue: sm.issue,
        title: params.title,
        type: params.type,
        dryRun: params.dryRun,
        configPath: params.configPath,
        skipDiscovery: params.skipDiscovery,
        planPath: params.planPath,
        planDir: params.planDir,
        workspaceDir: workspace
      });

      sm = planResult.stateMachine;
      sm.setMode(MODE_YOLO);
      if (!params.dryRun) {
        await this.stateRepo.save(sm.toSnapshot());
      }
    }

    // #234: bug issues are intentionally parked at DISCOVERY for RCA, and YOLO never
    // dispatches subagents inline (`codeloop next` does). Return a checkpointed,
    // actionable park instead of falling through to the quality gates from the wrong
    // stage. Mirrors executeStandardMode's post-planning return (lines 963-986).
    //
    // #237: the park now also holds on RE-ENTRY, when the operator re-ran `yolo`
    // after a first-run park but the discovery report is still an unpopulated
    // scaffold. Issue #379: a first-run bug entry and a re-entry park are both
    // "parked" (both leave outstanding RCA work), so both get the evidence
    // message naming what is missing and which paths were read.
    if (sm.currentStage === STAGE_DISCOVERY) {
      return {
        success: true, // deliberate halt, not a failure
        mode: MODE_YOLO,
        currentStage: STAGE_DISCOVERY,
        stateMachine: sm,
        planResult,
        message:
          planResult?.discoveryParked === true
            ? this.formatDiscoveryParkMessage(planResult, sm.pausedAtGate)
            : withRecordedPauseHint(NOTE_YOLO_PARKED_AT_DISCOVERY, sm.pausedAtGate)
      };
    }

    // Resolve isolated worktree for implementation and verification.
    //
    // Issue #301: only a leg that actually STARTS implementation provisions.
    // YOLO A4 keeps its PLAN/APPROVAL provisioning; a YOLO re-entry at
    // REVIEW/COMMIT honours the descriptor already on the checkpoint instead of
    // creating a second worktree.
    const hadDescriptor = Boolean(sm.worktree);
    const provision = this.shouldProvisionWorktree(sm.currentStage, MODE_YOLO);
    const worktree = provision
      ? await this.resolveWorktree(sm, params, workspace)
      : (sm.worktree ?? null);
    const activeWorkspace = worktree ? worktree.worktreePath : workspace;

    if (sm.currentStage === STAGE_PLAN || sm.currentStage === STAGE_APPROVAL) {
      // Issue #301: a worktree provisioned by THIS leg is torn down when the
      // leg fails, so a bad plan cannot leave an orphan worktree DIRECTORY
      // behind. The branch it created is NOT deleted (issue #420: only the
      // implement-mode leg has provenance-aware branch cleanup). The operator's
      // failure stays the plan error — never the cleanup.
      try {
        implResult = await this.startImplementationUseCase.execute({
          issue: sm.issue,
          planPath: params.planPath,
          planDir: params.planDir,
          configPath: params.configPath,
          dryRun: params.dryRun,
          // Issue #247: forward the tri-state `worktree === false` (`--no-worktree`)
          // across the boundary so StartImplementationUseCase's `skipWorktree`
          // guardrail really short-circuits instead of re-provisioning through the
          // adopt path. `resolveWorktree` (above) remains the outer layer.
          noWorktree: params.worktree === false,
          workspaceDir: activeWorkspace,
          hasMergeConflicts: preflightResult?.hasMergeConflicts,
          mergeBaseBranch: preflightResult?.candidateBaseBranch
        });
      } catch (err: unknown) {
        if (!hadDescriptor && worktree) {
          await this.teardownWorktree(worktree, workspace);
          try {
            sm.setWorktree(null);
            await this.stateRepo.save(sm.toSnapshot());
          } catch {
            // Best effort: the run fails with the leg's own error.
          }
        }
        throw err;
      }

      sm = implResult.stateMachine;
    }

    // Issue #259: the YOLO fast-path PREPARES an implementation but never
    // dispatches the implementer subagent, so the gates used to certify the
    // untouched baseline and the pipeline advanced to COMMIT with an empty
    // diff. Measure the working tree BEFORE the gates run: when it contains no
    // implementation, park at IMPLEMENT instead of certifying nothing.
    //
    // The probe answers exactly one question — "is there an implementation?" —
    // and that question is only meaningful at the IMPLEMENT -> QUALITY_GATE
    // boundary. A re-run of the gates from QUALITY_GATE/COMMIT/COMPLETED
    // answers it implicitly: the pipeline only got there over a tree that
    // carried an implementation. So the probe runs exactly where its answer
    // can change the outcome, and nowhere else.
    const implementationDiff =
      sm.currentStage === STAGE_IMPLEMENT
        ? await this.probeImplementationDiff(sm, params, activeWorkspace)
        : null;

    // A verdict that carries a `probeError` is NOT a verdict: the probe could
    // not read the tree (no git, not a repository, an unreadable directory).
    // The run then keeps its pre-existing behaviour instead of parking on an
    // absence of information.
    const implementationVerdict =
      implementationDiff !== null && implementationDiff.probeError === null
        ? implementationDiff
        : null;

    if (implementationVerdict && !implementationVerdict.hasChanges) {
      // A park performs NO `StateMachine.transition()`: `IMPLEMENT -> IMPLEMENT`
      // is not a legal transition, and the stage was never advanced, so nothing
      // was reverted. The park reason lives in the result message and in the
      // returned verdict; the persisted stage + `updatedAt` record the halt.

      // Issue #259 (S10): the plan the fast-path actually implements. The
      // planner is never dispatched either, so the plan IS the tool's own
      // blank scaffold — and an implementer directive that points at an empty
      // plan is a false instruction. An ABSENT implementation result is not a
      // verdict (the same rule as `probeError`): never refuse on absent
      // information.
      //
      // Issue #263: when the branch's own changes could not be MEASURED, the
      // park must say that — never "the working tree is unchanged relative to
      // <base>", which would be a claim the probe cannot support. The
      // plan-empty advisory belongs to the measured case only; the operator's
      // first problem is that the tree cannot be certified.
      const unmeasurable = (implementationVerdict.measurementError ?? null) !== null;

      // Issue #267: a RE-RUN at IMPLEMENT never calls StartImplementation, so
      // `implResult` is absent. Resolve and read the plan anyway — otherwise
      // the second park could not tell the operator the plan is STILL blank.
      let planContentAtPark = implResult?.planContent ?? '';
      let resolvedPlanPath = implResult?.planPath ?? '';
      if (!implResult && this.planGenerator) {
        try {
          const resolved = this.planGenerator.resolvePlanFile({
            issue: sm.issue,
            planPath: sm.planPath ?? undefined,
            planDir: sm.planDir
          });
          if (resolved) {
            resolvedPlanPath = resolved.planPath;
            planContentAtPark = this.planGenerator.readPlanDocument(resolved.planPath);
          }
        } catch {
          // Unreadable is not evidence of a blank plan; fall through.
        }
      }
      const planIsEmpty = planContentAtPark.length > 0 && !isPlanContentSubstantive(planContentAtPark);
      const planPath = resolvedPlanPath || '(the scaffolded plan)';

      // A measured, blank-plan park is recorded so a repeat is distinguishable
      // from the first occurrence (AC-A5). An unmeasurable park is a DIFFERENT
      // problem and must not consume this counter.
      if (planIsEmpty && !unmeasurable) {
        sm.recordPlanEmptyPark();
      }
      const planParkCount = sm.planEmptyParkCount;

      await this.persistCheckpoint(sm, params.dryRun);

      return {
        success: true, // a deliberate, checkpointed park — exactly like the DISCOVERY park
        mode: MODE_YOLO,
        currentStage: STAGE_IMPLEMENT,
        stateMachine: sm,
        planResult,
        implementationResult: implResult,
        worktree,
        implementationHalted: true,
        implementationDiff,
        implementationPlanEmpty: unmeasurable ? false : planIsEmpty,
        implementationPlanParkCount: planIsEmpty && !unmeasurable ? planParkCount : undefined,
        message: unmeasurable
          ? NOTE_YOLO_NO_IMPLEMENTATION_UNMEASURABLE.replace(
              '{baseRef}',
              implementationVerdict.baseRef
            ).replace('{error}', implementationVerdict.measurementError!)
          : planIsEmpty
            ? (planParkCount >= PLAN_EMPTY_PARK_REPEAT_THRESHOLD
                ? NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN_REPEAT.replace(
                    '{baseRef}',
                    implementationVerdict.baseRef
                  )
                    .replace('{planPath}', planPath)
                    .replace('{count}', String(planParkCount))
                : NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN.replace(
                    '{baseRef}',
                    implementationVerdict.baseRef
                  ).replace('{planPath}', planPath))
            : NOTE_YOLO_NO_IMPLEMENTATION.replace('{baseRef}', implementationVerdict.baseRef)
      };
    }

    // #234: an unattended run must never depend on RunQualityGateUseCase's
    // InvalidTransitionError for control flow. Whitelist = exactly the source
    // stages that use case accepts (run-quality-gate.ts:170-185).
    const gatesAllowed =
      sm.currentStage === STAGE_IMPLEMENT ||
      sm.currentStage === STAGE_QUALITY_GATE ||
      sm.currentStage === STAGE_COMMIT ||
      sm.currentStage === STAGE_COMPLETED;

    if (!gatesAllowed) {
      await this.persistCheckpoint(sm, params.dryRun);
      return {
        success: false,
        mode: MODE_YOLO,
        currentStage: sm.currentStage,
        stateMachine: sm,
        planResult,
        implementationResult: implResult,
        worktree,
        message: `YOLO fast-path halted before quality gates: stage '${sm.currentStage}' cannot run gates (requires IMPLEMENT/QUALITY_GATE/COMMIT/COMPLETED). State is checkpointed — run \`codeloop next\` for the next directive or \`codeloop resume\` to clear a pause.`
      };
    }

    // B. Quality Gates
    const qgResult = await this.runQualityGateUseCase.execute({
      issue: sm.issue,
      planPath: params.planPath ?? sm.planPath,
      planDir: params.planDir,
      commands: params.commands,
      timeoutSeconds: params.timeoutSeconds,
      dryRun: params.dryRun,
      configPath: params.configPath,
      workspaceDir: activeWorkspace,
      implementationDiff: implementationVerdict
    });

    sm = qgResult.stateMachine;

    if (!qgResult.passed) {
      // Issue #259 (defence in depth): a VACUOUS verdict is a REFUSAL, not a
      // failure. Nothing was executed, nothing was reverted (the stage was
      // never advanced), and the verdict must NEVER consume a gate retry —
      // least of all trip the circuit breaker. This branch therefore precedes
      // the breaker check below.
      if (qgResult.vacuous === true) {
        return {
          success: true,
          mode: MODE_YOLO,
          currentStage: sm.currentStage,
          stateMachine: sm,
          planResult,
          implementationResult: implResult,
          qualityGateResult: qgResult,
          worktree,
          implementationDiff: qgResult.implementationDiff ?? implementationDiff,
          message: NOTE_GATES_VACUOUS_YOLO
        };
      }

      const config = this.configRepo.loadConfig({ customPath: params.configPath, cwd: activeWorkspace });
      const maxRetries = config.circuitBreakers?.maxGateRetries ?? DEFAULT_CB_MAX_GATE_RETRIES;
      const actionOnTrip = config.circuitBreakers?.actionOnTrip ?? CB_ACTION_PAUSE_FOR_HUMAN;

      if (sm.implementToGateLoops >= maxRetries) {
        return this.handleCircuitBreakerTrip(
          sm,
          'qualityGateRetries',
          maxRetries,
          sm.implementToGateLoops,
          actionOnTrip,
          'Quality gates failed repeatedly.',
          params.dryRun
        );
      }

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

    // #234: same wrong-stage defense as the gate guard above. Whitelist = exactly
    // the source stages RunReviewUseCase accepts (run-review.ts:216-225). After a
    // passing gate run this is structurally unreachable; it exists so an anomalous
    // stage checkpoints with guidance instead of throwing.
    const reviewAllowed =
      sm.currentStage === STAGE_QUALITY_GATE ||
      sm.currentStage === STAGE_REVIEW ||
      sm.currentStage === STAGE_COMPLETED;

    if (!reviewAllowed) {
      await this.persistCheckpoint(sm, params.dryRun);
      return {
        success: false,
        mode: MODE_YOLO,
        currentStage: sm.currentStage,
        stateMachine: sm,
        planResult,
        implementationResult: implResult,
        worktree,
        message: `YOLO fast-path halted before AI review: stage '${sm.currentStage}' cannot run review (requires QUALITY_GATE/REVIEW/COMPLETED). State is checkpointed — run \`codeloop next\` for the next directive or \`codeloop resume\` to clear a pause.`
      };
    }

    // C. AI PR Review
    const reviewResult = await this.runReviewUseCase.execute({
      issue: sm.issue,
      planPath: params.planPath ?? sm.planPath,
      planDir: params.planDir,
      standardsPath: params.standardsPath,
      userInstructions: params.userInstructions,
      workingDiff: params.workingDiff,
      reviewOutput: params.reviewOutput,
      staged: params.staged,
      baseRef: params.baseRef,
      dryRun: params.dryRun,
      configPath: params.configPath,
      interactive: params.interactive,
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
        rootWorkspaceDir: workspace,
        createPr: params.createPr
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

    const yoloMessage =
      reviewResult.verdict.status === VERDICT_SKIPPED
        ? 'YOLO pipeline passed gates; AI review skipped (advisory). Paused at COMMIT gate.'
        : 'YOLO pipeline passed gates and review. Paused at COMMIT gate.';

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
      message: yoloMessage
    };
  }

  /**
   * Standard mode: continuous development loop with human approval gates at APPROVAL and COMMIT.
   */
  private async executeStandardMode(
    sm: StateMachine,
    params: RunLifecycleParams,
    commitAfter: boolean,
    workspace: string,
    preflightResult?: PreFlightCheckResult
  ): Promise<RunLifecycleResult> {
    // 1. If at INITIALIZED or DISCOVERY: run planning and halt at APPROVAL gate
    if (sm.currentStage === STAGE_INITIALIZED || sm.currentStage === STAGE_DISCOVERY) {
      const planResult = await this.startPlanningUseCase.execute({
        mode: sm.mode,
        issue: sm.issue,
        title: params.title,
        type: params.type,
        dryRun: params.dryRun,
        configPath: params.configPath,
        skipDiscovery: params.skipDiscovery,
        planPath: params.planPath,
        planDir: params.planDir,
        workspaceDir: workspace
      });

      const isApproval = planResult.stateMachine.currentStage === STAGE_APPROVAL;
      return {
        success: true,
        mode: MODE_STANDARD,
        currentStage: planResult.stateMachine.currentStage,
        stateMachine: planResult.stateMachine,
        pausedAtGate: isApproval ? GATE_APPROVAL : undefined,
        planResult,
        message:
          planResult.discoveryParked === true
            ? this.formatDiscoveryParkMessage(planResult)
            : isApproval
              ? NOTE_PAUSED_APPROVAL_GATE
              : `Pipeline advanced to ${planResult.stateMachine.currentStage}.`
      };
    }

    // Issue #278: a finished standard run returns BEFORE `resolveWorktree`, so
    // no path through standard mode can provision a worktree for a COMPLETED
    // checkpoint (the live defect: a bare `codeloop` re-created a task worktree
    // from a stale, already-merged branch).
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

    // Issue #301 (extends #278 to the rest of the pipeline): provisioning a
    // worktree is a consequence of STARTING IMPLEMENTATION, not of running the
    // CLI. A bare `codeloop` at PLAN/IMPLEMENT/QUALITY_GATE/REVIEW is a read:
    // it honours the descriptor already on the checkpoint (or runs from the
    // workspace root) and writes NOTHING — the checkpoint stays byte-identical.
    const hadDescriptor = Boolean(sm.worktree);
    const provision = this.shouldProvisionWorktree(sm.currentStage, MODE_STANDARD);
    const worktree = provision
      ? await this.resolveWorktree(sm, params, workspace)
      : (sm.worktree ?? null);
    const activeWorkspace = worktree ? worktree.worktreePath : workspace;

    // 2. If at APPROVAL: human review has occurred, start implementation
    let implResult: StartImplementationResult | undefined;
    if (sm.currentStage === STAGE_APPROVAL) {
      // Issue #301: a worktree provisioned by THIS leg is torn down when the
      // leg fails (a missing/invalid approved plan), so the failed run leaves
      // no orphan DIRECTORY behind. The branch it created is NOT deleted
      // (issue #420: only the implement-mode leg has provenance-aware branch
      // cleanup). The plan error is what the operator sees.
      try {
        implResult = await this.startImplementationUseCase.execute({
          issue: sm.issue,
          planPath: params.planPath,
          planDir: params.planDir,
          userInstructions: params.userInstructions,
          configPath: params.configPath,
          dryRun: params.dryRun,
          // Issue #247: forward the tri-state `worktree === false` (`--no-worktree`)
          // across the boundary so StartImplementationUseCase's `skipWorktree`
          // guardrail really short-circuits instead of re-provisioning through the
          // adopt path. `resolveWorktree` (above) remains the outer layer.
          noWorktree: params.worktree === false,
          workspaceDir: activeWorkspace,
          hasMergeConflicts: preflightResult?.hasMergeConflicts,
          mergeBaseBranch: preflightResult?.candidateBaseBranch
        });
      } catch (err: unknown) {
        if (!hadDescriptor && worktree) {
          await this.teardownWorktree(worktree, workspace);
          try {
            sm.setWorktree(null);
            await this.stateRepo.save(sm.toSnapshot());
          } catch {
            // Best effort: the run fails with the leg's own error.
          }
        }
        throw err;
      }

      sm = implResult.stateMachine;
    }

    // 3. If at IMPLEMENT: run quality gates
    let qgResult: QualityGateRunResult | undefined;
    if (sm.currentStage === STAGE_IMPLEMENT) {
      // Issue #259: the standard loop does NOT park — the operator may
      // legitimately run the gates on a tree they have not committed — but the
      // gate still receives the implementation-evidence verdict, so a gate
      // over an unchanged tree is reported as VACUOUS instead of certifying
      // the untouched baseline.
      //
      // A verdict that carries a `probeError` is NOT a verdict (the tree could
      // not be read), so the gate keeps its pre-existing behaviour.
      const implementationDiff = await this.probeImplementationDiff(sm, params, activeWorkspace);
      const implementationVerdict =
        implementationDiff.probeError === null ? implementationDiff : null;

      qgResult = await this.runQualityGateUseCase.execute({
        issue: sm.issue,
        planPath: params.planPath ?? sm.planPath,
        planDir: params.planDir,
        commands: params.commands,
        timeoutSeconds: params.timeoutSeconds,
        dryRun: params.dryRun,
        configPath: params.configPath,
        workspaceDir: activeWorkspace,
        implementationDiff: implementationVerdict
      });

      sm = qgResult.stateMachine;

      if (!qgResult.passed) {
        // Issue #259: a VACUOUS verdict is NOT a failure. The standard loop
        // must not start failing on an unchanged tree, and it must never
        // claim "Quality gates failed" / "reverted to IMPLEMENT" — nothing
        // ran and nothing was reverted.
        if (qgResult.vacuous === true) {
          return {
            success: true,
            mode: MODE_STANDARD,
            currentStage: sm.currentStage,
            stateMachine: sm,
            implementationResult: implResult,
            qualityGateResult: qgResult,
            worktree,
            implementationDiff: qgResult.implementationDiff ?? implementationDiff,
            message: NOTE_GATES_VACUOUS_STANDARD.replace(
              '{baseRef}',
              (qgResult.implementationDiff ?? implementationDiff).baseRef
            )
          };
        }

        const config = this.configRepo.loadConfig({ customPath: params.configPath, cwd: activeWorkspace });
        const maxRetries = config.circuitBreakers?.maxGateRetries ?? DEFAULT_CB_MAX_GATE_RETRIES;
        const actionOnTrip = config.circuitBreakers?.actionOnTrip ?? CB_ACTION_PAUSE_FOR_HUMAN;

        if (sm.implementToGateLoops >= maxRetries) {
          return this.handleCircuitBreakerTrip(
            sm,
            'qualityGateRetries',
            maxRetries,
            sm.implementToGateLoops,
            actionOnTrip,
            'Quality gates failed repeatedly.',
            params.dryRun
          );
        }

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
        planPath: params.planPath ?? sm.planPath,
        planDir: params.planDir,
        standardsPath: params.standardsPath,
        userInstructions: params.userInstructions,
        workingDiff: params.workingDiff,
        reviewOutput: params.reviewOutput,
        staged: params.staged,
        baseRef: params.baseRef,
        dryRun: params.dryRun,
        configPath: params.configPath,
        interactive: params.interactive,
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
          rootWorkspaceDir: workspace,
          createPr: params.createPr
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

      if (params.interactiveCommit && params.interactive !== false && this.confirmationPrompt) {
        const execResult = await this.executeCommitUseCase.execute({
          commitMessage: draftResult.commitMessage,
          bypassConfirmation: false,
          interactive: params.interactive,
          staged: params.staged,
          dryRun: params.dryRun,
          issue: sm.issue,
          workspaceDir: activeWorkspace,
          rootWorkspaceDir: workspace,
          createPr: params.createPr
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

  private async handleCircuitBreakerTrip(
    sm: StateMachine,
    breaker: string,
    limit: number,
    actual: number,
    action: string,
    extraMessage?: string,
    dryRun?: boolean
  ): Promise<RunLifecycleResult> {
    const baseMsg = `Circuit breaker '${breaker}' tripped: exceeded limit ${limit} (actual: ${actual}).`;
    const fullMsg = extraMessage ? `${baseMsg} ${extraMessage}` : baseMsg;

    if (action === CB_ACTION_ABORT) {
      throw new CircuitBreakerTrippedError(breaker, limit, actual, action, fullMsg);
    }

    if (action === CB_ACTION_WARN) {
      return {
        success: false,
        mode: sm.mode,
        currentStage: sm.currentStage,
        stateMachine: sm,
        message: `[WARNING] ${fullMsg}`
      };
    }

    // Default: pause_for_human.
    // The pause MUST be persisted (issue #218 AC4): an in-memory pause alone leaves
    // `pausedAtGate: null` on disk, so the next invocation restarts the stage from
    // scratch with no context.
    sm.pauseAtGate(GATE_CIRCUIT_BREAKER);
    await this.persistCheckpoint(sm, dryRun);

    return {
      success: false,
      mode: sm.mode,
      currentStage: sm.currentStage,
      stateMachine: sm,
      pausedAtGate: GATE_CIRCUIT_BREAKER,
      message: `${fullMsg} ${NOTE_PAUSED_CIRCUIT_BREAKER_GATE}: state persisted — re-run after the blocking condition clears.`
    };
  }

  /**
   * Shared checkpoint helper. A storage failure must never replace the lifecycle
   * diagnostic that triggered it (a read-only mount or full disk must not mask a
   * circuit-breaker trip or a quota halt).
   */
  private async persistCheckpoint(sm: StateMachine, dryRun?: boolean): Promise<void> {
    if (dryRun) {
      return;
    }
    try {
      await this.stateRepo.save(sm.toSnapshot());
    } catch {
      // Non-fatal by design — the in-memory pause and the returned diagnostic stand.
    }
  }
}
