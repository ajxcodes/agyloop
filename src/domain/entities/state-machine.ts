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
  MODE_STANDARD,
  STATE_SCHEMA_VERSION,
  EXECUTION_MODES
} from '../constants';
import { Stage } from '../value-objects/stage';
import { IssueNumber } from '../value-objects/issue-number';
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
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly StateHistoryEntry[];
}

export interface StateStatusSummary {
  readonly currentStage: StageName;
  readonly mode: ExecutionMode;
  readonly issue: number | null;
  readonly stepCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class StateMachine {
  private _stage: Stage;
  private _mode: ExecutionMode;
  private _issue: IssueNumber | null;
  private _createdAt: string;
  private _updatedAt: string;
  private _history: StateHistoryEntry[];

  constructor(options: {
    stage?: Stage;
    mode?: ExecutionMode;
    issue?: IssueNumber | null;
    createdAt?: string;
    updatedAt?: string;
    history?: readonly StateHistoryEntry[];
  } = {}) {
    this._stage = options.stage || new Stage(STAGE_INITIALIZED);
    this._mode = options.mode || MODE_STANDARD;
    this._issue = options.issue || null;
    const now = new Date().toISOString();
    this._createdAt = options.createdAt || now;
    this._updatedAt = options.updatedAt || now;

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

  public get createdAt(): string {
    return this._createdAt;
  }

  public get updatedAt(): string {
    return this._updatedAt;
  }

  public get history(): readonly StateHistoryEntry[] {
    return Object.freeze([...this._history]);
  }

  public setIssue(issue: number | string | null | undefined): void {
    this._issue = IssueNumber.tryFrom(issue);
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
      stepCount: this._history.length,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt
    };
  }

  public toSnapshot(): StateMachineSnapshot {
    return {
      version: STATE_SCHEMA_VERSION,
      currentStage: this._stage.value,
      mode: this._mode,
      issue: this.issue,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      history: Object.freeze([...this._history])
    };
  }

  public static fromSnapshot(snapshot: StateMachineSnapshot): StateMachine {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new ValidationError('snapshot', snapshot, 'State snapshot must be an object.');
    }

    const stage = new Stage(snapshot.currentStage);
    const mode = snapshot.mode || MODE_STANDARD;
    const issue = IssueNumber.tryFrom(snapshot.issue);

    return new StateMachine({
      stage,
      mode,
      issue,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      history: snapshot.history || []
    });
  }

  public static createInitial(options: {
    mode?: ExecutionMode;
    issue?: number | string | null;
  } = {}): StateMachine {
    return new StateMachine({
      stage: new Stage(STAGE_INITIALIZED),
      mode: options.mode || MODE_STANDARD,
      issue: IssueNumber.tryFrom(options.issue)
    });
  }
}
