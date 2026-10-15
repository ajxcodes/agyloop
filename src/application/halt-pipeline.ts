/**
 * agyloop - HaltPipelineUseCase (Application Layer)
 *
 * Inbound quota-halt channel (issue #220): an external agent runtime calls
 * `codeloop halt --reason quota` when it observes a 429. The use case persists
 * a `CIRCUIT_BREAKER` pause (first-wins via `StateMachine.pauseAtGate`) so the
 * quota-halt state — and exit code 2 — is reachable without wiring
 * `AgentRunnerPort` into `RunLifecycleUseCase` (explicitly forbidden).
 *
 * `quotaResetAt` is derived in the output only; `StateMachineSnapshot` is
 * unchanged (no schema migration).
 */

import {
  GATE_CIRCUIT_BREAKER,
  QUOTA_DEFAULT_RETRY_AFTER_SECONDS,
  QUOTA_RESUME_COMMAND
} from '../domain';
import { StateMachine } from '../domain';
import type { StateRepository } from '../ports';

export interface HaltPipelineParams {
  /** Only `'quota'` is accepted; anything else is a usage error. */
  readonly reason: string | null;
  /** Seconds until the quota window reopens; defaults to the domain window. */
  readonly retryAfterSeconds?: number | null;
  /** When true, resolve and report the halt but never write the checkpoint. */
  readonly dryRun?: boolean;
  /** Injected clock — keeps `quotaResetAt` deterministic under test. */
  readonly now?: Date | string | number;
}

export interface HaltPipelineResult {
  readonly success: boolean;
  /** True when the halt was recorded (in memory, and on disk unless dryRun). */
  readonly halted: boolean;
  /** True when the checkpoint was written back to the repository. */
  readonly persisted: boolean;
  readonly pausedAtGate: string | null;
  /** ISO instant the pause was recorded (original timestamp on first-wins). */
  readonly pausedAtTimestamp: string | null;
  /** ISO instant the quota window is expected to reopen (derived, not stored). */
  readonly quotaResetAt: string;
  /** True when `quotaResetAt` uses the default window, not `--retry-after`. */
  readonly quotaResetEstimated: boolean;
  readonly retryAfterSeconds: number;
  readonly message: string;
}

export class HaltPipelineUseCase {
  private readonly stateRepo: StateRepository;

  constructor(stateRepo: StateRepository) {
    this.stateRepo = stateRepo;
  }

  public async execute(params: HaltPipelineParams): Promise<HaltPipelineResult> {
    if (params.reason !== 'quota') {
      const requested = params.reason === null || params.reason === undefined ? '(missing)' : `'${params.reason}'`;
      return {
        success: false,
        halted: false,
        persisted: false,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        quotaResetAt: new Date().toISOString(),
        quotaResetEstimated: true,
        retryAfterSeconds: QUOTA_DEFAULT_RETRY_AFTER_SECONDS,
        message: `Error: 'halt' requires --reason quota (received ${requested}). Example: codeloop halt --reason quota [--retry-after <seconds>].`
      };
    }

    const retryAfterSeconds =
      params.retryAfterSeconds === null || params.retryAfterSeconds === undefined
        ? QUOTA_DEFAULT_RETRY_AFTER_SECONDS
        : params.retryAfterSeconds;
    const estimated =
      params.retryAfterSeconds === null || params.retryAfterSeconds === undefined;

    const snapshot = await this.stateRepo.load();
    let sm = snapshot ? StateMachine.fromSnapshot(snapshot) : new StateMachine();

    const hadTimestamp = sm.pausedAtTimestamp !== null && sm.pausedAtTimestamp !== undefined;
    sm.pauseAtGate(GATE_CIRCUIT_BREAKER);

    if (!hadTimestamp && params.now !== undefined) {
      const nowIso = new Date(params.now).toISOString();
      const patched = StateMachine.fromSnapshot({
        ...sm.toSnapshot(),
        pausedAtTimestamp: nowIso,
        updatedAt: nowIso
      });
      sm = patched;
    }

    const pausedAtTimestamp = sm.pausedAtTimestamp;
    const baseMs = pausedAtTimestamp ? new Date(pausedAtTimestamp).getTime() : Date.now();
    const quotaResetAt = new Date(baseMs + retryAfterSeconds * 1000).toISOString();

    let persisted = false;
    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());
      persisted = true;
    }

    const stamp = estimated
      ? `${quotaResetAt} (estimated ${QUOTA_DEFAULT_RETRY_AFTER_SECONDS}s window; provider reported no Retry-After)`
      : `${quotaResetAt} (~${retryAfterSeconds}s from now)`;
    const message = params.dryRun
      ? `Provider quota exhausted (HTTP 429). Would checkpoint at the ${GATE_CIRCUIT_BREAKER} gate (--dry-run: nothing written). Quota is expected to reset at ${stamp}. Resume with \`${QUOTA_RESUME_COMMAND}\` once the quota window resets.`
      : `Provider quota exhausted (HTTP 429). Pipeline state checkpointed at the ${GATE_CIRCUIT_BREAKER} gate — nothing is lost. Quota is expected to reset at ${stamp}. Resume with \`${QUOTA_RESUME_COMMAND}\` once the quota window resets.`;

    return {
      success: true,
      halted: true,
      persisted,
      pausedAtGate: sm.pausedAtGate,
      pausedAtTimestamp,
      quotaResetAt,
      quotaResetEstimated: estimated,
      retryAfterSeconds,
      message
    };
  }
}
