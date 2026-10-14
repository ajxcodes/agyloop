/**
 * agyloop - FailoverAgentRunner Infrastructure Adapter (Decorator)
 *
 * Wraps a primary AgentRunnerPort and, on `QuotaExhaustedError` only, re-invokes
 * a configured fallback runner exactly once. Pure quota-awareness: any other
 * failure propagates untouched so genuine errors are never masked (issue #218 AC4).
 *
 * Constructible with zero arguments (architecture fitness test) — such an instance
 * is inert and resolves immediately.
 */

import { CB_ACTION_FAILOVER, QuotaExhaustedError } from '../domain';
import { AgentRunnerPort, RunnerSubagentPayload } from '../ports';

/** Emitted once, immediately before the fallback invocation. */
export interface FailoverEvent {
  /** Breaker that classified the failure. */
  readonly breaker: string;
  /** Action taken by the decorator. */
  readonly action: string;
  readonly from: string;
  readonly to: string;
  readonly retryAfterSeconds: number | null;
  readonly provider: string | null;
  /** 1-based attempt that failed on the primary. */
  readonly attempt: number;
}

export interface FailoverAgentRunnerOptions {
  /** Primary runner. Omitted ⇒ inert adapter (no-arg construction). */
  readonly primary?: AgentRunnerPort;
  /** Fallback runner. Omitted ⇒ quota errors propagate unchanged. */
  readonly fallback?: AgentRunnerPort;
  readonly primaryName?: string;
  readonly fallbackName?: string;
  readonly onFailover?: (event: FailoverEvent) => void;
}

export class FailoverAgentRunner implements AgentRunnerPort {
  private readonly primary?: AgentRunnerPort;
  private readonly fallback?: AgentRunnerPort;
  private readonly primaryName: string;
  private readonly fallbackName: string;
  private readonly onFailover?: (event: FailoverEvent) => void;

  constructor(options: FailoverAgentRunnerOptions = {}) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.primaryName = options.primaryName ?? 'primary';
    this.fallbackName = options.fallbackName ?? 'fallback';
    this.onFailover = options.onFailover;
  }

  public async invokeSubagent(payload: RunnerSubagentPayload): Promise<void> {
    // No-arg construction (architecture fitness test) yields an inert adapter.
    if (!this.primary) {
      return;
    }

    try {
      await this.primary.invokeSubagent(payload);
    } catch (err: unknown) {
      // Non-quota failures are genuine: fail fast, never mask them.
      if (!(err instanceof QuotaExhaustedError)) {
        throw err;
      }
      // No fallback configured: the caller must still see the quota diagnostic.
      if (!this.fallback) {
        throw err;
      }

      const event: FailoverEvent = {
        breaker: err.breaker,
        action: CB_ACTION_FAILOVER,
        from: this.primaryName,
        to: this.fallbackName,
        retryAfterSeconds: err.retryAfterSeconds,
        provider: err.provider,
        attempt: err.attempt
      };
      this.onFailover?.(event);

      try {
        // Exactly ONE failover attempt. Never recurse, never loop.
        await this.fallback.invokeSubagent(payload);
      } catch (fallbackErr: unknown) {
        // The quota diagnostic must survive the failed failover: re-wrap using the
        // fallback's signal (newer provider/reset metadata) while annotating both
        // attempts. A non-quota fallback error is reported as the failover detail
        // so the original, more actionable, quota signal stays the headline.
        const fallbackQuota = fallbackErr instanceof QuotaExhaustedError ? fallbackErr : null;
        throw new QuotaExhaustedError({
          signal: fallbackQuota ? fallbackQuota.signal : err.signal,
          subject: fallbackQuota ? fallbackQuota.subject : err.subject,
          runner: fallbackQuota ? fallbackQuota.runner : err.runner,
          model: fallbackQuota ? fallbackQuota.model : err.model,
          stage: fallbackQuota ? fallbackQuota.stage : err.stage,
          attempt: err.attempt + 1,
          fallbackRunner: this.fallbackName,
          failoverAttempted: true,
          failoverError: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          now: fallbackQuota ? fallbackQuota.detectedAt : err.detectedAt
        });
      }
    }
  }
}
