/**
 * agyloop - GetPipelineStatusUseCase
 *
 * Rehydrates StateMachine and returns current pipeline status summary and history.
 */

import { StateMachine, StateStatusSummary, StateHistoryEntry, MODE_STANDARD } from '../domain';
import { StateRepository } from '../ports';

export interface TaskStatusSummary {
  readonly issue: number | null;
  readonly status: StateStatusSummary;
  readonly stateFilePath?: string;
}

export interface PipelineStatusResult {
  readonly status: StateStatusSummary;
  readonly history: readonly StateHistoryEntry[];
  readonly stateFilePath: string;
  readonly activeTasks: readonly TaskStatusSummary[];
}

export class GetPipelineStatusUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(): Promise<PipelineStatusResult> {
    const snapshot = await this.stateRepo.load();
    const sm = snapshot
      ? StateMachine.fromSnapshot(snapshot)
      : StateMachine.createInitial({ mode: MODE_STANDARD });

    const allSnapshots = typeof this.stateRepo.listAllStates === 'function'
      ? await this.stateRepo.listAllStates()
      : (snapshot ? [snapshot] : []);
    const activeTasks: TaskStatusSummary[] = (allSnapshots || []).map((s) => {
      const taskSm = StateMachine.fromSnapshot(s);
      return {
        issue: s.issue ?? null,
        status: taskSm.getStatus()
      };
    });

    return {
      status: sm.getStatus(),
      history: sm.history,
      stateFilePath: this.stateRepo.getStateFilePath(),
      activeTasks
    };
  }
}
