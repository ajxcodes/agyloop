/**
 * agyloop - ResumePipelineUseCase (Application Layer)
 *
 * Clears a *persisted* gate pause (CIRCUIT_BREAKER after an exhausted retry
 * budget or a provider quota rejection) so the checkpoint stops claiming that a
 * human is needed.
 *
 * Why this exists as its own use case: until now the only code that called
 * `StateMachine.resumeFromGate()` was `TransitionStageUseCase` and
 * `TriagePrCommentsUseCase`, neither of which is reachable from a breaker halt.
 * The pause was therefore *write-only* — every diagnostic told the operator to
 * "re-run the command", but no command could clear it, so `pausedAtGate`
 * survived every subsequent run forever. This use case is the dedicated,
 * discoverable exit (`codeloop resume`) for that state.
 *
 * It only clears the pause. It never advances the stage, never re-runs a subagent
 * and never touches the plan/artifacts — resuming execution is the job of the
 * regular lifecycle commands (`codeloop implement` is the documented path).
 *
 * #226 D6: which checkpoint this clears is no longer "whichever `load()` returns".
 * Both the read and the write are routed through the one shared resolver, so a
 * bare `codeloop resume` on a workspace whose work lives in `.agyloop/tasks/<n>.json`
 * actually clears that file instead of announcing "nothing to resume" while the
 * task stays paused at `COMMIT` forever.
 */

import { StateMachine, StateMachineSnapshot, ExecutionMode, StageName } from '../domain';
import { StateRepository } from '../ports';
import {
  resolveAuthoritativeCheckpoint,
  resolveCheckpointRepository,
  selectAuthoritativeCheckpoint,
  CheckpointCandidate
} from './resolve-task-checkpoint';

export interface ResumePipelineParams {
  /** When true, resolve and report the resume but never write the checkpoint. */
  readonly dryRun?: boolean;
  /** Explicit issue number. Omit to let the shared resolver choose (#226 D6). */
  readonly issue?: number | string | null;
}

export interface ResumePipelineResult {
  readonly success: boolean;
  /** True when a pause was actually cleared (in memory, and on disk unless dryRun). */
  readonly resumed: boolean;
  /** True when the cleared checkpoint was written back to the repository. */
  readonly persisted: boolean;
  /** Gate the checkpoint was paused at before this call; null when nothing was paused. */
  readonly pausedAtGate: string | null;
  /** ISO instant the pause was recorded; null when nothing was paused. */
  readonly pausedAtTimestamp: string | null;
  /** Human-wait time banked by the resume (monotonically accumulated). */
  readonly totalHumanWaitMs: number;
  /** Stage the pipeline is checkpointed at, or null when no checkpoint exists on disk. */
  readonly currentStage: StageName | null;
  readonly mode: ExecutionMode | null;
  readonly issue: number | null;
  /** Rehydrated state machine, or null when no checkpoint exists on disk. */
  readonly stateMachine: StateMachine | null;
  readonly message: string;
  /**
   * Issue of the checkpoint this call actually inspected and wrote; null when the
   * root checkpoint (or nothing at all) was selected (#226 D6).
   */
  readonly resolvedFromIssue: number | null;
  /** Checkpoint file that selection points at; null when there is none. */
  readonly resolvedFromPath: string | null;
}

/**
 * Diagnostic tail naming any OTHER task that is still waiting on a human.
 *
 * "Nothing to resume" is only actionable when the operator knows WHICH task was
 * inspected, and only useful when they are told about the one that IS waiting.
 * Before the shared resolver, a bare `resume` reported that bare sentence while
 * `tasks/<n>.json` sat paused at `COMMIT`, which reads exactly like "there is no
 * work here" (#226 D6). A hint, not a behaviour change: the return contract —
 * `success: true`, exit 0, nothing written — is untouched.
 *
 * Fires even when the selected checkpoint WAS paused, because clearing one task's
 * pause is not a reason to hide the fact that another task still holds one.
 */
function describeOtherPausedTask(
  candidates: readonly CheckpointCandidate[],
  selectedIssue: number | null
): string {
  // Issue #252: rank with the RESOLVER'S OWN rules (in flight -> newest
  // `updatedAt` -> lowest issue), never `readdirSync` order. `candidates` is
  // unsorted by contract, so a `.find()` here was non-deterministic.
  const other = selectAuthoritativeCheckpoint(
    candidates.filter(
      (candidate) =>
        candidate.issue !== null &&
        candidate.issue !== selectedIssue &&
        Boolean(candidate.snapshot.pausedAtGate)
    )
  );
  if (!other || other.issue === null) {
    return '';
  }
  return ` Note: issue #${other.issue} is paused at ${other.snapshot.pausedAtGate} — ` +
    `re-run \`codeloop resume --issue ${other.issue}\`.`;
}

export class ResumePipelineUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(params: ResumePipelineParams = {}): Promise<ResumePipelineResult> {
    // Both questions come from the ONE shared resolver: which checkpoint is
    // authoritative (for the diagnostic) and which repository must be written.
    // Resolving the right path for *display* while saving through `this.stateRepo`
    // would put the cleared pause back into `.agyloop/state.json` and leave
    // `tasks/<n>.json` paused — the defect in a new shape. The scan is a read-only
    // listing of a handful of small JSON files; running it twice is cheaper than
    // keeping a second copy of the resolution rule.
    const resolved = await resolveAuthoritativeCheckpoint(this.stateRepo, params.issue);
    const repo = await resolveCheckpointRepository(this.stateRepo, params.issue);
    const resolvedFromIssue = resolved?.issue ?? null;
    const resolvedFromPath = resolved?.path ?? null;
    const otherPausedNote = describeOtherPausedTask(resolved?.candidates ?? [], resolvedFromIssue);

    // Deliberate catch-and-report for this re-load, not a swallow and not a hard
    // error. `resume` is the recovery command an operator reaches for when things
    // are ALREADY broken, so a reject here would be the worst possible failure
    // mode. But falling through to the "No pipeline checkpoint found" branch
    // below would ALSO be wrong: the file exists, it merely does not parse, and
    // reporting otherwise is exactly the false statement about reality that #226
    // exists to stop. This return precedes the only `repo.save()` call, so
    // nothing is persisted for a checkpoint that cannot be read.
    let snapshot: StateMachineSnapshot | null;
    try {
      snapshot = await repo.load();
    } catch (err) {
      return {
        success: false,
        resumed: false,
        persisted: false,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0,
        currentStage: null,
        mode: null,
        issue: null,
        stateMachine: null,
        message:
          `Cannot resume: the checkpoint file ${repo.getStateFilePath()} exists but ` +
          `could not be read (${err instanceof Error ? err.message : String(err)}). ` +
          `Inspect or repair that file, then re-run codeloop resume.` +
          otherPausedNote,
        resolvedFromIssue,
        resolvedFromPath
      };
    }

    if (!snapshot) {
      return {
        success: true,
        resumed: false,
        persisted: false,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0,
        currentStage: null,
        mode: null,
        issue: null,
        stateMachine: null,
        message: 'No pipeline checkpoint found — nothing to resume.' + otherPausedNote,
        resolvedFromIssue,
        resolvedFromPath
      };
    }

    const sm = StateMachine.fromSnapshot(snapshot);
    const pausedAtGate = sm.pausedAtGate;
    const pausedAtTimestamp = sm.pausedAtTimestamp;

    if (!pausedAtGate) {
      return {
        success: true,
        resumed: false,
        persisted: false,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: sm.totalHumanWaitMs,
        currentStage: sm.currentStage,
        mode: sm.mode,
        issue: sm.issue,
        stateMachine: sm,
        message: `Pipeline is not paused at any gate (checkpointed at ${sm.currentStage})` +
          `${resolvedFromIssue === null ? '' : ` for issue #${resolvedFromIssue}`} — nothing to resume.` +
          otherPausedNote,
        resolvedFromIssue,
        resolvedFromPath
      };
    }

    // `resumeFromGate()` banks the elapsed pause into `totalHumanWaitMs` (which is
    // what keeps the wait out of `activeExecutionDurationMs()`) and clears both
    // pause fields. It is a no-op-safe call: re-running `codeloop resume` twice
    // leaves the second run reporting "nothing to resume".
    sm.resumeFromGate();

    let persisted = false;
    if (!params.dryRun) {
      // `repo`, NOT `this.stateRepo`: this is the write the D6 fix is about.
      await repo.save(sm.toSnapshot());
      persisted = true;
    }

    const since = pausedAtTimestamp ? ` since ${pausedAtTimestamp}` : '';
    return {
      success: true,
      resumed: true,
      persisted,
      pausedAtGate,
      pausedAtTimestamp,
      totalHumanWaitMs: sm.totalHumanWaitMs,
      currentStage: sm.currentStage,
      mode: sm.mode,
      issue: sm.issue,
      stateMachine: sm,
      message: params.dryRun
        ? `Cleared the ${pausedAtGate} pause${since} in memory (--dry-run: nothing written).` + otherPausedNote
        : `Cleared the ${pausedAtGate} pause${since}. Pipeline remains checkpointed at ${sm.currentStage}.` + otherPausedNote,
      resolvedFromIssue,
      resolvedFromPath
    };
  }
}
