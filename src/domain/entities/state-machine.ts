/**
 * agyloop - Pure StateMachine Domain Entity
 *
 * Deterministic lifecycle state machine coordinating the 7-stage pair-programming contract:
 * INITIALIZED -> DISCOVERY -> PLAN -> APPROVAL -> IMPLEMENT -> QUALITY_GATE -> REVIEW -> COMMIT -> COMPLETED
 *
 * Pure domain entity: 100% free of filesystem, child processes, or network I/O.
 */

import {
  StageName,
  ExecutionMode,
  STAGE_INITIALIZED,
  STAGE_APPROVAL,
  STAGE_COMPLETED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_IMPLEMENT,
  STAGE_REVIEW,
  MODE_PLAN,
  MODE_STANDARD,
  STATE_SCHEMA_VERSION,
  EXECUTION_MODES,
  HUMAN_WAIT_GATES
} from '../constants';
import { Stage } from '../value-objects/stage';
import { IssueNumber } from '../value-objects/issue-number';
import { WorktreeDescriptor } from '../value-objects/worktree-descriptor';
import { TriageDisposition, TriageDispositionSerialized } from '../value-objects/triage-disposition';
import {
  WorkspaceMutationBaseline,
  isWorkspaceMutationBaseline
} from '../value-objects/workspace-mutation';
import { InvalidTransitionError, ValidationError } from '../errors';

export interface StateHistoryEntry {
  readonly stage: StageName;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The stages `mode: plan` legitimately DESCRIBES (#339 item 11).
 *
 * A plan-only run halted at APPROVAL is exactly that — still plan. The first
 * transition past APPROVAL is real implementation work, so the CHECKPOINT FIELD
 * itself flips to `standard`: `status` prints the raw field, and the field and
 * the rendered `Execution Mode` cell must never disagree.
 */
const PLAN_PHASE_STAGES: ReadonlySet<string> = new Set<string>([
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL
]);

/**
 * What this run recorded about its delivery PR (issue #315, AC-24 / #332).
 *
 * `missing` is the meaningful case: the branch was pushed and the checkpoint
 * still reached COMPLETED, so the report must say the run is NOT delivered
 * rather than let a terminal stage imply it was.
 */
export type RecordedPullRequestStatus = 'created' | 'existing' | 'missing';

export interface RecordedPullRequest {
  readonly number: number | null;
  readonly url: string | null;
  readonly status: RecordedPullRequestStatus;
}

export interface StateMachineSnapshot {
  readonly version: string;
  readonly currentStage: StageName;
  readonly mode: ExecutionMode;
  readonly issue: number | null;
  readonly milestoneTitle?: string | null;
  readonly baseBranch?: string | null;
  readonly worktree?: Record<string, unknown> | null;
  readonly planDir?: string | null;
  /**
   * An operator-supplied plan FILE (issue #267). When present it wins over any
   * directory resolution, so the lifecycle executes exactly the document the
   * operator handed in.
   */
  readonly planPath?: string | null;
  readonly triagePayload?: string | null;
  /**
   * The recorded triage disposition (issue #269). Its ABSENCE is meaningful:
   * a checkpoint without one has never dispositioned any feedback, so the
   * TRIAGE detector must see the pull request's feedback afresh.
   */
  readonly triageDisposition?: TriageDispositionSerialized | null;
  /**
   * The sha256 of the NORMALIZED approved plan (issue #298). A checkpoint
   * without one predates the contract and is reported UNVERIFIED, never
   * broken.
   */
  readonly approvedPlanDigest?: string | null;
  /** The plan path the digest was taken from (issue #298). */
  readonly approvedPlanPath?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly StateHistoryEntry[];
  readonly pausedAtGate?: string | null;
  readonly pausedAtTimestamp?: string | null;
  readonly totalHumanWaitMs?: number;
  readonly planRevisionCount?: number;
  readonly implementToGateLoops?: number;
  /**
   * How many times the current REVIEW round has dispatched the reviewer
   * without a verdict being filed (issue #272). Optional: a checkpoint written
   * before this field loads as `0`.
   */
  readonly reviewDispatchCount?: number;
  /**
   * How many times the current DISCOVERY stage has dispatched the discovery
   * subagent without the report being populated (issue #292). Optional: a
   * checkpoint written before this field loads as `0`.
   */
  readonly discoveryDispatchCount?: number;
  /**
   * How many times the current PLAN stage has dispatched the planner without
   * the plan becoming non-blank (issue #292).
   */
  readonly planDispatchCount?: number;
  /**
   * How many times the current IMPLEMENT stage has dispatched the implementer
   * without an implementation diff appearing in the task worktree
   * (issue #327). Optional: a checkpoint written before this field loads as `0`.
   */
  readonly implementationDispatchCount?: number;
  /**
   * How many blank-plan parks the run has recorded at IMPLEMENT (issue #267).
   * Reset when the pipeline re-enters PLAN.
   */
  readonly planEmptyParkCount?: number;
  /**
   * The delivery PR this run recorded on reaching COMPLETED (issue #315,
   * AC-24). Optional: a checkpoint written before this field loads as `null`,
   * which means "not recorded" — never "delivered".
   */
  readonly pullRequest?: RecordedPullRequest | null;
  /**
   * The dispatch-time scoped-write reference for the current DISCOVERY round
   * (issue #389). Optional: a checkpoint written before this field loads as
   * `null`, which means "not measured" — never "clean".
   */
  readonly discoveryMutationBaseline?: WorkspaceMutationBaseline | null;
}

export interface StateStatusSummary {
  readonly currentStage: StageName;
  readonly mode: ExecutionMode;
  readonly issue: number | null;
  readonly milestoneTitle?: string | null;
  readonly baseBranch?: string | null;
  readonly worktree?: WorktreeDescriptor | null;
  readonly planDir?: string | null;
  /** The operator-supplied plan file, when one was recorded (issue #267). */
  readonly planPath?: string | null;
  readonly triagePayload?: string | null;
  readonly triageDisposition?: TriageDispositionSerialized | null;
  readonly stepCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pausedAtGate?: string | null;
  readonly totalHumanWaitMs: number;
  readonly activeExecutionDurationMs: number;
  readonly planRevisionCount: number;
  readonly implementToGateLoops: number;
  readonly reviewDispatchCount: number;
  readonly discoveryDispatchCount: number;
  readonly planDispatchCount: number;
  readonly implementationDispatchCount: number;
  readonly planEmptyParkCount: number;
}

export class StateMachine {
  private _stage: Stage;
  private _mode: ExecutionMode;
  private _issue: IssueNumber | null;
  private _milestoneTitle: string | null;
  private _baseBranch: string | null;
  private _worktree: WorktreeDescriptor | null;
  private _planDir: string | null;
  private _planPath: string | null;
  private _approvedPlanDigest: string | null;
  private _approvedPlanPath: string | null;
  private _triagePayload: string | null;
  private _triageDisposition: TriageDisposition | null;
  private _createdAt: string;
  private _updatedAt: string;
  private _history: StateHistoryEntry[];
  private _pausedAtGate: string | null;
  private _pausedAtTimestamp: string | null;
  private _totalHumanWaitMs: number;
  private _planRevisionCount: number;
  private _implementToGateLoops: number;
  private _reviewDispatchCount: number;
  private _discoveryDispatchCount: number;
  private _planDispatchCount: number;
  private _implementationDispatchCount: number;
  private _planEmptyParkCount: number;
  private _pullRequest: RecordedPullRequest | null;
  private _discoveryMutationBaseline: WorkspaceMutationBaseline | null;

  constructor(options: {
    stage?: Stage;
    mode?: ExecutionMode;
    issue?: IssueNumber | null;
    milestoneTitle?: string | null;
    baseBranch?: string | null;
    worktree?: WorktreeDescriptor | null;
    planDir?: string | null;
    planPath?: string | null;
    approvedPlanDigest?: string | null;
    approvedPlanPath?: string | null;
    triagePayload?: string | null;
    triageDisposition?: TriageDisposition | null;
    createdAt?: string;
    updatedAt?: string;
    history?: readonly StateHistoryEntry[];
    pausedAtGate?: string | null;
    pausedAtTimestamp?: string | null;
    totalHumanWaitMs?: number;
    planRevisionCount?: number;
    implementToGateLoops?: number;
    reviewDispatchCount?: number;
    discoveryDispatchCount?: number;
    planDispatchCount?: number;
    implementationDispatchCount?: number;
    planEmptyParkCount?: number;
    pullRequest?: RecordedPullRequest | null;
    discoveryMutationBaseline?: WorkspaceMutationBaseline | null;
  } = {}) {
    this._stage = options.stage || new Stage(STAGE_INITIALIZED);
    this._mode = options.mode || MODE_STANDARD;
    this._issue = options.issue || null;
    this._milestoneTitle = options.milestoneTitle && options.milestoneTitle.trim() ? options.milestoneTitle.trim() : null;
    this._baseBranch = options.baseBranch || null;
    this._worktree = options.worktree || null;
    this._planDir = options.planDir || null;
    this._planPath = options.planPath || null;
    this._approvedPlanDigest = options.approvedPlanDigest || null;
    this._approvedPlanPath = options.approvedPlanPath || null;
    this._triagePayload = options.triagePayload || null;
    this._triageDisposition = options.triageDisposition || null;
    const now = new Date().toISOString();
    this._createdAt = options.createdAt || now;
    this._updatedAt = options.updatedAt || now;
    this._pausedAtGate = options.pausedAtGate || null;
    this._pausedAtTimestamp = options.pausedAtTimestamp || null;
    this._totalHumanWaitMs = typeof options.totalHumanWaitMs === 'number' ? options.totalHumanWaitMs : 0;
    this._planRevisionCount = typeof options.planRevisionCount === 'number' ? options.planRevisionCount : 0;
    this._implementToGateLoops = typeof options.implementToGateLoops === 'number' ? options.implementToGateLoops : 0;
    this._reviewDispatchCount = typeof options.reviewDispatchCount === 'number' ? options.reviewDispatchCount : 0;
    this._discoveryDispatchCount =
      typeof options.discoveryDispatchCount === 'number' ? options.discoveryDispatchCount : 0;
    this._planDispatchCount =
      typeof options.planDispatchCount === 'number' ? options.planDispatchCount : 0;
    this._implementationDispatchCount =
      typeof options.implementationDispatchCount === 'number'
        ? options.implementationDispatchCount
        : 0;
    this._planEmptyParkCount =
      typeof options.planEmptyParkCount === 'number' ? options.planEmptyParkCount : 0;
    this._pullRequest = options.pullRequest ?? null;
    this._discoveryMutationBaseline =
      options.discoveryMutationBaseline && isWorkspaceMutationBaseline(options.discoveryMutationBaseline)
        ? options.discoveryMutationBaseline
        : null;

    if (options.history && options.history.length > 0) {
      this._history = [...options.history];
    } else {
      this._history = [
        {
          stage: this._stage.value,
          timestamp: now,
          metadata: { note: 'Pipeline initialized' }
        }
      ];
    }
  }

  public get stage(): Stage {
    return this._stage;
  }

  public get currentStage(): StageName {
    return this._stage.value;
  }

  public get mode(): ExecutionMode {
    return this._mode;
  }

  public get issue(): number | null {
    return this._issue ? this._issue.value : null;
  }

  public get issueNumber(): IssueNumber | null {
    return this._issue;
  }

  public get milestoneTitle(): string | null {
    return this._milestoneTitle;
  }

  public get baseBranch(): string | null {
    return this._baseBranch;
  }

  public get worktree(): WorktreeDescriptor | null {
    return this._worktree;
  }

  public get planDir(): string | null {
    return this._planDir;
  }

  /** The operator-supplied plan file, or null when none was recorded. */
  public get planPath(): string | null {
    return this._planPath;
  }

  /** The digest of the approved plan bytes, or null when never recorded. */
  public get approvedPlanDigest(): string | null {
    return this._approvedPlanDigest;
  }

  /** The plan path the approved digest was taken from. */
  public get approvedPlanPath(): string | null {
    return this._approvedPlanPath;
  }

  /**
   * Records the approved plan's identity (issue #298). Called on a real
   * approval, and on entering IMPLEMENT from a fresh approval — never on a
   * retry/self-correction re-entry, which must preserve the frozen bytes.
   */
  public recordApprovedPlan(planPath: string | null | undefined, digest: string | null | undefined): void {
    this._approvedPlanPath = planPath && planPath.trim() ? planPath.trim() : null;
    this._approvedPlanDigest = digest && digest.trim().length > 0 ? digest : null;
    this._updatedAt = new Date().toISOString();
  }

  public get triagePayload(): string | null {
    return this._triagePayload;
  }

  /**
   * The recorded triage disposition, or `null` when none was ever taken.
   */
  public get triageDisposition(): TriageDisposition | null {
    return this._triageDisposition;
  }

  public get createdAt(): string {
    return this._createdAt;
  }

  public get updatedAt(): string {
    return this._updatedAt;
  }

  public get history(): readonly StateHistoryEntry[] {
    return Object.freeze([...this._history]);
  }

  public get pausedAtGate(): string | null {
    return this._pausedAtGate;
  }

  public get pausedAtTimestamp(): string | null {
    return this._pausedAtTimestamp;
  }

  public get totalHumanWaitMs(): number {
    return this._totalHumanWaitMs;
  }

  public get planRevisionCount(): number {
    return this._planRevisionCount;
  }

  public get implementToGateLoops(): number {
    return this._implementToGateLoops;
  }

  public incrementImplementGateLoop(): void {
    this._implementToGateLoops++;
    this._updatedAt = new Date().toISOString();
  }

  public get reviewDispatchCount(): number {
    return this._reviewDispatchCount;
  }

  /**
   * Records one reviewer dispatch in the current REVIEW round (issue #272).
   *
   * Mirrors `incrementImplementGateLoop`: the counter is a context field, so
   * `next` may record it without advancing a stage.
   */
  public recordReviewDispatch(): void {
    this._reviewDispatchCount++;
    this._updatedAt = new Date().toISOString();
  }

  public get discoveryDispatchCount(): number {
    return this._discoveryDispatchCount;
  }

  /**
   * Records one discovery-subagent dispatch in the current DISCOVERY stage
   * (issue #292). A context field: `next` may record it without advancing.
   */
  public recordDiscoveryDispatch(): void {
    this._discoveryDispatchCount++;
    this._updatedAt = new Date().toISOString();
  }

  /**
   * The scoped-write reference captured at the current DISCOVERY dispatch
   * (issue #389). `null` means unmeasured.
   */
  public get discoveryMutationBaseline(): WorkspaceMutationBaseline | null {
    return this._discoveryMutationBaseline;
  }

  /**
   * Records the dispatch-time boundary reference (issue #389).
   *
   * A context field on the read path, like `recordDiscoveryDispatch`: `next`
   * may record it without advancing a stage. The use case captures it at most
   * once per round (earliest wins) so a second dispatch cannot launder the
   * first run's writes.
   */
  public setDiscoveryMutationBaseline(baseline: WorkspaceMutationBaseline | null): void {
    this._discoveryMutationBaseline = baseline;
    this._updatedAt = new Date().toISOString();
  }

  public get planDispatchCount(): number {
    return this._planDispatchCount;
  }

  /** Records one planner dispatch in the current PLAN stage (issue #292). */
  public recordPlanDispatch(): void {
    this._planDispatchCount++;
    this._updatedAt = new Date().toISOString();
  }

  public get implementationDispatchCount(): number {
    return this._implementationDispatchCount;
  }

  /**
   * Records one implementer dispatch in the current IMPLEMENT stage
   * (issue #327). Mirrors `recordPlanDispatch`: a context field, so `next` may
   * record it without advancing a stage.
   */
  public recordImplementationDispatch(): void {
    this._implementationDispatchCount++;
    this._updatedAt = new Date().toISOString();
  }

  public get planEmptyParkCount(): number {
    return this._planEmptyParkCount;
  }

  /** The delivery PR recorded on reaching COMPLETED, or null when none is recorded. */
  public get pullRequest(): RecordedPullRequest | null {
    return this._pullRequest;
  }

  /**
   * Records what this run did about the delivery PR (issue #315, AC-24).
   *
   * Called once, before the checkpoint is persisted at the COMMIT gate's exit,
   * so `status` and the `commit` output can tell "delivered" from "pushed with
   * no PR" instead of inferring it from a terminal stage.
   */
  public recordPullRequest(pullRequest: RecordedPullRequest): void {
    this._pullRequest = {
      number: typeof pullRequest.number === 'number' ? pullRequest.number : null,
      url: pullRequest.url && pullRequest.url.trim() ? pullRequest.url.trim() : null,
      status: pullRequest.status
    };
    this._updatedAt = new Date().toISOString();
  }

  /**
   * Records one blank-plan park at IMPLEMENT (issue #267). The count makes a
   * silently repeated park observable instead of an identical message.
   */
  public recordPlanEmptyPark(): void {
    this._planEmptyParkCount++;
    this._updatedAt = new Date().toISOString();
  }

  public resetImplementGateLoop(): void {
    this._implementToGateLoops = 0;
    this._updatedAt = new Date().toISOString();
  }

  public pauseAtGate(gateName: string): void {
    if (!this._pausedAtTimestamp) {
      this._pausedAtGate = gateName;
      this._pausedAtTimestamp = new Date().toISOString();
      this._updatedAt = this._pausedAtTimestamp;
    }
  }

  public resumeFromGate(): void {
    // A checkpoint written by an older schema (or hand-edited) can carry a gate
    // name with no timestamp. The pause is still a pause, so it must still be
    // cleared — otherwise that machine is un-resumable forever. Only the time
    // accounting needs the timestamp.
    if (!this._pausedAtTimestamp && !this._pausedAtGate) {
      return;
    }

    if (this._pausedAtTimestamp) {
      const elapsed = Date.now() - new Date(this._pausedAtTimestamp).getTime();
      if (elapsed > 0) {
        this._totalHumanWaitMs += elapsed;
      }
    }
    this._pausedAtGate = null;
    this._pausedAtTimestamp = null;
    this._updatedAt = new Date().toISOString();
  }

  public activeExecutionDurationMs(referenceTime?: number | Date | string): number {
    const endMs =
      referenceTime !== undefined && referenceTime !== null
        ? new Date(referenceTime).getTime()
        : Date.now();
    const startMs = new Date(this._createdAt).getTime();
    const totalElapsed = Math.max(0, endMs - startMs);
    let currentPause = 0;
    if (this._pausedAtTimestamp) {
      const pauseStart = new Date(this._pausedAtTimestamp).getTime();
      currentPause = Math.max(0, endMs - pauseStart);
    }
    return Math.max(0, totalElapsed - this._totalHumanWaitMs - currentPause);
  }

  public setIssue(issue: number | string | null | undefined): void {
    this._issue = IssueNumber.tryFrom(issue);
    this._updatedAt = new Date().toISOString();
  }

  public inferIssue(context?: {
    cwd?: string | null;
    branch?: string | null;
    worktreePath?: string | null;
  }): number | null {
    if (this._issue) {
      return this._issue.value;
    }
    const inferred = IssueNumber.inferFromContext({
      worktreePath: this._worktree?.worktreePath ?? context?.worktreePath,
      cwd: context?.cwd,
      branch: this._worktree?.branch ?? context?.branch
    });
    if (inferred !== null) {
      this.setIssue(inferred);
      return inferred;
    }
    return null;
  }

  public setMilestoneTitle(milestone: string | null | undefined): void {
    this._milestoneTitle = milestone && milestone.trim() ? milestone.trim() : null;
    this._updatedAt = new Date().toISOString();
  }

  public setBaseBranch(baseBranch: string | null | undefined): void {
    this._baseBranch = baseBranch && baseBranch.trim() ? baseBranch.trim() : null;
    this._updatedAt = new Date().toISOString();
  }

  public setWorktree(worktree: WorktreeDescriptor | null | undefined): void {
    this._worktree = worktree || null;
    this._updatedAt = new Date().toISOString();
  }

  public setPlanDir(dir: string | null | undefined): void {
    this._planDir = dir && dir.trim() ? dir.trim() : null;
    this._updatedAt = new Date().toISOString();
  }

  /**
   * Records the operator-supplied plan file (issue #267). It is an explicit
   * intent, not an inference: the lifecycle executes THIS document even when a
   * plan directory is also tracked.
   */
  public setPlanPath(planPath: string | null | undefined): void {
    this._planPath = planPath && planPath.trim() ? planPath.trim() : null;
    this._updatedAt = new Date().toISOString();
  }

  public setTriagePayload(payload: string | null | undefined): void {
    this._triagePayload = payload && payload.trim() ? payload.trim() : null;
    this._updatedAt = new Date().toISOString();
  }

  /**
   * Records the triage disposition (issue #269).
   *
   * The disposition is a FACT, not a gate: no pause is set by it. It is what
   * makes returning to the TRIAGE gate unnecessary, because the detector
   * consults it before routing.
   */
  public setTriageDisposition(disposition: TriageDisposition | null): void {
    this._triageDisposition = disposition || null;
    this._updatedAt = new Date().toISOString();
  }

  public setMode(mode: ExecutionMode): void {
    if (!Object.values(EXECUTION_MODES).includes(mode)) {
      throw new ValidationError('mode', mode, `Invalid execution mode: ${mode}`);
    }
    // Issue #278: setting the mode it ALREADY has is not a change. Mutating
    // `_updatedAt` here made a read-only bare `codeloop` rewrite the checkpoint
    // and advance the timestamp even though nothing happened.
    if (this._mode === mode) {
      return;
    }
    this._mode = mode;
    this._updatedAt = new Date().toISOString();
  }

  public canTransition(targetStage: string | Stage): boolean {
    try {
      const target = typeof targetStage === 'string' ? new Stage(targetStage) : targetStage;
      return this._stage.canTransitionTo(target, this._mode);
    } catch {
      return false;
    }
  }

  public transition(targetStage: string | Stage, metadata: Record<string, unknown> = {}): void {
    const target = typeof targetStage === 'string' ? new Stage(targetStage) : targetStage;

    if (!this.canTransition(target)) {
      throw new InvalidTransitionError(this._stage.value, target.value, this._mode);
    }

    const previousStage = this._stage.value;

    if (this._stage.value === STAGE_APPROVAL && target.value === STAGE_PLAN) {
      this._planRevisionCount++;
    }

    const now = new Date().toISOString();
    this._stage = target;
    this._updatedAt = now;
    // #339 (item 11): `plan` mode describes the PLAN phase. The first
    // transition past APPROVAL is real implementation work, so the CHECKPOINT
    // FIELD itself must change — `status` prints the raw field, and the field
    // and the rendered cell must never disagree (a COMPLETED run that
    // implemented/gated/reviewed/committed no longer renders `Execution Mode:
    // plan`). A plan-only run halted at APPROVAL keeps `plan` (truthful).
    // Only MODE_PLAN is affected; YOLO/standard and `setMode` are untouched,
    // and `isLegalTransition` is untouched — mode is not a legality input here.
    if (this._mode === MODE_PLAN && !PLAN_PHASE_STAGES.has(target.value)) {
      this._mode = MODE_STANDARD;
    }
    // A transition INTO REVIEW starts a fresh review round, so the dispatch
    // record of the previous round must not leak into it (issue #272).
    if (target.value === STAGE_REVIEW) {
      this._reviewDispatchCount = 0;
    }
    // Same rule for the two early-stage dispatch records (issue #292): a
    // transition INTO the stage starts a fresh round.
    if (target.value === STAGE_DISCOVERY) {
      this._discoveryDispatchCount = 0;
      // A new DISCOVERY round has a new boundary reference (issue #389).
      this._discoveryMutationBaseline = null;
    }
    // Leaving DISCOVERY ends the measurement window: later stages legitimately
    // build, so they must never be measured against a discovery baseline.
    if (previousStage === STAGE_DISCOVERY && target.value !== STAGE_DISCOVERY) {
      this._discoveryMutationBaseline = null;
    }
    if (target.value === STAGE_PLAN) {
      this._planDispatchCount = 0;
      this._planEmptyParkCount = 0;
    }
    // A transition INTO IMPLEMENT starts a fresh implementation round, so the
    // re-dispatch record of the previous round must not leak into it (#327).
    if (target.value === STAGE_IMPLEMENT) {
      this._implementationDispatchCount = 0;
    }
    this._history.push({
      stage: target.value,
      timestamp: now,
      metadata: Object.freeze({ ...metadata })
    });

    // The machine genuinely advanced (transitions to the current stage are not
    // allowed), so a pause at a NON-human gate is now stale: the condition that
    // halted the run — an exhausted retry budget, a quota rejection — was
    // resolved by this run getting further. Leaving `pausedAtGate` set would
    // make the checkpoint claim "waiting for a human" forever, and
    // `activeExecutionDurationMs()` would keep subtracting a pause that ended.
    //
    // Human gates are deliberately preserved: `TransitionStageUseCase`
    // transitions out of APPROVAL/COMMIT only after the human answered, and
    // TRIAGE hands control back to a human (see `HUMAN_WAIT_GATES`).
    //
    // COMPLETED is the exception, and it is not a special case bolted on: it is the
    // same rule bounded by "the run finished". A machine that has reached its terminal
    // stage is not waiting on a human, so the pause must be consumed (and its elapsed
    // time banked into `totalHumanWaitMs`) here. Without this, `ExecuteCommitUseCase`'s
    // `COMMIT -> COMPLETED` persisted `{ currentStage: COMPLETED, pausedAtGate: COMMIT }`
    // and, because COMMIT is in `HUMAN_WAIT_GATES`, no later transition could ever clear
    // it: `status` reported a finished pipeline that was also waiting on a human, and
    // `totalHumanWaitMs` stayed 0 forever (#226).
    const terminal = target.value === STAGE_COMPLETED;
    if (this._pausedAtGate !== null && (terminal || !HUMAN_WAIT_GATES.includes(this._pausedAtGate))) {
      this.resumeFromGate();
    }
  }

  public reset(mode?: ExecutionMode, issue?: number | string | null): void {
    const now = new Date().toISOString();
    this._stage = new Stage(STAGE_INITIALIZED);
    if (mode) {
      this._mode = mode;
    }
    this._issue = IssueNumber.tryFrom(issue);
    this._milestoneTitle = null;
    this._baseBranch = null;
    this._worktree = null;
    this._planDir = null;
    this._planPath = null;
    this._approvedPlanDigest = null;
    this._approvedPlanPath = null;
    this._triagePayload = null;
    // A re-opened task starts with NO disposition: the tool must see the
    // pull request's feedback again, because the task is being REDONE.
    this._triageDisposition = null;
    this._pausedAtGate = null;
    this._pausedAtTimestamp = null;
    this._totalHumanWaitMs = 0;
    this._planRevisionCount = 0;
    this._implementToGateLoops = 0;
    this._reviewDispatchCount = 0;
    this._discoveryDispatchCount = 0;
    this._planDispatchCount = 0;
    this._implementationDispatchCount = 0;
    this._planEmptyParkCount = 0;
    this._pullRequest = null;
    this._discoveryMutationBaseline = null;
    this._updatedAt = now;
    this._history = [
      {
        stage: STAGE_INITIALIZED,
        timestamp: now,
        metadata: { note: 'Pipeline reset' }
      }
    ];
  }

  public getStatus(): StateStatusSummary {
    return {
      currentStage: this._stage.value,
      mode: this._mode,
      issue: this.issue,
      milestoneTitle: this._milestoneTitle,
      baseBranch: this._baseBranch,
      worktree: this._worktree,
      planDir: this._planDir,
      planPath: this._planPath,
      triagePayload: this._triagePayload,
      triageDisposition: this._triageDisposition ? this._triageDisposition.toJSON() : null,
      stepCount: this._history.length,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      pausedAtGate: this._pausedAtGate,
      totalHumanWaitMs: this._totalHumanWaitMs,
      activeExecutionDurationMs: this.activeExecutionDurationMs(),
      planRevisionCount: this._planRevisionCount,
      implementToGateLoops: this._implementToGateLoops,
      reviewDispatchCount: this._reviewDispatchCount,
      discoveryDispatchCount: this._discoveryDispatchCount,
      planDispatchCount: this._planDispatchCount,
      implementationDispatchCount: this._implementationDispatchCount,
      planEmptyParkCount: this._planEmptyParkCount
    };
  }

  public toSnapshot(): StateMachineSnapshot {
    return {
      version: STATE_SCHEMA_VERSION,
      currentStage: this._stage.value,
      mode: this._mode,
      issue: this.issue,
      milestoneTitle: this._milestoneTitle,
      baseBranch: this._baseBranch,
      worktree: this._worktree ? this._worktree.toJSON() : null,
      planDir: this._planDir,
      planPath: this._planPath,
      approvedPlanDigest: this._approvedPlanDigest,
      approvedPlanPath: this._approvedPlanPath,
      triagePayload: this._triagePayload,
      triageDisposition: this._triageDisposition ? this._triageDisposition.toJSON() : null,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      history: Object.freeze([...this._history]),
      pausedAtGate: this._pausedAtGate,
      pausedAtTimestamp: this._pausedAtTimestamp,
      totalHumanWaitMs: this._totalHumanWaitMs,
      planRevisionCount: this._planRevisionCount,
      implementToGateLoops: this._implementToGateLoops,
      reviewDispatchCount: this._reviewDispatchCount,
      discoveryDispatchCount: this._discoveryDispatchCount,
      planDispatchCount: this._planDispatchCount,
      implementationDispatchCount: this._implementationDispatchCount,
      planEmptyParkCount: this._planEmptyParkCount,
      pullRequest: this._pullRequest,
      discoveryMutationBaseline: this._discoveryMutationBaseline
    };
  }

  public toJSON(): StateMachineSnapshot {
    return this.toSnapshot();
  }

  public static fromSnapshot(snapshot: StateMachineSnapshot): StateMachine {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new ValidationError('snapshot', snapshot, 'State snapshot must be an object.');
    }

    const stage = new Stage(snapshot.currentStage);
    const mode = snapshot.mode || MODE_STANDARD;
    const worktree = snapshot.worktree ? WorktreeDescriptor.fromJSON(snapshot.worktree) : null;
    let issue = IssueNumber.tryFrom(snapshot.issue);
    if (!issue && worktree) {
      const inferred = IssueNumber.inferFromContext({
        worktreePath: worktree.worktreePath,
        branch: worktree.branch
      });
      if (inferred !== null) {
        issue = IssueNumber.tryFrom(inferred);
      }
    }
    const milestoneTitle = snapshot.milestoneTitle || null;
    const baseBranch = snapshot.baseBranch || null;
    const planDir = snapshot.planDir || null;
    const planPath = snapshot.planPath || null;
    const approvedPlanDigest = snapshot.approvedPlanDigest || null;
    const approvedPlanPath = snapshot.approvedPlanPath || null;
    const triagePayload = snapshot.triagePayload || null;
    // A legacy checkpoint (no `triageDisposition` key) and a malformed one
    // both load as `null` — `fromJSON` never throws.
    const triageDisposition = TriageDisposition.fromJSON(snapshot.triageDisposition);
    // A legacy checkpoint has no `pullRequest` key: null means "not recorded",
    // never "delivered" (issue #315, AC-24). An unrecognised status is treated
    // as `missing` — the honest reading when the record is unusable.
    const rawPullRequest = snapshot.pullRequest;
    const pullRequest: RecordedPullRequest | null =
      rawPullRequest && typeof rawPullRequest === 'object'
        ? {
            number: typeof rawPullRequest.number === 'number' ? rawPullRequest.number : null,
            url: typeof rawPullRequest.url === 'string' && rawPullRequest.url.trim() ? rawPullRequest.url : null,
            status:
              rawPullRequest.status === 'created' ||
              rawPullRequest.status === 'existing' ||
              rawPullRequest.status === 'missing'
                ? rawPullRequest.status
                : 'missing'
          }
        : null;

    return new StateMachine({
      stage,
      mode,
      issue,
      milestoneTitle,
      baseBranch,
      worktree,
      planDir,
      planPath,
      approvedPlanDigest,
      approvedPlanPath,
      triagePayload,
      triageDisposition,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      history: snapshot.history || [],
      pausedAtGate: snapshot.pausedAtGate || null,
      pausedAtTimestamp: snapshot.pausedAtTimestamp || null,
      totalHumanWaitMs: typeof snapshot.totalHumanWaitMs === 'number' ? snapshot.totalHumanWaitMs : 0,
      planRevisionCount: typeof snapshot.planRevisionCount === 'number' ? snapshot.planRevisionCount : 0,
      implementToGateLoops: typeof snapshot.implementToGateLoops === 'number' ? snapshot.implementToGateLoops : 0,
      reviewDispatchCount: typeof snapshot.reviewDispatchCount === 'number' ? snapshot.reviewDispatchCount : 0,
      discoveryDispatchCount:
        typeof snapshot.discoveryDispatchCount === 'number' ? snapshot.discoveryDispatchCount : 0,
      planDispatchCount: typeof snapshot.planDispatchCount === 'number' ? snapshot.planDispatchCount : 0,
      implementationDispatchCount:
        typeof snapshot.implementationDispatchCount === 'number'
          ? snapshot.implementationDispatchCount
          : 0,
      planEmptyParkCount:
        typeof snapshot.planEmptyParkCount === 'number' ? snapshot.planEmptyParkCount : 0,
      pullRequest,
      discoveryMutationBaseline:
        snapshot.discoveryMutationBaseline &&
        isWorkspaceMutationBaseline(snapshot.discoveryMutationBaseline)
          ? snapshot.discoveryMutationBaseline
          : null
    });
  }

  public static fromJSON(json: StateMachineSnapshot): StateMachine {
    return StateMachine.fromSnapshot(json);
  }

  public static createInitial(options: {
    mode?: ExecutionMode;
    issue?: number | string | null;
    milestoneTitle?: string | null;
    baseBranch?: string | null;
    worktree?: WorktreeDescriptor | null;
    planDir?: string | null;
    planPath?: string | null;
    triagePayload?: string | null;
  } = {}): StateMachine {
    return new StateMachine({
      stage: new Stage(STAGE_INITIALIZED),
      mode: options.mode || MODE_STANDARD,
      issue: IssueNumber.tryFrom(options.issue),
      milestoneTitle: options.milestoneTitle,
      baseBranch: options.baseBranch,
      worktree: options.worktree,
      planDir: options.planDir,
      planPath: options.planPath
    });
  }
}
