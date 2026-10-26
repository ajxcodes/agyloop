/**
 * agyloop - GetPipelineStatusUseCase
 *
 * Rehydrates StateMachine and returns current pipeline status summary and history.
 */

import { StateMachine, StateStatusSummary, StateHistoryEntry, StateMachineSnapshot, MODE_STANDARD, ValidationError } from '../domain';
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

/** A checkpoint that exists but could not be rehydrated (issue #251). */
export interface SkippedCorruptCheckpoint {
  readonly issue: number | null;
  readonly path: string | null;
  readonly error: string;
}

export interface PipelineStatusResult {
  readonly status: StateStatusSummary;
  readonly history: readonly StateHistoryEntry[];
  readonly stateFilePath: string;
  readonly activeTasks: readonly TaskStatusSummary[];
  /**
   * Task checkpoints that were dropped from the matrix because they could not
   * be rehydrated. One bad file must not brick `status` for the whole
   * workspace (#251 AC-251.3).
   */
  readonly skippedCorrupt: readonly SkippedCorruptCheckpoint[];
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
    // Issue #251: `load()` already tolerated a PARSE failure upstream, but a
    // snapshot that parses and carries an invalid stage blew up here with a raw
    // domain stack. Re-throw a `ValidationError` so the presentation layer can
    // render `✗ Status failed: …` instead of `Fatal:` + stack.
    let sm: StateMachine;
    try {
      sm = snapshot
        ? StateMachine.fromSnapshot(snapshot)
        : StateMachine.createInitial({ mode: MODE_STANDARD });
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        throw err;
      }
      const rawStage = (snapshot as Record<string, unknown> | null)?.currentStage;
      throw new ValidationError(
        'stage',
        typeof rawStage === 'string' ? rawStage : 'unknown',
        err instanceof Error ? err.message : String(err)
      );
    }

    const allSnapshots = typeof this.stateRepo.listAllStates === 'function'
      ? await this.stateRepo.listAllStates()
      : (snapshot ? [snapshot] : []);
    const activeTasks: TaskStatusSummary[] = [];
    const skippedCorrupt: SkippedCorruptCheckpoint[] = [];
    // Per-row try/catch (#251 AC-251.3): one GARBAGE task file is reported and
    // skipped, never allowed to take down the whole matrix.
    for (const s of allSnapshots || []) {
      const taskIssue = s.issue ?? null;
      let taskStateFilePath: string | null = null;
      try {
        taskStateFilePath =
          taskIssue !== null && typeof this.stateRepo.forIssue === 'function'
            ? this.stateRepo.forIssue(taskIssue).getStateFilePath()
            : this.stateRepo.getStateFilePath();
        const taskSm = StateMachine.fromSnapshot(s);
        activeTasks.push({
          issue: taskIssue,
          status: taskSm.getStatus(),
          // Each row owns exactly one file; the root row (issue === null) falls
          // back to this repository's own path.
          stateFilePath: taskStateFilePath ?? undefined
        });
      } catch (err: unknown) {
        skippedCorrupt.push({
          issue: taskIssue,
          path: taskStateFilePath,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    return {
      status: sm.getStatus(),
      history: sm.history,
      // The printed path and the rendered snapshot are derived from the same
      // resolution, so they can never disagree.
      stateFilePath: resolved?.path ?? this.stateRepo.getStateFilePath(),
      activeTasks,
      skippedCorrupt,
      resolvedIssue: resolved?.issue ?? null,
      resolvedSnapshot: snapshot
    };
  }
}
