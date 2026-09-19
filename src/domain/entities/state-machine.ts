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
  STAGE_PLAN,
  MODE_STANDARD,
  STATE_SCHEMA_VERSION,
  EXECUTION_MODES
} from '../constants';
import { Stage } from '../value-objects/stage';
import { IssueNumber } from '../value-objects/issue-number';
import { WorktreeDescriptor } from '../value-objects/worktree-descriptor';
import { InvalidTransitionError, ValidationError } from '../errors';

export interface StateHistoryEntry {
  readonly stage: StageName;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
}

export interface StateMachineSnapshot {
  readonly version: string;
  readonly currentStage: StageName;
  readonly mode: ExecutionMode;
  readonly issue: number | null;
  readonly baseBranch?: string | null;
  readonly worktree?: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly StateHistoryEntry[];
  readonly pausedAtGate?: string | null;
  readonly pausedAtTimestamp?: string | null;
  readonly totalHumanWaitMs?: number;
  readonly planRevisionCount?: number;
}

export interface StateStatusSummary {
  readonly currentStage: StageName;
  readonly mode: ExecutionMode;
  readonly issue: number | null;
  readonly baseBranch?: string | null;
  readonly worktree?: WorktreeDescriptor | null;
  readonly stepCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pausedAtGate?: string | null;
  readonly totalHumanWaitMs: number;
  readonly activeExecutionDurationMs: number;
  readonly planRevisionCount: number;
}

export class StateMachine {
  private _stage: Stage;
  private _mode: ExecutionMode;
  private _issue: IssueNumber | null;
  private _baseBranch: string | null;
  private _worktree: WorktreeDescriptor | null;
  private _createdAt: string;
  private _updatedAt: string;
  private _history: StateHistoryEntry[];
  private _pausedAtGate: string | null;
  private _pausedAtTimestamp: string | null;
  private _totalHumanWaitMs: number;
  private _planRevisionCount: number;

  constructor(options: {
    stage?: Stage;
    mode?: ExecutionMode;
    issue?: IssueNumber | null;
    baseBranch?: string | null;
    worktree?: WorktreeDescriptor | null;
    createdAt?: string;
    updatedAt?: string;
    history?: readonly StateHistoryEntry[];
    pausedAtGate?: string | null;
    pausedAtTimestamp?: string | null;
    totalHumanWaitMs?: number;
    planRevisionCount?: number;
  } = {}) {
    this._stage = options.stage || new Stage(STAGE_INITIALIZED);
    this._mode = options.mode || MODE_STANDARD;
    this._issue = options.issue || null;
    this._baseBranch = options.baseBranch || null;
    this._worktree = options.worktree || null;
    const now = new Date().toISOString();
    this._createdAt = options.createdAt || now;
    this._updatedAt = options.updatedAt || now;
    this._pausedAtGate = options.pausedAtGate || null;
    this._pausedAtTimestamp = options.pausedAtTimestamp || null;
    this._totalHumanWaitMs = typeof options.totalHumanWaitMs === 'number' ? options.totalHumanWaitMs : 0;
    this._planRevisionCount = typeof options.planRevisionCount === 'number' ? options.planRevisionCount : 0;

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

  public get baseBranch(): string | null {
    return this._baseBranch;
  }

  public get worktree(): WorktreeDescriptor | null {
    return this._worktree;
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

  public pauseAtGate(gateName: string): void {
    if (!this._pausedAtTimestamp) {
      this._pausedAtGate = gateName;
      this._pausedAtTimestamp = new Date().toISOString();
      this._updatedAt = this._pausedAtTimestamp;
    }
  }

  public resumeFromGate(): void {
    if (this._pausedAtTimestamp) {
      const elapsed = Date.now() - new Date(this._pausedAtTimestamp).getTime();
      if (elapsed > 0) {
        this._totalHumanWaitMs += elapsed;
      }
      this._pausedAtGate = null;
      this._pausedAtTimestamp = null;
      this._updatedAt = new Date().toISOString();
    }
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

  public setBaseBranch(baseBranch: string | null | undefined): void {
    this._baseBranch = baseBranch && baseBranch.trim() ? baseBranch.trim() : null;
    this._updatedAt = new Date().toISOString();
  }

  public setWorktree(worktree: WorktreeDescriptor | null | undefined): void {
    this._worktree = worktree || null;
    this._updatedAt = new Date().toISOString();
  }

  public setMode(mode: ExecutionMode): void {
    if (!Object.values(EXECUTION_MODES).includes(mode)) {
      throw new ValidationError('mode', mode, `Invalid execution mode: ${mode}`);
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

    if (this._stage.value === STAGE_APPROVAL && target.value === STAGE_PLAN) {
      this._planRevisionCount++;
    }

    const now = new Date().toISOString();
    this._stage = target;
    this._updatedAt = now;
    this._history.push({
      stage: target.value,
      timestamp: now,
      metadata: Object.freeze({ ...metadata })
    });
  }

  public reset(mode?: ExecutionMode, issue?: number | string | null): void {
    const now = new Date().toISOString();
    this._stage = new Stage(STAGE_INITIALIZED);
    if (mode) {
      this._mode = mode;
    }
    this._issue = IssueNumber.tryFrom(issue);
    this._baseBranch = null;
    this._worktree = null;
    this._pausedAtGate = null;
    this._pausedAtTimestamp = null;
    this._totalHumanWaitMs = 0;
    this._planRevisionCount = 0;
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
      baseBranch: this._baseBranch,
      worktree: this._worktree,
      stepCount: this._history.length,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      pausedAtGate: this._pausedAtGate,
      totalHumanWaitMs: this._totalHumanWaitMs,
      activeExecutionDurationMs: this.activeExecutionDurationMs(),
      planRevisionCount: this._planRevisionCount
    };
  }

  public toSnapshot(): StateMachineSnapshot {
    return {
      version: STATE_SCHEMA_VERSION,
      currentStage: this._stage.value,
      mode: this._mode,
      issue: this.issue,
      baseBranch: this._baseBranch,
      worktree: this._worktree ? this._worktree.toJSON() : null,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      history: Object.freeze([...this._history]),
      pausedAtGate: this._pausedAtGate,
      pausedAtTimestamp: this._pausedAtTimestamp,
      totalHumanWaitMs: this._totalHumanWaitMs,
      planRevisionCount: this._planRevisionCount
    };
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
    const baseBranch = snapshot.baseBranch || null;

    return new StateMachine({
      stage,
      mode,
      issue,
      baseBranch,
      worktree,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      history: snapshot.history || [],
      pausedAtGate: snapshot.pausedAtGate || null,
      pausedAtTimestamp: snapshot.pausedAtTimestamp || null,
      totalHumanWaitMs: typeof snapshot.totalHumanWaitMs === 'number' ? snapshot.totalHumanWaitMs : 0,
      planRevisionCount: typeof snapshot.planRevisionCount === 'number' ? snapshot.planRevisionCount : 0
    });
  }

  public static createInitial(options: {
    mode?: ExecutionMode;
    issue?: number | string | null;
    baseBranch?: string | null;
    worktree?: WorktreeDescriptor | null;
  } = {}): StateMachine {
    return new StateMachine({
      stage: new Stage(STAGE_INITIALIZED),
      mode: options.mode || MODE_STANDARD,
      issue: IssueNumber.tryFrom(options.issue),
      baseBranch: options.baseBranch,
      worktree: options.worktree
    });
  }
}
