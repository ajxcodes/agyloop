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
 */

import { StateMachine, ExecutionMode, StageName } from '../domain';
import { StateRepository } from '../ports';

export interface ResumePipelineParams {
  /** When true, resolve and report the resume but never write the checkpoint. */
  readonly dryRun?: boolean;
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
  /** Stage the pipeline is checkpointed at, or null when no checkpoint exists. */
  readonly currentStage: StageName | null;
  readonly mode: ExecutionMode | null;
  readonly issue: number | null;
  /** Rehydrated state machine, or null when no checkpoint exists on disk. */
  readonly stateMachine: StateMachine | null;
  readonly message: string;
}

export class ResumePipelineUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(params: ResumePipelineParams = {}): Promise<ResumePipelineResult> {
    const snapshot = await this.stateRepo.load();

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
        message: 'No pipeline checkpoint found — nothing to resume.'
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
        message: `Pipeline is not paused at any gate (checkpointed at ${sm.currentStage}) — nothing to resume.`
      };
    }

    // `resumeFromGate()` banks the elapsed pause into `totalHumanWaitMs` (which is
    // what keeps the wait out of `activeExecutionDurationMs()`) and clears both
    // pause fields. It is a no-op-safe call: re-running `codeloop resume` twice
    // leaves the second run reporting "nothing to resume".
    sm.resumeFromGate();

    let persisted = false;
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());
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
        ? `Cleared the ${pausedAtGate} pause${since} in memory (--dry-run: nothing written).`
        : `Cleared the ${pausedAtGate} pause${since}. Pipeline remains checkpointed at ${sm.currentStage}.`
    };
  }
}
