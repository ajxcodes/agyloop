/**
 * agyloop - TransitionStageUseCase
 *
 * Rehydrates StateMachine, executes pure transition, and persists checkpoint.
 */

import { StateMachine, StageName, ExecutionMode, MODE_STANDARD } from '../domain';
import { StateRepository } from '../ports';

export interface TransitionParams {
  readonly targetStage: string | StageName;
  readonly metadata?: Record<string, unknown>;
  readonly mode?: ExecutionMode;
  readonly issue?: number | string | null;
  readonly dryRun?: boolean;
}

export class TransitionStageUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(params: TransitionParams): Promise<StateMachine> {
    const snapshot = await this.stateRepo.load();
    let sm: StateMachine;

    if (snapshot) {
      sm = StateMachine.fromSnapshot(snapshot);
      if (params.mode) sm.setMode(params.mode);
      if (params.issue !== undefined) sm.setIssue(params.issue);
    } else {
      sm = StateMachine.createInitial({
        mode: params.mode || MODE_STANDARD,
        issue: params.issue
      });
    }

    sm.transition(params.targetStage, params.metadata || {});

    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());
    }

    return sm;
  }
}
