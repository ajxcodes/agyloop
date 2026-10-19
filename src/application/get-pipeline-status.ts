/**
 * agyloop - GetPipelineStatusUseCase
 *
 * Rehydrates StateMachine and returns current pipeline status summary and history.
 */

import { StateMachine, StateStatusSummary, StateHistoryEntry, StateMachineSnapshot, MODE_STANDARD } from '../domain';
import { StateRepository } from '../ports';
import { resolveAuthoritativeCheckpoint } from './resolve-task-checkpoint';

export interface GetPipelineStatusParams {
  /** Explicit issue number. Omit to let the shared resolver choose (#226 D5). */
  readonly issue?: number | string | null;
}

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
  /** Issue the reported checkpoint belongs to; null when it is the root checkpoint. */
  readonly resolvedIssue: number | null;
  /**
   * The raw snapshot behind `status`, so the presentation layer can render the
   * pause block from the SAME checkpoint the header was built from instead of
   * re-loading a possibly different file (#226 D5/D6 coupling).
   */
  readonly resolvedSnapshot: StateMachineSnapshot | null;
}

export class GetPipelineStatusUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(params: GetPipelineStatusParams = {}): Promise<PipelineStatusResult> {
    // One resolver, one answer. `stateRepo.load()` was used to bind to
    // `.agyloop/state.json` whenever no `--issue` was given and the cwd carried no
    // worktree hint, which made `status` advertise the root checkpoint even while
    // the real run lived in `.agyloop/tasks/<n>.json` (#226 D5).
    const resolved = await resolveAuthoritativeCheckpoint(this.stateRepo, params.issue);
    const snapshot = resolved?.snapshot ?? null;
    const sm = snapshot
      ? StateMachine.fromSnapshot(snapshot)
      : StateMachine.createInitial({ mode: MODE_STANDARD });

    const allSnapshots = typeof this.stateRepo.listAllStates === 'function'
      ? await this.stateRepo.listAllStates()
      : (snapshot ? [snapshot] : []);
    const activeTasks: TaskStatusSummary[] = (allSnapshots || []).map((s) => {
      const taskSm = StateMachine.fromSnapshot(s);
      const taskIssue = s.issue ?? null;
      // Previously declared on `TaskStatusSummary` and never assigned, so every
      // row of the matrix pointed nowhere. Each row owns exactly one file; the
      // root row (issue === null) falls back to this repository's own path.
      const taskStateFilePath = taskIssue !== null && typeof this.stateRepo.forIssue === 'function'
        ? this.stateRepo.forIssue(taskIssue).getStateFilePath()
        : this.stateRepo.getStateFilePath();
      return {
        issue: taskIssue,
        status: taskSm.getStatus(),
        stateFilePath: taskStateFilePath
      };
    });

    return {
      status: sm.getStatus(),
      history: sm.history,
      // The printed path and the rendered snapshot are derived from the same
      // resolution, so they can never disagree.
      stateFilePath: resolved?.path ?? this.stateRepo.getStateFilePath(),
      activeTasks,
      resolvedIssue: resolved?.issue ?? null,
      resolvedSnapshot: snapshot
    };
  }
}
