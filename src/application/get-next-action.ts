/**
 * agyloop - GetNextActionUseCase (Application Layer)
 *
 * Inspects pipeline checkpoint state and generates the exact next operational directive,
 * including copy-paste-ready `invoke_subagent` JSON payloads populated with issue context,
 * active worktree paths, and model tier assignments.
 *
 * Strict Hexagonal Architecture: zero direct I/O, depends only on Domain and Ports.
 */

import {
  StateMachine,
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
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  ROLE_TRIAGE,
  ROLE_DISCOVERY,
  ROLE_TITLE_PLANNER,
  ROLE_TITLE_IMPLEMENTER,
  ROLE_TITLE_GATE,
  ROLE_TITLE_REVIEWER,
  ROLE_TITLE_TRIAGE,
  ROLE_TITLE_DISCOVERY,
  MODE_YOLO,
  VERDICT_APPROVED,
  VERDICT_SKIPPED,
  VERDICT_CHANGES_REQUESTED,
  IssueNumber,
  ValidationError,
  parseIssueToken,
  MAX_IMPLEMENT_GATE_LOOPS,
  MAX_REVIEW_DISPATCH_LOOPS,
  DispatchCounterKind,
  formatDispatchCounterUnrecorded,
  GATE_TRIAGE,
  NOTE_PAUSED_TRIAGE_GATE,
  NOTE_RESTARTED_FROM_COMPLETED,
  NOTE_TRIAGE_GATE_EXIT_CONDITION,
  // Issue #351: the gate also ends when the PR does; one marker and one
  // renderer so the history note and the idle report cannot drift.
  TRIAGE_EXIT_PULL_REQUEST_TERMINAL,
  formatTriageGateEndedNote,
  NOTE_REVIEW_GATE_EXIT_CONDITION,
  NOTE_REVIEW_DISPATCH_ORDINAL,
  NOTE_REVIEW_DISPATCH_CAP,
  NOTE_WORKTREE_MISSING_REPROVISION,
  NOTE_DISCOVERY_ADVANCE_CONDITION,
  NOTE_PLAN_ADVANCE_CONDITION,
  NOTE_DISCOVERY_DISPATCH_ORDINAL,
  NOTE_PLAN_DISPATCH_ORDINAL,
  NOTE_BLANK_PLAN_DISPATCH_PLANNER,
  // Issue #327: the IMPLEMENT stage's completion condition, state sentences,
  // re-dispatch record and advancing command.
  NOTE_IMPLEMENT_ADVANCE_CONDITION,
  NOTE_IMPLEMENT_PRESENT,
  NOTE_IMPLEMENT_PRESENT_REMEDIATION_PENDING,
  NOTE_IMPLEMENT_GATE_FAILED,
  NOTE_IMPLEMENT_ABSENT,
  NOTE_IMPLEMENT_UNVERIFIED,
  NOTE_IMPLEMENT_DISPATCH_ORDINAL,
  formatGateFailureRemediationPayload,
  // Issue #337: a met completion condition ends the stage, so the directive
  // names the advancing command instead of inviting another dispatch.
  NOTE_DISCOVERY_COMPLETE,
  NOTE_PLAN_COMPLETE,
  NOTE_IDLE_SUMMARY,
  STATUS_FAILED,
  formatGateEvidenceFiledNote,
  formatGateFailedRetryNote,
  resolveGateRound,
  GateResultReport,
  formatDiscoveryAdvanceCommand,
  formatPlanAdvanceCommand,
  formatImplementAdvanceCommand,
  formatPlanReapprovalRecovery,
  formatReviewVerdictChannelCommand,
  formatReviewVerdictChannelNote,
  formatGateReportChannelNote,
  formatTriageActionList,
  formatTriageActionSideEffects,
  TriageDisposition,
  formatTriageDispositionLine,
  assertNotRootWorkspace,
  isRootWorkspace,
  isPlanContentSubstantive,
  PLAN_INTEGRITY_MISMATCH,
  PLAN_INTEGRITY_MISSING,
  MSG_PLAN_MODIFIED_AFTER_APPROVAL,
  MSG_PLAN_APPROVED_MISSING,
  MSG_SMOKE_PROTOCOL_NOT_EXECUTABLE,
  formatGateTargetContractViolations,
  GATE_COMMAND_PRECEDENCE,
  DiscoveryReport,
  isDiscoveryPlanDocument
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  GitHubGateway,
  WorktreeManagerPort,
  BuildDetectorPort,
  PullRequestReviewComment,
  CritiquePort,
  GateReportRepositoryPort,
  // Issue #351: the gate's exit reads the SAME guarded PR lookup that routes
  // INTO it, so the shape is shared rather than re-inferred.
  GitHubPullRequestData
} from '../ports';
import { ResolveSubagentUseCase } from './resolve-subagent';
import { resolveGateVerification, GateVerification } from './resolve-gate-verification';
import { resolveCompletedReentry, resolveTriageReentry } from './lifecycle-reentry-policy';
import { classifyPrFeedback, feedbackKeysOf } from './triage-feedback';
import type { ImplementationDiff, ImplementationProbe } from './detect-implementation-diff';
import type { InferBaseBranchUseCase } from './infer-base-branch';

export interface GetNextActionParams {
  readonly workspaceDir?: string;
  readonly configPath?: string | null;
  readonly issue?: number | string | null;
  /**
   * Explicit opt-in (issue #237). Only this flag authorises `next` to destroy a
   * COMPLETED checkpoint: `reset()` it and re-open at DISCOVERY. Without it,
   * `next` on a COMPLETED checkpoint is a pure read plus at most the
   * TRIAGE route that open PR review feedback justifies.
   */
  readonly restart?: boolean;
  /**
   * Preview without writing (issue #301, absorbing #304). Honoured: the reads
   * run, every suppressed write is declared in `wouldWrite`, and the
   * checkpoint is never touched.
   */
  readonly dryRun?: boolean;
}

/**
 * Result of probing an open PR for unaddressed review feedback.
 *
 * Fields are `readonly` and the shape is internal to this use case: it carries
 * only what the TRIAGE route needs, and it exists so `detectOpenReviewFeedback`
 * can fail closed (return `null`) without a sentinel "no feedback" object that
 * a caller could mistake for feedback.
 */
interface OpenReviewFeedback {
  readonly prNumber: number | null;
  readonly commentCount: number;
  /** `- [author]: body` lines, same format as run-lifecycle.ts's TRIAGE route. */
  readonly payload: string;
}

/**
 * The DISCOVERY report state projected into the directive (issue #320).
 *
 * Internal to this use case: it is the one scored artefact the directive both
 * reports and (as a path) hands to the discovery prompt, so the operator can
 * tell "keep dispatching discovery" from "advance with `codeloop plan`".
 */
interface DiscoveryReportState {
  readonly populated: boolean;
  /** The discovery-shaped document that was read; null when none resolved. */
  readonly path: string | null;
  /** `DiscoveryReport.describeMissingEvidence()` when blank; null otherwise. */
  readonly missingEvidence: string | null;
}

export interface SubagentInvocationItem {
  readonly TypeName: string;
  readonly Role: string;
  readonly Model: string;
  readonly Workspace: string;
  readonly Prompt: string;
}

export interface SubagentInvocationPayload {
  readonly Subagents: readonly SubagentInvocationItem[];
}

export interface NextActionResult {
  readonly currentStage: string;
  readonly nextStage: string;
  /**
   * The KIND of action this directive asks for (issue #337).
   *
   * - `subagent`: a subagent may be dispatched now — the only actionable kind;
   * - `human_gate`: the pipeline waits on a person;
   * - `advance`: the stage's completion condition is MET; run the named
   *   command yourself (no payload, no dispatch);
   * - `completed` / `preflight`: idle and pre-flight reports, nothing to run.
   */
  readonly actionType: 'subagent' | 'human_gate' | 'completed' | 'preflight' | 'advance';
  readonly role?: string;
  readonly title: string;
  readonly description: string;
  readonly worktreePath?: string | null;
  readonly baseBranch?: string | null;
  readonly taskBranch?: string | null;
  readonly invocationPayload?: SubagentInvocationPayload | null;
  readonly humanSummary: string;
  /**
   * The recorded re-dispatch count for the current REVIEW round (issue #272).
   * Additive and optional; populated on every REVIEW return.
   */
  readonly reviewDispatchCount?: number;
  /**
   * The recorded re-dispatch count for the current DISCOVERY stage (issue #292).
   */
  readonly discoveryDispatchCount?: number;
  /** The recorded re-dispatch count for the current PLAN stage (issue #292). */
  readonly planDispatchCount?: number;
  /**
   * The recorded re-dispatch count for the current IMPLEMENT stage
   * (issue #327). Additive and optional; populated only at IMPLEMENT.
   */
  readonly implementationDispatchCount?: number;
  /**
   * Whether an implementation diff exists in the task worktree (issue #327).
   *
   * `true` / `false` only when the existing `detectImplementationDiff` probe
   * could measure the tree; `null` means unverified (absent probe, unreadable
   * tree, or an unmeasurable branch diff). Never inferred from a failed read.
   */
  readonly implementationPresent?: boolean | null;
  /**
   * The DISCOVERY report state (issue #320).
   *
   * `next` used to render a static completion condition and never read the RCA,
   * so a blank and a populated report produced byte-identical directives. These
   * three values project the SAME scored report the gate uses; they are absent
   * when no `PlanGeneratorPort` is injected (nothing to verify).
   */
  readonly discoveryReportPopulated?: boolean;
  /** The discovery-shaped document that was read; null when none resolved. */
  readonly discoveryReportPath?: string | null;
  /** `DiscoveryReport.describeMissingEvidence()` when blank; null otherwise. */
  readonly discoveryReportMissingEvidence?: string | null;
  /**
   * Whether THIS gate round's evidence is filed (issue #337).
   *
   * Present only at QUALITY_GATE when a `GateReportRepositoryPort` was
   * injected: `true` when the loaded block certifies the checkpoint's current
   * round (the same formula `transition REVIEW` uses), `false` when nothing (or
   * only a stale block) is on record. Omitted when the evidence could not be
   * measured.
   */
  readonly gateEvidenceFiled?: boolean;
  /** True when the IMPLEMENT directive is the PLANNER because the plan is blank. */
  readonly planBlank?: boolean;
  /**
   * The recorded provenance of the last review verdict (issues #297/#303).
   * Additive and optional; populated on the COMMIT return only, so `next --json`
   * can audit `critique-report` vs `skipped` vs `reviewer-output`.
   */
  readonly lastReviewSource?: string | null;
  readonly lastReviewCritiqueVerified?: boolean;
  /**
   * The review round whose remediation is attached to the IMPLEMENT prompt
   * (issue #313).
   *
   * Present ONLY when the latest recorded review asked for changes and its
   * remediation block was rendered; `null` when the round number was not
   * recorded. Purely additive: absent from every other directive.
   */
  readonly reviewRemediationRound?: number | null;
  /**
   * True when this read was a `--dry-run` preview (issue #301).
   *
   * Always present: a query that can write must state whether it did.
   */
  readonly dryRun: boolean;
  /**
   * The checkpoint writes this read would have made, in operator language.
   *
   * Empty on a real read; populated on a `--dry-run` preview so the operator
   * sees exactly what the write set is (#301, absorbing #304).
   */
  readonly wouldWrite: readonly string[];
}

/**
 * A directive as built by the use case internals. The public `execute()` adds
 * the read/write contract (`dryRun`, `wouldWrite`), so every internal return
 * is free of bookkeeping and the contract is impossible to omit.
 */
type DirectiveResult = Omit<NextActionResult, 'dryRun' | 'wouldWrite'>;

export class GetNextActionUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator?: PlanGeneratorPort;
  private readonly githubGateway?: GitHubGateway;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;
  private readonly worktreeManager?: WorktreeManagerPort;
  private readonly buildDetector?: BuildDetectorPort;
  private readonly inferBaseBranchUseCase?: InferBaseBranchUseCase;
  /**
   * The implementation-evidence probe (issue #327). `next` consults it at
   * IMPLEMENT to tell "nothing implemented yet" from "implementation present",
   * using the SAME probe the YOLO path and the gate already use (#259).
   */
  private readonly implementationProbe?: ImplementationProbe;

  /** The filed gate evidence `next` reads at QUALITY_GATE (issue #337). */
  private readonly gateReportRepo?: GateReportRepositoryPort;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator?: PlanGeneratorPort,
    githubGateway?: GitHubGateway,
    resolveSubagentUseCase?: ResolveSubagentUseCase,
    worktreeManager?: WorktreeManagerPort,
    buildDetector?: BuildDetectorPort,
    inferBaseBranchUseCase?: InferBaseBranchUseCase,
    // Issue #314: the REVIEW directive resolves Tier 1's binary through this
    // port. Without it the prompt fell back to a hardcoded ~/.local/bin path
    // that `codeloop critique install` never writes.
    critiquePort?: CritiquePort,
    // Issue #327: the implementation-evidence probe. Optional so every existing
    // call site and test keeps working; without it the directive reports the
    // implementation state as UNVERIFIED rather than inventing a claim.
    implementationProbe?: ImplementationProbe,
    // Issue #337: the gate evidence the QUALITY_GATE directive must READ before
    // it tells the operator to file it. Optional: without it the directive
    // keeps its historical dispatch + filing note (unverified).
    gateReportRepo?: GateReportRepositoryPort
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.githubGateway = githubGateway;
    this.resolveSubagentUseCase =
      resolveSubagentUseCase ??
      new ResolveSubagentUseCase(configRepo, githubGateway, undefined, critiquePort, buildDetector);
    this.worktreeManager = worktreeManager;
    this.buildDetector = buildDetector;
    this.inferBaseBranchUseCase = inferBaseBranchUseCase;
    this.implementationProbe = implementationProbe;
    this.gateReportRepo = gateReportRepo;
  }

  public async execute(params: GetNextActionParams = {}): Promise<NextActionResult> {
    const wouldWrite: string[] = [];
    const directive = await this.buildDirective(params, wouldWrite);
    return {
      ...directive,
      dryRun: params.dryRun === true,
      wouldWrite
    };
  }

  private async buildDirective(
    params: GetNextActionParams,
    wouldWrite: string[]
  ): Promise<DirectiveResult> {
    const cwd = params.workspaceDir || process.cwd();
    const snapshot = await this.stateRepo.load();
    const sm = snapshot ? StateMachine.fromSnapshot(snapshot) : StateMachine.createInitial();

    // Issue #301 (absorbing #304): a query never manufactures a checkpoint. A
    // write requires a LOADED snapshot, and `--dry-run` suppresses every write
    // while declaring it. `wouldWrite` is the operator-visible declaration.
    const persisted = snapshot !== null;
    const writesEnabled = persisted && params.dryRun !== true;

    const config = this.configRepo.loadConfig({
      customPath: params.configPath,
      cwd
    });

    // Context resolution: explicit issue -> state.issue -> auto-inferred issue.
    // The explicit token goes through the ONE shared grammar (issue #250): the
    // old `IssueNumber.tryFrom` silently degraded a garbage token to "no issue
    // named", which let `next` write a checkpoint for a nonsense issue.
    const explicitToken = parseIssueToken(params.issue);
    if (explicitToken.kind === 'invalid') {
      throw new ValidationError('issue', explicitToken.raw, explicitToken.message);
    }
    const explicitIssue = explicitToken.kind === 'valid' ? explicitToken.issue : null;
    let inferredIssue: number | null = null;

    if (!explicitIssue && !sm.issue) {
      inferredIssue =
        IssueNumber.inferFromPath(sm.worktree?.worktreePath as string | undefined) ??
        IssueNumber.inferFromPath(cwd);
      if (!inferredIssue && sm.worktree?.branch) {
        inferredIssue = IssueNumber.inferFromBranch(sm.worktree.branch);
      }
      if (!inferredIssue && this.worktreeManager && this.worktreeManager.resolveBaseBranch) {
        try {
          const currentBranch = await this.worktreeManager.resolveBaseBranch(cwd);
          inferredIssue = IssueNumber.inferFromBranch(currentBranch);
        } catch {
          // Non-fatal
        }
      }
      if (inferredIssue) {
        if (persisted) {
          sm.setIssue(inferredIssue);
          await this.saveContext(sm, writesEnabled, 'checkpoint: issue (inferred)', wouldWrite);
        }
      }
    }

    let activeIssue = explicitIssue ?? sm.issue ?? inferredIssue;

    // ---- Read-path write contract (issue #237) ------------------------------
    // `codeloop next` is a QUERY. Outside an explicit `--restart` it may write
    // only context fields (issue, baseBranch) and, on a COMPLETED checkpoint
    // with open PR review feedback, route to TRIAGE. It may NEVER advance a
    // stage on its own initiative, and it may NEVER reset a checkpoint.
    //
    // Issue #272 adds ONE more permitted context-field write:
    // `reviewDispatchCount`, recorded when a REVIEW directive is returned so a
    // silently repeated dispatch is observable. It is NOT written while the
    // checkpoint is paused at a gate (`pausedAtGate !== null`): a paused read is
    // not a dispatch. It never advances a stage, and `StateMachine.transition()`
    // resets it when a new REVIEW round begins.
    //
    // Issue #292 extends the same rule to the two early stages:
    // `discoveryDispatchCount` and `planDispatchCount` are context-field writes
    // recorded on a real (non-paused) read, and reset by `transition()` into
    // their stage. They never advance a stage either.
    //
    // The previous implementation inferred operator intent from whether
    // `--issue` merely happened to be supplied, which destroyed COMPLETED
    // checkpoints (planDir, worktree, history, counters) and persisted the
    // forbidden `{ currentStage: "PLAN", planDir: null }` snapshot by reaching
    // `Plan` straight from a reset machine — bypassing TransitionStageUseCase's
    // planDir precondition. The decision now lives in one chokepoint and depends
    // only on explicit intent plus evidence.
    //
    // Issue #351 adds the mirror of that one lifecycle write: a checkpoint at
    // TRIAGE whose pull request is MERGED/CLOSED is advanced to COMPLETED,
    // because the exit condition the directive states would otherwise be a lie.
    // It is the same class of write — evidence-driven, never an invented
    // advance — and it is also declared in `wouldWrite` under `--dry-run`.
    const restartOptIn = params.restart === true;

    if (sm.currentStage === STAGE_COMPLETED) {
      // Probe the CHECKPOINT's own issue, not `activeIssue`.
      //
      // `activeIssue` prefers an explicit `--issue`, so `next --issue 51`
      // against a checkpoint whose issue is 40 resolved 40's checkpoint against
      // 51's PR feedback — routing one task's state on another task's review
      // comments. The checkpoint's own issue is the subject of the decision;
      // `activeIssue` is only the fallback for a task file written before the
      // issue was recorded (`issue: null`), which cannot be resolved from the
      // checkpoint itself.
      const feedbackIssue = sm.issue ?? activeIssue;
      const feedback = feedbackIssue
        ? await this.detectOpenReviewFeedback(feedbackIssue, cwd, sm.triageDisposition)
        : null;
      const decision = resolveCompletedReentry({
        currentStage: sm.currentStage,
        restartOptIn,
        hasOpenReviewFeedback: feedback !== null
      });

      if (decision === 'ROUTE_TRIAGE' && feedback) {
        // Byte-identical to RunLifecycleUseCase's TRIAGE route, now sharing one
        // rule definition (`shouldRouteToTriage`) with it.
        if (sm.canTransition(STAGE_TRIAGE)) {
          sm.setTriagePayload(feedback.payload);
          sm.transition(STAGE_TRIAGE, {
            note: NOTE_PAUSED_TRIAGE_GATE,
            prNumber: feedback.prNumber,
            commentsCount: feedback.commentCount
          });
          // TRIAGE is in HUMAN_WAIT_GATES, so transition() preserves the pause
          // rather than consuming it as a stale mechanical halt.
          sm.pauseAtGate(GATE_TRIAGE);
          await this.saveContext(
            sm,
            writesEnabled,
            'checkpoint: stage TRIAGE (pausedAtGate TRIAGE)',
            wouldWrite
          );
        }
        // Otherwise the COMPLETED case below reports idle — no mutation at all.
      } else if (decision === 'RESTART' && activeIssue !== null) {
        sm.reset(sm.mode, activeIssue);
        // DISCOVERY, never PLAN: the RCA rule (R1) requires either an opt-in or
        // content evidence, and a freshly reset checkpoint has neither. This is
        // why the forbidden `{ PLAN, planDir: null }` snapshot is structurally
        // unreachable from this path, not merely discouraged by convention.
        sm.transition(STAGE_DISCOVERY, { note: NOTE_RESTARTED_FROM_COMPLETED, restart: true });
        await this.saveContext(
          sm,
          writesEnabled,
          'checkpoint: reset + stage DISCOVERY (--restart)',
          wouldWrite
        );
      }
      // REPORT_IDLE_COMPLETED: no mutation whatsoever. A RESTART with a
      // unresolvable issue falls through to the idle report rather than
      // resetting to a null-issue checkpoint, which is why the guard above is
      // `activeIssue !== null`.
    } else if (persisted && explicitIssue !== null && sm.issue !== explicitIssue) {
      // One of the two fields the query path is always permitted to write.
      sm.setIssue(explicitIssue);
      await this.saveContext(sm, writesEnabled, 'checkpoint: issue', wouldWrite);
    }

    // ---- TRIAGE exit (issue #351) ------------------------------------------
    // NOTE_TRIAGE_GATE_EXIT_CONDITION states TWO endings; until now only the
    // disposition one existed, so a merged/closed PR still demanded `resume` +
    // `triage`. The gate now consults the SAME lookup that routes INTO it (#269),
    // and ends by recording COMPLETED — the stage the run actually reached.
    // Fail closed: an unmeasured state (offline, no gateway, no issue) keeps the
    // gate; only a measured MERGED/CLOSED ends it.
    if (sm.currentStage === STAGE_TRIAGE) {
      const triageIssue = sm.issue ?? activeIssue;
      const pr = triageIssue ? await this.findPullRequestOrNull(triageIssue, cwd) : null;
      const triageDecision = resolveTriageReentry({
        currentStage: sm.currentStage,
        pullRequestState: pr?.state ?? null
      });
      if (triageDecision === 'EXIT_TO_COMPLETED' && pr && sm.canTransition(STAGE_COMPLETED)) {
        const prNumber = pr.number ? pr.number : null;
        // The payload belongs to feedback on a PR that no longer awaits an answer
        // (same rule as `triage completed`, triage-pr-comments.ts).
        sm.setTriagePayload(null);
        sm.transition(STAGE_COMPLETED, {
          note: formatTriageGateEndedNote(pr.state, prNumber),
          prNumber,
          prState: pr.state.toUpperCase(),
          triageExit: TRIAGE_EXIT_PULL_REQUEST_TERMINAL
        });
        // COMPLETED is terminal, so transition() consumes the TRIAGE pause
        // (StateMachine.transition); the operator needs no `resume`.
        await this.saveContext(
          sm,
          writesEnabled,
          `checkpoint: stage COMPLETED (triage PR ${pr.state.toUpperCase()})`,
          wouldWrite
        );
      }
    }

    // Issue #301: a read of an ABSENT checkpoint must still report the issue it
    // was asked about. `sm.issue` alone dropped the explicit `--issue`.
    activeIssue = sm.issue ?? explicitIssue ?? inferredIssue;
    if (!sm.baseBranch && activeIssue && this.inferBaseBranchUseCase) {
      try {
        const inference = await this.inferBaseBranchUseCase.execute({
          issueNumber: activeIssue,
          workspaceDir: cwd,
          // Issue #301: the use case persists the inferred branch itself. A
          // query must not let that leak a write past `--dry-run` / an absent
          // checkpoint — the outer `saveContext` is the ONE seam that decides.
          persist: writesEnabled
        });
        if (inference.baseBranch) {
          sm.setBaseBranch(inference.baseBranch);
          await this.saveContext(sm, writesEnabled, 'checkpoint: baseBranch (inferred)', wouldWrite);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[codeloop] Diagnostic: Failed to infer base branch for issue #${activeIssue}: ${errMsg}`);
      }
    }

    const worktreePath = sm.worktree?.worktreePath || null;
    const taskBranch = sm.worktree?.branch || null;
    const baseBranch = sm.baseBranch || 'main';

    switch (sm.currentStage) {
      case STAGE_INITIALIZED: {
        return {
          currentStage: STAGE_INITIALIZED,
          nextStage: STAGE_DISCOVERY,
          actionType: 'preflight',
          title: 'Execute Smart Pre-Flight Discovery',
          description: 'Run pre-flight checks to discover issue metadata, check merged/closed status, and resolve base collector branch.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: `Run pre-flight checks: codeloop transition DISCOVERY${activeIssue ? ` --issue ${activeIssue}` : ''}`
        };
      }

      case STAGE_DISCOVERY: {
        const advanceCommand = formatDiscoveryAdvanceCommand(activeIssue);
        const condition = NOTE_DISCOVERY_ADVANCE_CONDITION;

        // Issue #283: the dispatch needs a CONCRETE target. Without a plan
        // directory the subagent invents its own slug — the defect this issue
        // exists to remove — so `next` names the command that creates the one
        // canonical directory instead of dispatching an unspecified write.
        //
        // Issue #320: DISCOVERY also reports the STATE of the RCA report it
        // resolves. The directive used to be composed from the static condition
        // alone, so a blank and a populated report produced byte-identical
        // output and the operator could not tell the two apart.
        const resolvedPlanDir =
          sm.planDir ??
          (activeIssue &&
          this.planGenerator &&
          typeof this.planGenerator.findPlanDirectory === 'function'
            ? this.planGenerator.findPlanDirectory(cwd, activeIssue)
            : null);

        // Without an injected generator there is nothing to verify, so the
        // pre-existing dispatch behaviour is preserved; with one, an
        // unspecified target is a human gate (never an invented slug).
        if (this.planGenerator && !resolvedPlanDir) {
          return {
            currentStage: STAGE_DISCOVERY,
            nextStage: STAGE_PLAN,
            actionType: 'human_gate',
            title: 'Plan Directory Required',
            description: `The discovery report needs a canonical plan directory, and this checkpoint tracks none. Run \`${advanceCommand}\` to scaffold it (the discovery subagent then receives the exact path). ${condition}`,
            baseBranch,
            taskBranch,
            worktreePath,
            humanSummary: `Run \`${advanceCommand}\` to create the canonical plan directory, then run \`codeloop next\` to dispatch the ${ROLE_TITLE_DISCOVERY}. ${condition}`,
            // Issue #320: a consistent DISCOVERY contract — no report can have
            // been resolved when no directory exists.
            discoveryReportPopulated: false,
            discoveryReportPath: null,
            discoveryReportMissingEvidence: null
          };
        }

        let resolvedDiscoveryPath: string | null = null;
        if (this.planGenerator) {
          const resolved = this.planGenerator.resolvePlanFile({
            projectRoot: cwd,
            issue: activeIssue,
            planDir: resolvedPlanDir,
            stage: STAGE_DISCOVERY
          });
          if (resolved) {
            resolvedDiscoveryPath = resolved.planPath;
          }
        }

        // Project the SAME scored report the gate uses (issue #320). `null`
        // means unverified — no generator was injected.
        const reportState = this.resolveDiscoveryReportState(resolvedDiscoveryPath);

        // Issue #337: a POPULATED report is a met completion condition, so the
        // stage is not dispatchable. Return BEFORE the subagent resolution, the
        // payload and the dispatch counter: a met read writes nothing, and the
        // machine fields finally agree with the prose.
        if (reportState?.populated === true) {
          return {
            currentStage: STAGE_DISCOVERY,
            nextStage: STAGE_PLAN,
            actionType: 'advance',
            title: 'Discovery Complete — Advance to PLAN',
            description: `Report: \`${reportState.path}\`. ${NOTE_DISCOVERY_COMPLETE} ${condition} Advance with \`${advanceCommand}\`.`,
            baseBranch,
            taskBranch,
            worktreePath,
            humanSummary: `${NOTE_DISCOVERY_COMPLETE} Advance with \`${advanceCommand}\`.`,
            discoveryDispatchCount: sm.discoveryDispatchCount,
            discoveryReportPopulated: true,
            discoveryReportPath: reportState.path,
            discoveryReportMissingEvidence: null
          };
        }

        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_DISCOVERY,
          customConfig: config,
          workspaceDir: cwd
        });

        const prompt = this.resolveSubagentUseCase.buildDiscoveryTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: cwd,
          config,
          planDir: resolvedPlanDir,
          // Only a discovery-shaped document may become the `Write ONLY` target
          // (issue #320); with none resolved the prompt names the directory.
          planPath: reportState?.path ?? undefined
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_DISCOVERY,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: prompt
            }
          ]
        };

        if (sm.pausedAtGate === null) {
          sm.recordDiscoveryDispatch();
          await this.persistDispatchCounter(sm, 'discovery', writesEnabled, wouldWrite);
        }

        // State → text (issue #320). Every verified state keeps the static
        // condition (#292's operator contract) and names the advance command;
        // the state clause is what differs.
        const target = reportState?.path ? ` Write ONLY \`${reportState.path}\`.` : '';
        const planDirLabel = resolvedPlanDir ?? cwd;
        let description: string;
        let stateSummary: string;
        if (reportState === null) {
          // Unverified (no generator injected): the historical text, unchanged.
          description = `Execute root-cause analysis and manual smoke testing to produce a discovery report.${target} ${condition} Advance with \`${advanceCommand}\`.`;
          stateSummary = `${condition} Advance with \`${advanceCommand}\` once the report is populated.`;
        } else if (reportState.populated) {
          description = `The discovery report at \`${reportState.path}\` is populated — the completion condition is met. Do not re-dispatch discovery. ${condition} Advance with \`${advanceCommand}\`.`;
          stateSummary = `The discovery report is populated — the completion condition is met; advance with \`${advanceCommand}\`.`;
        } else if (reportState.path) {
          const missing = reportState.missingEvidence
            ? ` Missing evidence: ${reportState.missingEvidence}.`
            : '';
          description = `Execute root-cause analysis and manual smoke testing to produce a discovery report.${target} The discovery report is still blank.${missing} ${condition} Advance with \`${advanceCommand}\` once it is populated.`;
          stateSummary = `The discovery report is still blank.${missing} ${condition} Advance with \`${advanceCommand}\` once it is populated.`;
        } else {
          description = `Execute root-cause analysis and manual smoke testing to produce a discovery report. No discovery-shaped report was resolved in \`${planDirLabel}\`. ${condition} Advance with \`${advanceCommand}\` once one exists.`;
          stateSummary = `No discovery-shaped report was resolved. ${condition} Advance with \`${advanceCommand}\` once one exists.`;
        }

        return {
          currentStage: STAGE_DISCOVERY,
          nextStage: STAGE_PLAN,
          actionType: 'subagent',
          role: ROLE_DISCOVERY,
          title: 'Invoke Defect Discovery Subagent',
          description,
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_DISCOVERY} with Model '${subagent.model}' (scoped write tools). ${this.formatDispatchOrdinal(NOTE_DISCOVERY_DISPATCH_ORDINAL, sm.discoveryDispatchCount)} ${stateSummary}`,
          discoveryDispatchCount: sm.discoveryDispatchCount,
          ...(reportState === null
            ? {}
            : {
                discoveryReportPopulated: reportState.populated,
                discoveryReportPath: reportState.path,
                discoveryReportMissingEvidence: reportState.missingEvidence
              })
        };
      }

      case STAGE_PLAN: {
        const advanceCommand = formatPlanAdvanceCommand(activeIssue);
        const condition = NOTE_PLAN_ADVANCE_CONDITION;

        const planDir = sm.planDir;
        let planPath: string | undefined;
        let planContent = '';
        if (this.planGenerator) {
          const resolved = this.planGenerator.resolvePlanFile({
            projectRoot: cwd,
            issue: activeIssue,
            planPath: sm.planPath ?? undefined,
            planDir: sm.planDir,
            stage: sm.currentStage
          });
          if (resolved) {
            planPath = resolved.planPath;
            try {
              planContent = this.planGenerator.readPlanDocument(resolved.planPath);
            } catch {
              // Non-fatal: an unreadable plan is treated as blank.
            }
          }
        }

        const planIsBlank = !isPlanContentSubstantive(planContent);

        // Issue #337: a non-blank plan is a met completion condition. The
        // `planGenerator` guard is required: an absent generator means the plan
        // is UNVERIFIED, not "complete" (and not "blank"). Return before the
        // subagent, the payload and the counter.
        if (this.planGenerator && !planIsBlank) {
          return {
            currentStage: STAGE_PLAN,
            nextStage: STAGE_APPROVAL,
            actionType: 'advance',
            title: 'Plan Complete — Advance to APPROVAL',
            description: `${planPath ? `Plan: \`${planPath}\`. ` : ''}${NOTE_PLAN_COMPLETE} ${condition} Advance with \`${advanceCommand}\`.`,
            baseBranch,
            taskBranch,
            worktreePath,
            humanSummary: `${NOTE_PLAN_COMPLETE} Advance with \`${advanceCommand}\`.`,
            planDispatchCount: sm.planDispatchCount
          };
        }

        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_PLANNER,
          customConfig: config,
          workspaceDir: cwd
        });

        const prompt = this.resolveSubagentUseCase.buildPlanningTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: cwd,
          config,
          planDir,
          planPath
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_PLANNER,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: prompt
            }
          ]
        };

        if (sm.pausedAtGate === null) {
          sm.recordPlanDispatch();
          await this.persistDispatchCounter(sm, 'plan', writesEnabled, wouldWrite);
        }

        const stateWord = planIsBlank ? 'still blank' : 'non-blank';
        return {
          currentStage: STAGE_PLAN,
          nextStage: STAGE_APPROVAL,
          actionType: 'subagent',
          role: ROLE_PLANNER,
          title: 'Invoke Planning Architect Subagent',
          description: `Generate architectural plan and specifications in artifacts/plans/ with scoped write tools. The plan is ${stateWord}${planPath ? ` at \`${planPath}\`` : ''}. ${condition} Advance with \`${advanceCommand}\`.`,
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_PLANNER} with Model '${subagent.model}' (scoped write tools). ${this.formatDispatchOrdinal(NOTE_PLAN_DISPATCH_ORDINAL, sm.planDispatchCount)} The plan is ${stateWord}. ${condition} Advance with \`${advanceCommand}\`.`,
          planDispatchCount: sm.planDispatchCount
        };
      }

      case STAGE_APPROVAL: {
        if (sm.mode === MODE_YOLO) {
          // The YOLO advancing command is `codeloop implement`, not
          // `transition QUALITY_GATE`, so the probe and the counter are NOT
          // touched here (issue #327): this directive is unchanged.
          return await this.buildImplementAction(sm, config, cwd, writesEnabled, wouldWrite);
        }

        const planRecovery = this.buildBlankPlanDiagnosis(sm, cwd, activeIssue);
        return {
          currentStage: STAGE_APPROVAL,
          nextStage: STAGE_IMPLEMENT,
          actionType: 'human_gate',
          title: 'Human Approval Gate',
          description: `Review the technical plan in artifacts/plans/. Seek user confirmation before modifying source code.${planRecovery ? ` ${planRecovery}` : ''}`,
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: `Present the plan to the user and wait for approval. Once approved, run "codeloop implement" or "codeloop transition IMPLEMENT".${planRecovery ? ` ${planRecovery}` : ''}`
        };
      }

      case STAGE_IMPLEMENT: {
        if (sm.implementToGateLoops >= MAX_IMPLEMENT_GATE_LOOPS) {
          return {
            currentStage: sm.currentStage,
            nextStage: STAGE_QUALITY_GATE,
            actionType: 'human_gate',
            title: 'Quality Gate Retry Breaker',
            description: `Quality gate has failed ${sm.implementToGateLoops} times consecutively. Manual intervention required to prevent infinite loop.`,
            baseBranch,
            taskBranch,
            worktreePath,
            humanSummary: `Too many consecutive failures (${sm.implementToGateLoops}). Please inspect the workspace manually and fix the issue before running "codeloop transition QUALITY_GATE" or "codeloop implement".`
          };
        }
        return await this.buildImplementAction(sm, config, cwd, writesEnabled, wouldWrite);
      }

      case STAGE_QUALITY_GATE: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_GATE,
          customConfig: config,
          workspaceDir: cwd
        });

        const workspace = worktreePath || cwd;

        // Issue #298: ONE shared contract for the plan, the commands, the
        // smoke protocol and the digest. The gate is never dispatched with a
        // list that ignores the approved plan, and never dispatched against a
        // plan that changed after approval.
        const verification = await resolveGateVerification({
          projectRoot: cwd,
          workspaceDir: workspace,
          config,
          issue: activeIssue,
          planPath: sm.planPath ?? null,
          planDir: sm.planDir,
          planGenerator: this.planGenerator,
          buildDetector: this.buildDetector,
          approvedPlanDigest: sm.approvedPlanDigest
        });

        if (
          verification.integrity.status === PLAN_INTEGRITY_MISMATCH ||
          verification.integrity.status === PLAN_INTEGRITY_MISSING
        ) {
          return this.buildPlanIntegrityGateFailure(
            verification,
            baseBranch,
            taskBranch,
            worktreePath,
            activeIssue,
            sm.planDir
          );
        }

        if (verification.targetFindings.length > 0) {
          return this.buildGateTargetContractFailure(
            verification,
            baseBranch,
            taskBranch,
            worktreePath,
            activeIssue,
            sm.planDir
          );
        }

        if (verification.smoke.findings.length > 0) {
          return this.buildSmokeProtocolGateFailure(
            verification,
            baseBranch,
            taskBranch,
            worktreePath,
            activeIssue,
            sm.planDir
          );
        }

        // Issue #337: READ the evidence before writing a prompt that tells the
        // operator to file it. `gate-report` stamps the block with
        // `resolveGateRound(history)` and `transition REVIEW` accepts it only
        // when the rounds match, so "filed for this round" here means exactly
        // what the exit means. This is placed AFTER the integrity/smoke
        // blockers: those are real blockers and stay human gates.
        const evidence = this.resolveGateEvidence(activeIssue, sm);
        if (evidence.status === 'filed') {
          const evidenceNote = formatGateEvidenceFiledNote(activeIssue);
          const verdictClause =
            evidence.report.verdict === STATUS_FAILED
              ? ` ${formatGateFailedRetryNote(activeIssue)}`
              : '';
          return {
            currentStage: STAGE_QUALITY_GATE,
            nextStage: STAGE_REVIEW,
            actionType: 'advance',
            title: 'Gate Evidence Filed — Advance to REVIEW',
            description: `Gate evidence filed for round ${evidence.report.gateRound} (verdict ${evidence.report.verdict}). ${evidenceNote}${verdictClause}`,
            baseBranch,
            taskBranch,
            worktreePath,
            humanSummary: `The gate's GATE_REPORT_JSON block for round ${evidence.report.gateRound} is on record (verdict ${evidence.report.verdict}). ${evidenceNote}${verdictClause}`,
            gateEvidenceFiled: true
          };
        }

        const commandPlan = verification.commandPlan;
        const commands = commandPlan.commands.map((command) => command.command);

        const prompt = this.resolveSubagentUseCase.buildGateTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: workspace,
          config,
          commands,
          planContent: verification.planContent || undefined,
          planPath: verification.planPath ?? undefined,
          cwd: verification.cwd,
          commandSource: commandPlan.source,
          commandSourceDetail: commandPlan.sourceDetail,
          appendedCommands: commandPlan.appended,
          requiredLint: commandPlan.lintRequired,
          composition: commandPlan.composition,
          smokeProtocol: verification.smoke,
          planIntegrity: verification.integrity
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_GATE,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: `Execute verification quality gates from the execution cwd stated below.\nCwd: ${verification.cwd}\n\n${prompt}`
            }
          ]
        };

        return {
          currentStage: STAGE_QUALITY_GATE,
          nextStage: STAGE_REVIEW,
          actionType: 'subagent',
          role: ROLE_GATE,
          title: 'Invoke Quality Gate Verifier Subagent',
          description: `Run ${commands.length} verification command(s) from source '${commandPlan.source}' (${GATE_COMMAND_PRECEDENCE}) in ${verification.cwd}. ${formatGateReportChannelNote(activeIssue)}`,
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_GATE} with Model '${subagent.model}' inside ${verification.cwd}; ${commands.length} command(s) from source '${commandPlan.source}'${commandPlan.lintRequired ? ', lint mandatory' : ''}. ${formatGateReportChannelNote(activeIssue)}`,
          // Issue #337: carry the measurement, not a guess. `false` only when
          // the repository could be read and no this-round block was found;
          // omitted when no repository was injected (nothing measured).
          ...(evidence.status === 'missing' ? { gateEvidenceFiled: false } : {})
        };
      }

      case STAGE_REVIEW: {
        const channelCommand = formatReviewVerdictChannelCommand(activeIssue);

        // The breaker is checked BEFORE incrementing: three dispatches without a
        // filed verdict mean the operator is not acting on the directive, and a
        // fourth identical one would hide that. The way out is the existing
        // channel, named in the description — never a second deadlock.
        if (sm.reviewDispatchCount >= MAX_REVIEW_DISPATCH_LOOPS) {
          return {
            currentStage: STAGE_REVIEW,
            nextStage: STAGE_COMMIT,
            actionType: 'human_gate',
            title: 'Review Verdict Breaker',
            description: this.formatReviewDispatchCap(channelCommand),
            baseBranch,
            taskBranch,
            worktreePath,
            humanSummary: `The reviewer was dispatched ${sm.reviewDispatchCount} times without a filed verdict for issue ${activeIssue ?? '(unknown)'}. ${this.formatReviewDispatchCap(channelCommand)}`,
            reviewDispatchCount: sm.reviewDispatchCount
          };
        }

        // A paused read is NOT a dispatch: `actionable:false` already tells the
        // harness, and recording it would inflate the count while the operator
        // is blocked on a gate.
        if (sm.pausedAtGate === null) {
          sm.recordReviewDispatch();
          await this.persistDispatchCounter(sm, 'review', writesEnabled, wouldWrite);
        }

        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_REVIEWER,
          customConfig: config,
          workspaceDir: cwd
        });

        // Issue #356: `git diff <base>` cannot see a NEW file, so the reviewer's
        // own inspection command omitted the load-bearing part of the change set.
        // The SAME probe the IMPLEMENT boundary uses already computes it; an
        // unreadable tree (`probeError`) or an absent probe degrades to today's
        // prompt rather than failing the dispatch.
        const probe = await this.probeImplementation(worktreePath, baseBranch);
        const untrackedFiles =
          probe && probe.probeError === null ? probe.untrackedFiles ?? [] : [];

        const prompt = this.resolveSubagentUseCase.buildReviewerTaskPrompt({
          issueNumber: activeIssue,
          baseBranch,
          workspaceDir: worktreePath || cwd,
          config,
          untrackedFiles
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_REVIEWER,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: `Inspect isolated worktree diff against base '${baseBranch}':\nCwd: ${worktreePath || cwd}\n\n${prompt}`
            }
          ]
        };

        return {
          currentStage: STAGE_REVIEW,
          nextStage: STAGE_COMMIT,
          actionType: 'subagent',
          role: ROLE_REVIEWER,
          title: 'Invoke AI Reviewer Subagent',
          // Issue #272: the operator-facing fields name the ONLY channel that
          // records a verdict. The instruction used to live only inside the
          // dispatched prompt, so an operator following `next` re-dispatched the
          // reviewer forever.
          description: `Run critique analysis and verify Acceptance Criteria fulfillment against the isolated diff. ${formatReviewVerdictChannelNote(activeIssue)}`,
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke ${ROLE_TITLE_REVIEWER} with Model '${subagent.model}' against base '${baseBranch}'. ${this.formatReviewDispatchOrdinal(sm.reviewDispatchCount)} ${formatReviewVerdictChannelNote(activeIssue)} ${NOTE_REVIEW_GATE_EXIT_CONDITION}`,
          reviewDispatchCount: sm.reviewDispatchCount
        };
      }

      case STAGE_COMMIT: {
        const recordedSource = this.lastReviewSource(sm);
        return {
          currentStage: STAGE_COMMIT,
          nextStage: STAGE_COMPLETED,
          actionType: 'human_gate',
          title: 'Conventional Commit & Teardown Gate',
          // Issue #259 (AC4): the verdict is read from the recorded history
          // metadata — a SKIPPED review must never be described as a pass.
          // Issue #297: the record's PROVENANCE travels with it, so the gate
          // says whether Tier 1 actually cross-checked the verdict.
          description: this.buildCommitGateDescription({
            verdict: this.lastReviewVerdict(sm),
            source: recordedSource,
            critiqueVerified: this.lastCritiqueVerified(sm)
          }),
          baseBranch,
          taskBranch,
          worktreePath,
          // Issue #315 (AC-21 / #332): the gate's definition of done is
          // DELIVERY, not "commit, push, teardown". Naming the PR step here is
          // the only place an operator following `next` is told it exists.
          humanSummary: `Deliver this run: run "codeloop commit --create-pr" (targets base branch '${baseBranch}'). The branch is pushed but the run is NOT delivered until the PR is merged.`,
          lastReviewSource: recordedSource,
          lastReviewCritiqueVerified: this.lastCritiqueVerified(sm)
        };
      }

      case STAGE_TRIAGE: {
        const subagent = this.resolveSubagentUseCase.execute({
          role: ROLE_TRIAGE,
          customConfig: config,
          workspaceDir: cwd
        });

        const prompt = this.resolveSubagentUseCase.buildTriageTaskPrompt({
          issueNumber: activeIssue,
          workspaceDir: worktreePath || cwd,
          config,
          triagePayload: sm.triagePayload
        });

        const invocationPayload: SubagentInvocationPayload = {
          Subagents: [
            {
              TypeName: 'self',
              Role: ROLE_TITLE_TRIAGE,
              Model: subagent.model,
              Workspace: 'inherit',
              Prompt: prompt
            }
          ]
        };

        return {
          currentStage: STAGE_TRIAGE,
          nextStage: STAGE_IMPLEMENT,
          actionType: 'subagent',
          role: ROLE_TRIAGE,
          title: 'Invoke Triage Subagent',
          // The exit condition is stated here (issue #269): this gate re-opens
          // on every read while the pull request is open, so the operator must
          // be told what ENDS it.
          description: `Open PR contains review comments requiring triage and pipeline routing. ${NOTE_TRIAGE_GATE_EXIT_CONDITION}`,
          baseBranch,
          taskBranch,
          worktreePath,
          invocationPayload,
          humanSummary: `Invoke Triage Subagent with Model '${subagent.model}' to categorize comments and route to one of: ${formatTriageActionList('|')}. ${formatTriageActionSideEffects()}. ${NOTE_TRIAGE_GATE_EXIT_CONDITION}`
        };
      }

      case STAGE_COMPLETED:
      default: {
        // The recorded disposition is named here (issue #269): the operator
        // must be able to see that the feedback WAS disposed of — otherwise the
        // idle report reads like "nothing happened" and the gate looks like it
        // will re-open forever. The line is rendered by the ONE shared
        // renderer (issue #269, R5).
        const disposition = sm.triageDisposition;
        const dispositionLine = disposition
          ? ` ${formatTriageDispositionLine(disposition, 'idle-report')}`
          : '';
        // Issue #351: when the gate ended because the PR did, the idle report
        // must say so — otherwise the operator cannot tell a merged PR's exit
        // from a disposition (or from "nothing happened").
        const triageExit = this.lastTriageExit(sm);
        const exitState = typeof triageExit?.prState === 'string' ? triageExit.prState : null;
        const triageExitLine = exitState
          ? ` ${formatTriageGateEndedNote(
              exitState,
              typeof triageExit?.prNumber === 'number' ? triageExit.prNumber : null
            )}`
          : '';
        return {
          currentStage: sm.currentStage,
          nextStage: STAGE_INITIALIZED,
          actionType: 'completed',
          title: 'Pipeline Completed / Idle',
          description: 'No active tasks pending. Ready to initialize next task or milestone.',
          baseBranch,
          taskBranch,
          worktreePath,
          humanSummary: NOTE_IDLE_SUMMARY + dispositionLine + triageExitLine
        };
      }
    }
  }

  /**
   * The ONE guarded PR lookup (issue #351).
   *
   * `next` is a query: an offline, unauthenticated or rate-limited GitHub must
   * still get an answer, so every failure collapses to `null` — "not measured",
   * never "closed". Callers decide what null means; this helper never guesses.
   */
  private async findPullRequestOrNull(
    issue: number,
    cwd: string
  ): Promise<GitHubPullRequestData | null> {
    const gateway = this.githubGateway;
    if (!gateway?.findPullRequest) {
      return null;
    }
    try {
      return (await gateway.findPullRequest({ issueNumber: issue, cwd })) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Probes the OPEN PR of `issue` for unaddressed review feedback.
   *
   * Reuses the exact optional-port method chain and the non-fatal discipline of
   * `TriagePrCommentsUseCase` and `RunPreFlightCheckUseCase` (issue #237): a
   * `next` invocation is a query, and an offline or rate-limited GitHub must
   * still get an answer. Every step is individually guarded, so a gateway that
   * throws, a missing PR, a merged/closed PR, or a gateway without either
   * optional method all collapse to `null` — treated as "no feedback", never as
   * "authorise a reset".
   *
   * The detector CLASSIFIES the comments (issue #269) instead of counting
   * them:
   *
   * - the tool's OWN replies are excluded, so dismissing feedback cannot
   *   increase the detected count;
   * - the repository's own automated summaries are excluded, because a status
   *   post is not review feedback;
   * - feedback already covered by the recorded triage DISPOSITION is excluded,
   *   which is what turns the TRIAGE livelock into a one-shot gate.
   */
  private async detectOpenReviewFeedback(
    issue: number,
    cwd: string,
    disposition: TriageDisposition | null
  ): Promise<OpenReviewFeedback | null> {
    const gateway = this.githubGateway;
    if (!gateway?.findPullRequest) {
      return null;
    }

    try {
      const pr = await this.findPullRequestOrNull(issue, cwd);
      // Only an OPEN PR's review feedback is actionable: a merged or closed one
      // was already resolved by whatever closed it.
      if (!pr || pr.state !== 'OPEN' || !pr.number) {
        return null;
      }

      let comments: readonly PullRequestReviewComment[] = [];
      if (gateway.fetchPullRequestComments) {
        const fetched = await gateway.fetchPullRequestComments(pr.number, { cwd });
        if (fetched) {
          comments = fetched;
        }
      }

      // Same predicate as run-preflight-check.ts: an empty comment list is not
      // feedback.
      //
      // The clause that used to follow — `|| comments.some(c => c.state ===
      // 'CHANGES_REQUESTED')` — was dead: `CliGitHubGateway.fetchPullRequest
      // Comments` only pushes a review when it has a non-empty body, so any
      // entry carrying `state: 'CHANGES_REQUESTED'` already made the list
      // non-empty. A CHANGES_REQUESTED verdict submitted with NO prose is
      // therefore invisible to this port entirely — a real limitation, but not
      // one a second operand on the same list can repair, and pretending
      // otherwise made the predicate look stricter than it is.
      if (comments.length === 0) {
        return null;
      }

      // The ACTIONABLE comments are the only ones that can route the pipeline
      // (issue #269): the tool's own replies and the repository's automated
      // summaries are not feedback.
      const classified = classifyPrFeedback(comments);
      if (classified.actionable.length === 0) {
        return null;
      }

      // The recorded disposition covers the feedback that was already
      // disposed of. A NEW comment (a key the disposition does not cover) still
      // routes — the tool does not go blind.
      //
      // The disposition applies to ONE pull request (issue #269, R4): a
      // disposition recorded for PR #7 must never suppress feedback on PR #8.
      // The check is cheap defence in depth — REST comment ids are globally
      // unique today, and `TriageDisposition.merge` replaces the disposition
      // when the PR changes — but the rule "for that PR" is explicit, and a
      // disposition for another PR leaves the feedback undispositioned, so it
      // routes to TRIAGE exactly as it would without any disposition.
      const keys = feedbackKeysOf(classified.actionable);
      if (disposition && disposition.prNumber === pr.number && disposition.coversAll(keys)) {
        return null;
      }

      return {
        prNumber: pr.number,
        commentCount: classified.actionable.length,
        payload: classified.actionable.map((c) => `- [${c.author || 'Unknown'}]: ${c.body}`).join('\n')
      };
    } catch {
      return null;
    }
  }

  /**
   * Reads the metadata of the MOST RECENT review entry in the checkpoint
   * history (issues #259, #313).
   *
   * `RunReviewUseCase` records everything about a verdict in the metadata of
   * the history entry it writes (`reviewVerdict`, `reviewTokens`,
   * `reviewRound`, `reviewSource`, …). Both the COMMIT-gate description
   * (#259) and the IMPLEMENT remediation channel (#313) read that ONE record,
   * so the scan lives here.
   *
   * The history is scanned backwards: the newest review entry wins, so a
   * re-recorded verdict cannot inherit older fields. An entry without a
   * non-empty string `reviewVerdict` is not a review entry and is skipped.
   */
  private lastReviewMetadata(sm: StateMachine): Record<string, unknown> | null {
    const history = sm.history;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const metadata = history[index].metadata;
      const verdict = metadata?.reviewVerdict;
      if (typeof verdict === 'string' && verdict.length > 0) {
        return metadata ?? null;
      }
    }

    return null;
  }

  /**
   * The newest recorded TRIAGE exit, or null (issue #351).
   *
   * Mirrors `lastReviewMetadata`: the history is scanned backwards, so the
   * exit the idle report names is the most recent one.
   */
  private lastTriageExit(sm: StateMachine): Record<string, unknown> | null {
    for (let index = sm.history.length - 1; index >= 0; index -= 1) {
      const metadata = sm.history[index].metadata;
      if (metadata?.triageExit === TRIAGE_EXIT_PULL_REQUEST_TERMINAL) {
        return metadata ?? null;
      }
    }
    return null;
  }

  /**
   * Reads the MOST RECENT recorded AI-review verdict from the checkpoint
   * history (issue #259).
   *
   * `RunReviewUseCase` records the verdict in the metadata of the history
   * entry it writes (`reviewVerdict`), so the COMMIT gate can describe what
   * actually happened instead of hard-coding "Review passed". The scan is
   * shared with the remediation channel (issue #313): the newest review entry
   * wins, so a re-recorded verdict cannot inherit older fields.
   */
  private lastReviewVerdict(sm: StateMachine): string | null {
    const verdict = this.lastReviewMetadata(sm)?.reviewVerdict;
    return typeof verdict === 'string' && verdict.length > 0 ? verdict : null;
  }

  /**
   * Reads the MOST RECENT recorded AI-review verdict SOURCE from the checkpoint
   * history (issue #297, AC10).
   *
   * Mirrors `lastReviewVerdict`: the last review entry wins, so a re-recorded
   * verdict cannot inherit an older provenance. Returns null when no review has
   * persisted a source (legacy checkpoints).
   */
  private lastReviewSource(sm: StateMachine): string | null {
    const history = sm.history;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const source = history[index].metadata?.reviewSource;
      if (typeof source === 'string' && source.length > 0) {
        return source;
      }
    }

    return null;
  }

  /**
   * Whether the most recent review was cross-checked by a real (non-bypassed)
   * Tier 1 critique report (issue #297, AC10). Defaults to false — a record that
   * cannot prove the cross-check never claims it.
   */
  private lastCritiqueVerified(sm: StateMachine): boolean {
    const history = sm.history;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (typeof entry.metadata?.reviewSource === 'string') {
        return entry.metadata?.critiqueVerified === true;
      }
    }

    return false;
  }

  /**
   * Renders `NOTE_REVIEW_DISPATCH_ORDINAL` for the current REVIEW round
   * (issue #272). Mirrors `formatStaleWorktreeNote`'s placeholder style in the
   * CLI rather than inventing a second templating mechanism.
   */
  private formatReviewDispatchOrdinal(current: number): string {
    return NOTE_REVIEW_DISPATCH_ORDINAL
      .replace('{n}', String(current))
      .replace('{max}', String(MAX_REVIEW_DISPATCH_LOOPS));
  }

  /**
   * Scores the DISCOVERY report at the already-resolved path (issue #320).
   *
   * Returns `null` when no `PlanGeneratorPort` is injected: there is nothing to
   * verify, so the directive keeps its historical text and emits no state
   * fields rather than falsely claiming "still blank".
   *
   * Fails CLOSED: an unresolvable path, a throwing read and a non-discovery-
   * shaped document all yield `{populated:false, path:null}` — an implementation
   * plan can never be reported as (or named as) RCA evidence.
   */
  private resolveDiscoveryReportState(planPath: string | null): DiscoveryReportState | null {
    if (!this.planGenerator) {
      return null;
    }

    const unverified: DiscoveryReportState = { populated: false, path: null, missingEvidence: null };
    if (!planPath) {
      return unverified;
    }

    try {
      const markdown = this.planGenerator.readPlanDocument(planPath);
      if (!isDiscoveryPlanDocument(markdown)) {
        return unverified;
      }
      const report = DiscoveryReport.fromMarkdown(markdown);
      if (report.isPopulated) {
        return { populated: true, path: planPath, missingEvidence: null };
      }
      return {
        populated: false,
        path: planPath,
        missingEvidence: report.describeMissingEvidence()
      };
    } catch {
      // Fail closed: a read failure is not evidence.
      return unverified;
    }
  }

  /**
   * Persists a re-dispatch counter (issues #292/#272/#291).
   *
   * Best-effort BY DESIGN: the counter is observability, and a failed write
   * (for example `StateStorageError` when `next --issue N` runs from a
   * DIFFERENT task's worktree, or a refused cwd) must not turn a read-only query
   * into a crash. The directive is still returned; only the persisted record is
   * skipped — and #291/F1 requires that skip to be VISIBLE, so the failure is
   * reported on stderr instead of being swallowed.
   */
  private async persistDispatchCounter(
    sm: StateMachine,
    counter: DispatchCounterKind,
    writesEnabled: boolean,
    wouldWrite: string[]
  ): Promise<void> {
    if (!writesEnabled) {
      // A suppressed write is DECLARED, never silent (issue #301 / #304): the
      // counter and `updatedAt` are the only keys this read would have changed.
      wouldWrite.push(`checkpoint: ${counter}DispatchCount + updatedAt`);
      return;
    }
    try {
      await this.stateRepo.save(sm.toSnapshot());
    } catch {
      console.warn(
        formatDispatchCounterUnrecorded(counter, this.stateRepo.getStateFilePath())
      );
    }
  }

  /**
   * The ONE seam every context-field write goes through (issue #301).
   *
   * When writes are disabled — no loaded checkpoint, or `--dry-run` — the
   * intent is recorded in `wouldWrite` instead of being persisted, so the
   * query contract and the observed behaviour cannot disagree.
   */
  private async saveContext(
    sm: StateMachine,
    enabled: boolean,
    reason: string,
    wouldWrite: string[]
  ): Promise<void> {
    if (!enabled) {
      wouldWrite.push(reason);
      return;
    }
    await this.stateRepo.save(sm.toSnapshot());
  }

  /**
   * Renders one of the early-stage ordinal notes (`{n}`) for the current
   * DISCOVERY/PLAN round (issue #292).
   */
  private formatDispatchOrdinal(template: string, current: number): string {
    return template.replace('{n}', String(current));
  }

  /** Renders the breaker's cap + the way out of it (issue #272). */
  private formatReviewDispatchCap(channelCommand: string): string {
    return NOTE_REVIEW_DISPATCH_CAP
      .replace('{max}', String(MAX_REVIEW_DISPATCH_LOOPS))
      .replace('{command}', channelCommand);
  }

  /**
   * Builds the COMMIT-gate description for the recorded review verdict.
   *
   * The approved path keeps its original wording; every other verdict says
   * what actually happened. A skipped review is advisory, never a pass — the
   * #236 fail-open is preserved, only the WORDING at this gate changes.
   *
   * Issue #297: the provenance suffix is appended only when a source was
   * recorded, so a legacy checkpoint renders exactly as it did before.
   */
  private buildCommitGateDescription(record: {
    readonly verdict: string | null;
    readonly source: string | null;
    readonly critiqueVerified: boolean;
  }): string {
    // Issue #315 (AC-21 / #332): the delivery step is part of the gate, not an
    // optional postscript — a pushed branch with no PR is not a delivered run.
    const commitInstructions =
      'Draft conventional commit, prompt for confirmation, push to remote, open the PR, and teardown worktree. The run is NOT delivered until that PR is merged.';

    let verdictLine: string;
    if (record.verdict === VERDICT_APPROVED) {
      verdictLine = 'Review passed.';
    } else if (record.verdict === VERDICT_SKIPPED) {
      verdictLine = 'AI review was SKIPPED (no reviewer output, no critique report) — advisory, not a pass.';
    } else if (record.verdict === VERDICT_CHANGES_REQUESTED) {
      verdictLine = 'AI review requested changes — this checkpoint should not be at the COMMIT gate.';
    } else {
      verdictLine = 'No AI review verdict is recorded for this task.';
    }

    const provenance = record.source
      ? ` [Verdict source: ${record.source}; Tier 1 critique verified: ${record.critiqueVerified}]`
      : '';

    return `${verdictLine}${provenance} ${commitInstructions}`;
  }

  /**
   * Builds the review-remediation section for a re-dispatched IMPLEMENT
   * directive (issue #313).
   *
   * `RunReviewUseCase` already persists the reviewer's verdict, the structured
   * `REVIEW_STATUS`/`REVIEW_SUMMARY`/`UNFULFILLED_AC`/`REMEDIATION_GUIDANCE`
   * block (`reviewTokens`) and the round number, but nothing ever read that
   * record when re-dispatching the implementer: the prompt was rebuilt from
   * the plan and the TRIAGE payload only, so the reviewer's remediation was
   * recorded and dropped.
   *
   * The LATEST review entry governs: a later `APPROVED`/`SKIPPED` round yields
   * null, so no earlier round's guidance can leak into a re-dispatch. The
   * `reviewTokens` block is canonical; `selfCorrectionPayload` is the legacy
   * fallback for records written before it existed. The block travels
   * VERBATIM — re-parsing it could drop an item the reviewer considered
   * blocking — under a round-named heading that supplies the context the
   * legacy Markdown lacks.
   */
  private buildReviewRemediation(
    sm: StateMachine
  ): { readonly round: number | null; readonly payload: string } | null {
    const metadata = this.lastReviewMetadata(sm);
    if (!metadata || metadata.reviewVerdict !== VERDICT_CHANGES_REQUESTED) {
      return null;
    }

    const tokens = typeof metadata.reviewTokens === 'string' ? metadata.reviewTokens.trim() : '';
    const selfCorrection =
      typeof metadata.selfCorrectionPayload === 'string'
        ? metadata.selfCorrectionPayload.trim()
        : '';
    const block = tokens || selfCorrection;
    if (!block) {
      return null;
    }

    const round = typeof metadata.reviewRound === 'number' ? metadata.reviewRound : null;
    const heading =
      round === null
        ? `### Review Remediation (${VERDICT_CHANGES_REQUESTED})`
        : `### Review Remediation - Round ${round} (${VERDICT_CHANGES_REQUESTED})`;

    return {
      round,
      payload: `${heading}\nThe AI Review requested changes and returned the pipeline to IMPLEMENT. The rejected implementation is still in the worktree: address every item below before re-running the quality gate.\n\n${block}`
    };
  }

  private async buildImplementAction(
    sm: StateMachine,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any,
    cwd: string,
    writesEnabled: boolean,
    wouldWrite: string[]
  ): Promise<DirectiveResult> {
    const activeIssue = sm.issue;
    const worktreePath = sm.worktree?.worktreePath || null;
    const baseBranch = sm.baseBranch || 'main';

    // A NON-NULL descriptor that resolves to the root is a genuine violation
    // (#247) regardless of the plan's content: the ONE domain predicate decides
    // it BEFORE any directive is built. A MISSING descriptor is different —
    // that check stays after the blank-plan branch, so an operator whose
    // worktree was removed can still fix the plan (issue #267).
    if (worktreePath && isRootWorkspace(worktreePath, cwd)) {
      assertNotRootWorkspace(worktreePath, cwd, 'worktreePath');
    }

    // Issue #267: resolve the plan BEFORE the missing-worktree guard. A blank
    // plan can be fixed by the planner even when the worktree was removed, and
    // the directive must name the reachable recovery instead of the implementer.
    let planContent = '';
    let planPath = '';
    if (this.planGenerator) {
      const resolved = this.planGenerator.resolvePlanFile({
        projectRoot: cwd,
        issue: activeIssue,
        planPath: sm.planPath ?? undefined,
        planDir: sm.planDir,
        stage: sm.currentStage
      });
      if (resolved) {
        planPath = resolved.planPath;
        try {
          planContent = this.planGenerator.readPlanDocument(resolved.planPath);
        } catch {
          // Non-fatal
        }
      }
    }

    if (this.planGenerator && !isPlanContentSubstantive(planContent)) {
      return this.buildBlankPlanPlannerDirective(sm, config, cwd, planPath, baseBranch);
    }

    // Issue #266 (absorbs #287 B): a NULL descriptor is not a root-mutation
    // attempt — the worktree was removed (`codeloop worktree remove` during
    // IMPLEMENT, for example). Return an actionable directive instead of
    // asserting.
    if (!worktreePath) {
      return this.buildMissingWorktreeDirective(sm, baseBranch);
    }

    const taskBranch = sm.worktree?.branch || null;

    const remediation = this.buildReviewRemediation(sm);
    const gateFailure = this.buildGateFailureRemediation(sm);

    // Issue #337: hoisted above the probe so the met return and the dispatch
    // path name the SAME advancing command and condition.
    const advanceCommand = formatImplementAdvanceCommand(activeIssue);
    const condition = NOTE_IMPLEMENT_ADVANCE_CONDITION;

    // Issue #327 (Defect 4): at IMPLEMENT the completion condition is a FACT,
    // not a static sentence. The existing #259 probe decides it — the SAME one
    // the gate and the YOLO path use — and it now runs BEFORE the payload so a
    // met condition can return without building one (issue #337).
    let implementationPresent: boolean | null = null;
    let probeReadable = false;
    if (sm.currentStage === STAGE_IMPLEMENT) {
      const probe = await this.probeImplementation(
        worktreePath,
        sm.worktree?.baseBranch || sm.baseBranch || baseBranch
      );
      const readable = probe !== null && probe.probeError === null;
      probeReadable = readable;
      implementationPresent = !readable
        ? null
        : probe.hasChanges
          ? true
          : probe.measurementError === null
            ? false
            : null;
    }

    // Issue #337: a present diff with NO outstanding review remediation and NO
    // recorded gate failure is the IMPLEMENT completion condition — the stage
    // is done, so there is nothing to dispatch. This return sits ABOVE the
    // payload and the counter: a met read writes nothing at all.
    //
    // The `remediation === null` conjunct is load-bearing: after
    // `CHANGES_REQUESTED` the rejected diff is ALREADY in the worktree, so a
    // bare `implementationPresent === true` would make #313's remediation flow
    // unreachable through `next`.
    //
    // The `gateFailure === null` conjunct is load-bearing for the same reason:
    // a FAILED gate returns to IMPLEMENT with the failing diff still in the
    // tree, so treating that diff as complete would re-advance into the same
    // failing gate and never dispatch the fresh implementer the gate-failure
    // loop promises.
    if (
      sm.currentStage === STAGE_IMPLEMENT &&
      implementationPresent === true &&
      remediation === null &&
      gateFailure === null
    ) {
      return {
        currentStage: STAGE_IMPLEMENT,
        nextStage: STAGE_QUALITY_GATE,
        actionType: 'advance',
        title: 'Implementation Present — Advance to QUALITY_GATE',
        description: `${NOTE_IMPLEMENT_PRESENT} ${condition} Advance with \`${advanceCommand}\`.`,
        baseBranch,
        taskBranch,
        worktreePath,
        humanSummary: `Implementation present in ${worktreePath}; do not re-dispatch the implementer. ${condition} Advance with \`${advanceCommand}\`.`,
        implementationPresent: true,
        implementationDispatchCount: sm.implementationDispatchCount,
        planBlank: false
      };
    }

    const subagent = this.resolveSubagentUseCase.execute({
      role: ROLE_IMPLEMENTER,
      customConfig: config,
      workspaceDir: cwd
    });

    // Issue #313 / #337: the reviewer's remediation AND the gate's recorded
    // failures must reach the implementer. Both ride the EXISTING self-correction
    // channel — the same one `codeloop implement` already hydrates from the last
    // history entry.
    const selfCorrectionBlocks = [remediation?.payload, gateFailure?.payload].filter(
      (block): block is string => typeof block === 'string' && block.length > 0
    );

    const prompt = this.resolveSubagentUseCase.buildImplementationTaskPrompt({
      planContent,
      planPath: planPath || undefined,
      issueNumber: activeIssue,
      workspaceDir: worktreePath || cwd,
      config,
      prReviewComments: sm.triagePayload,
      selfCorrectionPayload:
        selfCorrectionBlocks.length > 0 ? selfCorrectionBlocks.join('\n\n') : null
    });

    const invocationPayload: SubagentInvocationPayload = {
      Subagents: [
        {
          TypeName: 'self',
          Role: ROLE_TITLE_IMPLEMENTER,
          Model: subagent.model,
          Workspace: 'inherit',
          Prompt: `Execute code modifications strictly inside isolated worktree directory:\nCwd: ${worktreePath || cwd}\nBranch: ${taskBranch || '(auto)'}\n\n${prompt}`
        }
      ]
    };

    const nextStage = sm.currentStage === STAGE_IMPLEMENT ? STAGE_QUALITY_GATE : STAGE_IMPLEMENT;

    // The counter is recorded only when the tree was READABLE and the read is
    // not a paused one: a stale descriptor or a non-git directory is a
    // diagnostic, never a dispatch (#282).
    if (sm.currentStage === STAGE_IMPLEMENT && probeReadable && sm.pausedAtGate === null) {
      sm.recordImplementationDispatch();
      await this.persistDispatchCounter(sm, 'implementation', writesEnabled, wouldWrite);
    }

    const remediationClause = remediation
      ? ` Includes AI review remediation${remediation.round === null ? '' : ` from round ${remediation.round}`}.`
      : '';
    const gateFailureClause = gateFailure
      ? ' Includes the quality gate failure diagnostics recorded for this round.'
      : '';

    if (sm.currentStage !== STAGE_IMPLEMENT) {
      // YOLO / APPROVAL: the advancing command is `codeloop implement`, not
      // `transition QUALITY_GATE`, so this directive's operator text is
      // UNCHANGED (issue #327).
      return {
        currentStage: sm.currentStage,
        nextStage,
        actionType: 'subagent',
        role: ROLE_IMPLEMENTER,
        title: 'Invoke Code Implementer Subagent',
        description: remediation
          ? `Execute surgical code modifications adhering strictly to approved plan in dedicated worktree. Includes AI review remediation${remediation.round === null ? '' : ` from round ${remediation.round}`}.`
          : 'Execute surgical code modifications adhering strictly to approved plan in dedicated worktree.',
        baseBranch,
        taskBranch,
        worktreePath,
        invocationPayload,
        humanSummary: `Invoke ${ROLE_TITLE_IMPLEMENTER} with Model '${subagent.model}' targeting worktree ${worktreePath || '.worktrees/' + activeIssue}.`,
        ...(remediation ? { reviewRemediationRound: remediation.round } : {}),
        planBlank: false
      };
    }

    // Issue #337: the recorded states, because "present with pending
    // remediation" and "present after a FAILED gate" are dispatches and must
    // never print "do not re-dispatch". A pending review remediation governs
    // the sentence when both channels are recorded: it is the NEWEST round.
    const stateSentence =
      implementationPresent === true
        ? remediation
          ? NOTE_IMPLEMENT_PRESENT_REMEDIATION_PENDING
          : gateFailure
            ? NOTE_IMPLEMENT_GATE_FAILED
            : NOTE_IMPLEMENT_PRESENT
        : gateFailure
          ? NOTE_IMPLEMENT_GATE_FAILED
          : implementationPresent === false
            ? NOTE_IMPLEMENT_ABSENT
            : NOTE_IMPLEMENT_UNVERIFIED;
    // Only a MEASURED non-empty tree with no pending remediation and no failed
    // gate ends the stage; every other state keeps a qualifier that is honest
    // about it.
    const advanceSentence = gateFailure && !remediation
      ? `Advance with \`${advanceCommand}\` once the gate's failures are fixed.`
      : implementationPresent === true
        ? remediation
          ? `Advance with \`${advanceCommand}\` once the remediation is applied.`
          : `Advance with \`${advanceCommand}\`.`
        : `Advance with \`${advanceCommand}\` once the diff exists.`;

    return {
      currentStage: sm.currentStage,
      nextStage,
      actionType: 'subagent',
      role: ROLE_IMPLEMENTER,
      title: 'Invoke Code Implementer Subagent',
      description: `${stateSentence} ${condition} ${advanceSentence}${remediationClause}${gateFailureClause}`,
      baseBranch,
      taskBranch,
      worktreePath,
      invocationPayload,
      humanSummary: `Invoke ${ROLE_TITLE_IMPLEMENTER} with Model '${subagent.model}' targeting worktree ${worktreePath || '.worktrees/' + activeIssue}. ${this.formatDispatchOrdinal(NOTE_IMPLEMENT_DISPATCH_ORDINAL, sm.implementationDispatchCount)} ${stateSentence} ${condition} ${advanceSentence}`,
      implementationPresent,
      implementationDispatchCount: sm.implementationDispatchCount,
      ...(remediation ? { reviewRemediationRound: remediation.round } : {}),
      planBlank: false
    };
  }

  /**
   * Runs the implementation-evidence probe, failing closed (issue #327).
   *
   * A probe that is absent, throws, or returns `probeError` yields `null` — the
   * directive then says the state is UNVERIFIED instead of inferring one from a
   * tree nobody could read.
   */
  private async probeImplementation(
    worktreePath: string | null,
    baseRef: string | null | undefined
  ): Promise<ImplementationDiff | null> {
    if (!this.implementationProbe) {
      return null;
    }
    try {
      return await this.implementationProbe.execute({
        workspaceDir: worktreePath ?? undefined,
        baseRef: baseRef ?? null
      });
    } catch {
      return null;
    }
  }

  /**
   * The gate failure recorded for the CURRENT IMPLEMENT round (issue #337).
   *
   * `run-quality-gate` and `transition IMPLEMENT` stamp the gate verdict on the
   * history entry that OPENS the round they enter, so the newest entry whose
   * stage is `IMPLEMENT` is the record of the gate run this round is repairing:
   * `gateVerdict === STATUS_FAILED` means the diff in the worktree is the one
   * that failed, and the stage's completion condition is therefore NOT met.
   *
   * The scan stops at that entry: a `PASSED` verdict, a review remediation or a
   * fresh approval opens the round with no failed-gate record and yields `null`,
   * so the ordinary met-condition guard applies.
   */
  private lastGateFailure(sm: StateMachine): Record<string, unknown> | null {
    const history = sm.history;

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (entry.stage !== STAGE_IMPLEMENT) {
        continue;
      }
      const verdict = entry.metadata?.gateVerdict;
      return verdict === STATUS_FAILED ? (entry.metadata ?? null) : null;
    }

    return null;
  }

  /**
   * Builds the gate-failure section for a re-dispatched IMPLEMENT directive
   * (issue #337).
   *
   * A FAILED gate returns the pipeline to IMPLEMENT with its diagnostics
   * recorded (`gateTokens`, `failureSnippet`, `selfCorrectionPayload`). Those
   * fields were never read when re-dispatching the implementer, so the operator
   * got a fresh implementer with no idea what failed. This mirrors
   * `buildReviewRemediation`: the recorded block travels VERBATIM, and a gate
   * filed with the verdict alone still yields a block with no diagnostics.
   */
  private buildGateFailureRemediation(sm: StateMachine): { readonly payload: string } | null {
    // Only IMPLEMENT is repaired by this channel; the APPROVAL/YOLO directive is
    // unchanged (issue #327).
    if (sm.currentStage !== STAGE_IMPLEMENT) {
      return null;
    }

    const metadata = this.lastGateFailure(sm);
    // Two recorded signals say "the gate that judged this diff FAILED": the
    // verdict stamped on the entry that opened the round (the dispatched path
    // and `run-quality-gate` both record it), and the consecutive-failure
    // counter the in-process loop maintains. Either one blocks the completion
    // condition — a legacy record without the verdict must not read as done.
    if (!metadata && sm.implementToGateLoops === 0) {
      return null;
    }

    const tokens =
      typeof metadata?.gateTokens === 'string' ? metadata.gateTokens.trim() : '';
    const selfCorrection =
      typeof metadata?.selfCorrectionPayload === 'string'
        ? metadata.selfCorrectionPayload.trim()
        : '';
    const snippet =
      typeof metadata?.failureSnippet === 'string' ? metadata.failureSnippet.trim() : '';
    // The structured block is canonical; the raw failing snippet is appended
    // only when the block does not already contain it, so no failure context
    // the checkpoint recorded is dropped or duplicated.
    const primary = tokens || selfCorrection;
    const parts = [primary];
    if (snippet.length > 0 && !primary.includes(snippet)) {
      parts.push(snippet);
    }
    const diagnostics = parts.filter((part) => part.length > 0).join('\n\n');

    return { payload: formatGateFailureRemediationPayload(diagnostics) };
  }

  /**
   * The gate evidence filed for THIS round (issue #337).
   *
   * Returns `unverified` when no repository is injected — nothing to read, so
   * the directive keeps its historical dispatch + filing note. A stale block
   * (a previous round's evidence) is `missing`: it cannot certify this round,
   * exactly as `transition REVIEW` rejects it.
   */
  private resolveGateEvidence(
    issue: number | string | null,
    sm: StateMachine
  ):
    | { status: 'filed'; report: GateResultReport }
    | { status: 'missing' }
    | { status: 'unverified' } {
    if (!this.gateReportRepo) {
      return { status: 'unverified' };
    }
    const round = resolveGateRound(sm.history);
    const filed = this.gateReportRepo.load(issue);
    return filed !== null && filed.gateRound === round
      ? { status: 'filed', report: filed }
      : { status: 'missing' };
  }

  /**
   * The blank-plan recovery directive (issue #267, AC-A2).
   *
   * The checkpoint stays at its current stage (`nextStage: PLAN` names the
   * intent, but no transition is issued by `next`). The payload is the
   * planner's — the ONE dispatchable route to a real plan.
   */
  private buildBlankPlanPlannerDirective(
    sm: StateMachine,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: any,
    cwd: string,
    planPath: string,
    baseBranch: string
  ): DirectiveResult {
    const subagent = this.resolveSubagentUseCase.execute({
      role: ROLE_PLANNER,
      customConfig: config,
      workspaceDir: cwd
    });

    // The trailing command must be reachable FROM THE CURRENT STAGE (issue
    // #267, AC-A1/A4). At IMPLEMENT the way on is `codeloop next` (the
    // implementer directive once the plan is non-blank) — `transition APPROVAL`
    // is rejected from IMPLEMENT. APPROVAL is only the PLAN-stage advance.
    const advanceCommand =
      sm.currentStage === STAGE_PLAN ? formatPlanAdvanceCommand(sm.issue) : 'codeloop next';
    const planLabel = planPath || '(the scaffolded plan)';
    const diagnosis = NOTE_BLANK_PLAN_DISPATCH_PLANNER.replace('{planPath}', planLabel)
      .replace('{issue}', String(sm.issue ?? ''))
      .replace('{command}', `Advance with \`${advanceCommand}\``);

    const prompt = this.resolveSubagentUseCase.buildPlanningTaskPrompt({
      issueNumber: sm.issue,
      workspaceDir: cwd,
      config,
      planDir: sm.planDir,
      planPath: planPath || undefined
    });

    const invocationPayload: SubagentInvocationPayload = {
      Subagents: [
        {
          TypeName: 'self',
          Role: ROLE_TITLE_PLANNER,
          Model: subagent.model,
          Workspace: 'inherit',
          Prompt: prompt
        }
      ]
    };

    return {
      currentStage: sm.currentStage,
      nextStage: STAGE_PLAN,
      actionType: 'subagent',
      role: ROLE_PLANNER,
      title: 'Invoke Planning Architect Subagent',
      description: diagnosis,
      baseBranch,
      taskBranch: sm.worktree?.branch || null,
      worktreePath: sm.worktree?.worktreePath || null,
      invocationPayload,
      humanSummary: `The plan at '${planLabel}' is blank. Invoke ${ROLE_TITLE_PLANNER} with Model '${subagent.model}' to write it (or supply a plan with \`codeloop implement --plan-path <file>\`), then run \`codeloop next\` again.`,
      planBlank: true
    };
  }

  /**
   * Appends the blank-plan diagnosis + recovery to the APPROVAL gate
   * (issue #267). Returns an empty string when the plan is real.
   */
  private buildBlankPlanDiagnosis(
    sm: StateMachine,
    cwd: string,
    activeIssue: number | string | null
  ): string {
    if (!this.planGenerator) {
      return '';
    }
    try {
      const resolved = this.planGenerator.resolvePlanFile({
        projectRoot: cwd,
        issue: activeIssue,
        planPath: sm.planPath ?? undefined,
        planDir: sm.planDir,
        stage: STAGE_APPROVAL
      });
      if (!resolved) {
        return '';
      }
      const content = this.planGenerator.readPlanDocument(resolved.planPath);
      if (isPlanContentSubstantive(content)) {
        return '';
      }
      return `⚠ The plan at '${resolved.planPath}' is still the blank scaffold. Write the plan (or run \`codeloop plan --issue ${activeIssue ?? '<n>'}\`) before approving.`;
    } catch {
      return '';
    }
  }

  /**
   * A plan whose digest no longer matches the approved digest (or whose
   * approved file is gone) blocks dispatch: the gate cannot certify an
   * artifact it was not handed (issue #298).
   *
   * Issue #327 (Defect 2): the blocker prescribes RE-PLANNING, so it names the
   * legal sequence — including the fresh-approval hop that re-records the plan
   * digest — and `nextStage` names that recovery (PLAN), not an advance the run
   * cannot make.
   */
  private buildPlanIntegrityGateFailure(
    verification: GateVerification,
    baseBranch: string,
    taskBranch: string | null,
    worktreePath: string | null,
    issue: number | string | null,
    planDir: string | null
  ): DirectiveResult {
    const integrity = verification.integrity;
    const template =
      integrity.status === PLAN_INTEGRITY_MISSING
        ? MSG_PLAN_APPROVED_MISSING
        : MSG_PLAN_MODIFIED_AFTER_APPROVAL;
    const detail = template
      .replace('{path}', integrity.planPath ?? '(unknown plan path)')
      .replace('{expected}', integrity.expectedDigest ?? '(none)')
      .replace('{actual}', integrity.actualDigest ?? '(unreadable)');
    const inspected = integrity.planPath ?? '(unknown plan path)';
    const recovery = formatPlanReapprovalRecovery(issue, planDir);

    return {
      currentStage: STAGE_QUALITY_GATE,
      nextStage: STAGE_PLAN,
      actionType: 'human_gate',
      title: 'Plan Integrity Gate',
      description: `Quality Gate: FAILED — ${detail} The gate was not dispatched and the plan was not edited.`,
      baseBranch,
      taskBranch,
      worktreePath,
      humanSummary: `The approved plan is no longer the plan on disk (${integrity.status}); inspected \`${inspected}\`. To fix it, ${recovery}. The gate was not dispatched.`
    };
  }

  /**
   * A gate target the gate cannot execute as approved: a committed-tree
   * assertion (#348), an entry the parser refused (#369, was #372), or a
   * workflow change the composed list cannot lint (#369, was #368).
   *
   * A legacy checkpoint approved by an older build is refused here instead of
   * being dispatched to a gate that must fail. The pinned title is unchanged.
   */
  private buildGateTargetContractFailure(
    verification: GateVerification,
    baseBranch: string,
    taskBranch: string | null,
    worktreePath: string | null,
    issue: number | string | null,
    planDir: string | null
  ): DirectiveResult {
    const detail = formatGateTargetContractViolations(verification.targetFindings);

    return {
      currentStage: STAGE_QUALITY_GATE,
      nextStage: STAGE_PLAN,
      actionType: 'human_gate',
      title: 'Quality Gate Targets Cannot Pass',
      description: `Quality Gate: FAILED — ${detail}`,
      baseBranch,
      taskBranch,
      worktreePath,
      humanSummary: `The approved plan's Quality Gate Targets cannot be executed as approved: ${detail} Inspected \`${verification.planPath ?? '(unknown plan path)'}\`. Gate commands run in the task worktree against the UNCOMMITTED change, before the commit gate, with no synthetic commit. To fix it, ${formatPlanReapprovalRecovery(issue, planDir)}. The gate was not dispatched and no command ran.`
    };
  }

  /**
   * A smoke protocol the gate cannot execute as written blocks dispatch
   * (issue #298). The certifier never amends the artifact it certifies.
   *
   * Issue #327 (Defect 2): the blocker prescribes fixing the plan and
   * re-approving it, so it must name a sequence the state machine allows
   * (`QUALITY_GATE -> PLAN` was widened for exactly this) and point
   * `nextStage` at that recovery.
   */
  private buildSmokeProtocolGateFailure(
    verification: GateVerification,
    baseBranch: string,
    taskBranch: string | null,
    worktreePath: string | null,
    issue: number | string | null,
    planDir: string | null
  ): DirectiveResult {
    const detail = verification.smoke.findings
      .map((finding) =>
        MSG_SMOKE_PROTOCOL_NOT_EXECUTABLE
          .replace('{check}', finding.label || `Check ${finding.checkIndex}`)
          .replace('{line}', String(finding.line))
          .replace('{rule}', finding.rule)
          .replace('{excerpt}', finding.excerpt)
      )
      .join(' ');

    return {
      currentStage: STAGE_QUALITY_GATE,
      nextStage: STAGE_PLAN,
      actionType: 'human_gate',
      title: 'Manual Smoke Test Protocol Not Executable',
      description: `Quality Gate: FAILED — ${detail}`,
      baseBranch,
      taskBranch,
      worktreePath,
      humanSummary: `The approved plan's Manual Smoke Test Protocol cannot be executed as written (${verification.smoke.findings.length} finding(s)); inspected \`${verification.planPath ?? '(unknown plan path)'}\`. To fix it, ${formatPlanReapprovalRecovery(issue, planDir)}. The gate was not dispatched and the plan was not edited.`
    };
  }

  /**
   * "The worktree is gone — re-provision it" (issue #287 B / #266 D5).
   *
   * `codeloop implement` is the ONE command that re-provisions: at IMPLEMENT it
   * resumes and creates the worktree when `sm.worktree` is null
   * (`start-implementation.ts`); at APPROVAL (YOLO) it transitions and
   * provisions on the way. `next` never mutates the checkpoint to do this.
   *
   * `nextStage` never advances: dispatching IMPLEMENT without a worktree would
   * violate the Zero Direct Root Mutation invariant the assertion used to raise.
   */
  private buildMissingWorktreeDirective(
    sm: StateMachine,
    baseBranch: string
  ): DirectiveResult {
    const command = sm.issue ? `codeloop implement --issue ${sm.issue}` : 'codeloop implement';
    return {
      currentStage: sm.currentStage,
      nextStage: sm.currentStage,
      actionType: 'human_gate',
      title: 'Worktree Required',
      description: NOTE_WORKTREE_MISSING_REPROVISION.replace('{command}', command),
      baseBranch,
      taskBranch: null,
      worktreePath: null,
      humanSummary: `No isolated worktree is recorded for this checkpoint. Run \`${command}\`, then run \`codeloop next\` again.`
    };
  }
}
