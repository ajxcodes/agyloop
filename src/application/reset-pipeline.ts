/**
 * agyloop - ResetPipelineUseCase
 *
 * Clears the persisted state checkpoint and returns a freshly initialized StateMachine.
 *
 * Issue #250 (AC B4): the use case now REPORTS what it actually did. A `reset`
 * that addressed a checkpoint which did not exist used to print an
 * unconditional "✓ ... cleared" line — a success claim about a file that was
 * never there. The `removed` flag is the truth, and the CLI renders it.
 */

import { StateMachine, MODE_STANDARD, ValidationError, parseIssueToken } from '../domain';
import { StateRepository } from '../ports';

export interface ResetPipelineOptions {
  readonly issue?: number | string | null;
  readonly all?: boolean;
}

export interface ResetPipelineResult {
  readonly stateMachine: StateMachine;
  /** Which checkpoint family was addressed. */
  readonly scope: 'root' | 'task' | 'all';
  /** The resolved issue for `scope === 'task'`, else null. */
  readonly issue: number | null;
  /** The resolved checkpoint path (for display). */
  readonly path: string;
  /** True when a checkpoint file was actually removed. */
  readonly removed: boolean;
}

export class ResetPipelineUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(options: ResetPipelineOptions = {}): Promise<ResetPipelineResult> {
    if (options.all) {
      if (this.stateRepo.resetAll) {
        await this.stateRepo.resetAll();
      } else {
        await this.stateRepo.reset();
      }
      return {
        stateMachine: StateMachine.createInitial({ mode: MODE_STANDARD }),
        scope: 'all',
        issue: null,
        path: this.stateRepo.getStateFilePath(),
        removed: true
      };
    }

    if (options.issue !== undefined && options.issue !== null) {
      // The ONE shared grammar (issue #250). The old `Number(options.issue)`
      // turned `999abc` into `NaN` and the result CLAIMED issue NaN; the
      // filename template then built `tasks/999abc.json`. An invalid token now
      // throws instead — the CLI rejects it before it can reach here.
      const parsed = parseIssueToken(options.issue);
      if (parsed.kind === 'invalid') {
        throw new ValidationError('issue', parsed.raw, parsed.message);
      }
      if (parsed.kind === 'absent') {
        // An empty/whitespace token names nothing: fall through to the root reset.
        return this.resetRoot();
      }

      const issue = parsed.issue;
      const path = this.taskCheckpointPath(issue);
      const removed = await this.removeTaskCheckpoint(issue);
      return {
        stateMachine: StateMachine.createInitial({ mode: MODE_STANDARD, issue }),
        scope: 'task',
        issue,
        path,
        removed
      };
    }

    return this.resetRoot();
  }

  /** Resets the singleton root checkpoint (`.agyloop/state.json`). */
  private async resetRoot(): Promise<ResetPipelineResult> {
    await this.stateRepo.reset();
    return {
      stateMachine: StateMachine.createInitial({ mode: MODE_STANDARD }),
      scope: 'root',
      issue: null,
      path: this.stateRepo.getStateFilePath(),
      removed: true
    };
  }

  /**
   * Removes the task checkpoint for `issue` and reports whether a file was
   * ACTUALLY removed.
   *
   * The adapter's boolean is authoritative. A legacy adapter that returns
   * `undefined` is covered by a port-based existence probe, so an honest
   * "nothing was there" is still reported as such.
   */
  private async removeTaskCheckpoint(issue: number): Promise<boolean> {
    if (!this.stateRepo.resetTask) {
      // No task-scoped reset available: the repository's own checkpoint is the
      // best this adapter can address.
      await this.stateRepo.reset();
      return true;
    }

    const existed = await this.taskCheckpointExists(issue);
    const reported: boolean | undefined = await this.stateRepo.resetTask(issue);
    return typeof reported === 'boolean' ? reported : existed;
  }

  /** Existence probe for a task checkpoint, used only as a legacy fallback. */
  private async taskCheckpointExists(issue: number): Promise<boolean> {
    if (!this.stateRepo.forIssue) {
      return false;
    }
    try {
      const snapshot = await this.stateRepo.forIssue(issue).load();
      return snapshot !== null && snapshot !== undefined;
    } catch {
      // A checkpoint that exists but cannot be parsed still EXISTS.
      return true;
    }
  }

  /** The resolved path of a task checkpoint, for display. */
  private taskCheckpointPath(issue: number): string {
    if (this.stateRepo.forIssue) {
      return this.stateRepo.forIssue(issue).getStateFilePath();
    }
    return this.stateRepo.getStateFilePath();
  }
}
