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
  /**
   * When true, RESOLVE what would be cleared and report it, but never remove a
   * checkpoint (issue #248). `removed` stays truthful (`false`); the prediction
   * travels in `wouldClear`.
   */
  readonly dryRun?: boolean;
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
  /** True when this was a simulation (#248). */
  readonly dryRun: boolean;
  /**
   * What a real reset would have removed (#248). Only meaningful on a dry run;
   * `false` on a real run (the truth is `removed`).
   */
  readonly wouldClear: boolean;
}

export class ResetPipelineUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(options: ResetPipelineOptions = {}): Promise<ResetPipelineResult> {
    const dryRun = options.dryRun === true;

    if (options.all) {
      if (dryRun) {
        // Never invent a count: `listAllStates()` drops corrupt files, so a
        // count would UNDERSTATE the purge. The message names what is in scope
        // without pretending to know how many files that is (#248).
        return {
          stateMachine: StateMachine.createInitial({ mode: MODE_STANDARD }),
          scope: 'all',
          issue: null,
          path: this.stateRepo.getStateFilePath(),
          removed: false,
          dryRun: true,
          wouldClear: true
        };
      }
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
        removed: true,
        dryRun: false,
        wouldClear: false
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
        return this.resetRoot(dryRun);
      }

      const issue = parsed.issue;
      const path = this.taskCheckpointPath(issue);
      if (dryRun) {
        return {
          stateMachine: StateMachine.createInitial({ mode: MODE_STANDARD, issue }),
          scope: 'task',
          issue,
          path,
          removed: false,
          dryRun: true,
          wouldClear: await this.taskCheckpointExists(issue)
        };
      }
      const removed = await this.removeTaskCheckpoint(issue);
      return {
        stateMachine: StateMachine.createInitial({ mode: MODE_STANDARD, issue }),
        scope: 'task',
        issue,
        path,
        removed,
        dryRun: false,
        wouldClear: false
      };
    }

    return this.resetRoot(dryRun);
  }

  /** Resets the singleton root checkpoint (`.agyloop/state.json`). */
  private async resetRoot(dryRun = false): Promise<ResetPipelineResult> {
    const path = this.stateRepo.getStateFilePath();
    if (dryRun) {
      return {
        stateMachine: StateMachine.createInitial({ mode: MODE_STANDARD }),
        scope: 'root',
        issue: null,
        path,
        removed: false,
        dryRun: true,
        wouldClear: await this.rootCheckpointExists()
      };
    }

    await this.stateRepo.reset();
    return {
      stateMachine: StateMachine.createInitial({ mode: MODE_STANDARD }),
      scope: 'root',
      issue: null,
      path,
      removed: true,
      dryRun: false,
      wouldClear: false
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

  /**
   * Read-only existence probe for the root checkpoint, used by a dry run. A
   * file that exists but cannot be parsed still EXISTS (and the real reset
   * would still remove it).
   */
  private async rootCheckpointExists(): Promise<boolean> {
    try {
      const snapshot = await this.stateRepo.load();
      return snapshot !== null && snapshot !== undefined;
    } catch {
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
