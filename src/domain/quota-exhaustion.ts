/**
 * agyloop - Provider Quota Exhaustion Classification (Domain)
 *
 * Pure detection of provider quota exhaustion (HTTP 429 / RESOURCE_EXHAUSTED /
 * insufficient_quota / rate-limit rejections) plus the sealed domain error that
 * carries the signal. Issue #218 AC4: a quota halt must preserve context, so the
 * signal has to survive the infrastructure boundary as structured data instead of
 * collapsing into a stringified `Error`.
 *
 * Zero I/O: every regex lives here, never in an adapter.
 */

import {
  CB_ACTION_FAILOVER,
  CB_ACTION_PAUSE_FOR_HUMAN,
  CB_FAILOVER_BREAKER_NAME,
  ERR_QUOTA_EXHAUSTED,
  GATE_CIRCUIT_BREAKER,
  QUOTA_DEFAULT_RETRY_AFTER_SECONDS,
  QUOTA_EVIDENCE_MAX_CHARS,
  QUOTA_RESUME_COMMAND,
  QUOTA_STATUS
} from './constants';
import { AgyLoopError } from './errors';

/** Structured result of inspecting raw provider output for a quota rejection. */
export interface QuotaExhaustionSignal {
  readonly isQuotaExhausted: boolean;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly provider: string | null;
  readonly evidence: string | null;
}

/** Options accepted by {@link QuotaExhaustedError}. */
export interface QuotaExhaustedErrorOptions {
  readonly signal: QuotaExhaustionSignal;
  /** Which agent runtime hit the wall (e.g. `opencode`). */
  readonly runner?: string | null;
  /** Model identifier requested when the quota window opened. */
  readonly model?: string | null;
  /** Lifecycle stage active when the rejection surfaced. */
  readonly stage?: string | null;
  /** 1-based invocation attempt (failover attempts count). */
  readonly attempt?: number;
  /** Human-facing subject used in the diagnostic. */
  readonly subject?: string;
  /** Fallback runner name when a failover attempt was already made. */
  readonly fallbackRunner?: string | null;
  readonly failoverAttempted?: boolean;
  readonly failoverError?: string | null;
  /** Injected clock — keeps diagnostics deterministic under test. */
  readonly now?: Date | string;
}

/**
 * Boundaries are explicit ASCII lookarounds rather than `\b` on purpose: `_` is a
 * word character, so `\b` never fires between `rate` and `_limit` and every
 * underscore-separated provider code (`RATE_LIMITED`, `QUOTA_EXCEEDED`) fell
 * through. Underscore is a word char but not alphanumeric, so these lookarounds
 * let the separator pass while still refusing to match inside a longer token
 * (`limit` must not fire inside `delimiter`).
 */
const NOT_ALNUM_BEFORE = '(?<![A-Za-z0-9])';
const NOT_ALNUM_AFTER = '(?![A-Za-z0-9])';

/**
 * Explicit provider codes and HTTP status shapes. A hit here is conclusive on its
 * own, so the local-resource exclusion below never applies.
 *
 * Matched case-insensitively against the raw stderr/stdout of a failed run.
 * Ordered from the most explicit provider codes to the loosest phrasing.
 *
 * The bare digit `429` is deliberately NOT a pattern: `image 429x429`,
 * `0.429 s elapsed` and `took 429 ms` all carry one, and a misclassification here
 * persists a CIRCUIT_BREAKER pause an operator must hand-clear. Only HTTP-shaped
 * occurrences count, plus the fully-anchored status below.
 */
const QUOTA_CODE_PATTERNS: readonly RegExp[] = [
  /resource[_\s-]?exhausted/i,
  new RegExp(`${NOT_ALNUM_BEFORE}insufficient[\\s_-]?quota${NOT_ALNUM_AFTER}`, 'i'),
  new RegExp(
    `${NOT_ALNUM_BEFORE}(?:rate|quota)[\\s_-]?limit(?:ed|s|ing)?${NOT_ALNUM_AFTER}`,
    'i'
  ),
  new RegExp(`${NOT_ALNUM_BEFORE}too many requests${NOT_ALNUM_AFTER}`, 'i'),
  new RegExp(`${NOT_ALNUM_BEFORE}http(?:[\\s/])?429${NOT_ALNUM_AFTER}`, 'i'),
  new RegExp(`${NOT_ALNUM_BEFORE}code\\s*[:=]\\s*429${NOT_ALNUM_AFTER}`, 'i'),
  new RegExp(`${NOT_ALNUM_BEFORE}status\\s*[:=]\\s*429${NOT_ALNUM_AFTER}`, 'i'),
  // The classifier is total and accepts non-string input, so a bare HTTP status
  // that IS the whole payload stays a detection. Anchoring is what keeps it from
  // degenerating into "any 429 anywhere"; `1429` (an exit code) still does not match.
  /^\s*429\s*$/
];

/**
 * Generic "quota"/"limit" phrasing. Looser than the codes above, so these are
 * suppressed when the subject of the sentence is a local resource rather than a
 * provider: `disk quota exceeded: 429 blocks` is an OS condition and classifying
 * it as provider quota halts the pipeline for no reason.
 */
const QUOTA_PHRASE_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `${NOT_ALNUM_BEFORE}quota${NOT_ALNUM_AFTER}[^.\\n]{0,40}${NOT_ALNUM_BEFORE}(exceeded|exhausted|depleted|reached)${NOT_ALNUM_AFTER}`,
    'i'
  ),
  new RegExp(
    `${NOT_ALNUM_BEFORE}(exceeded|exhausted|depleted)${NOT_ALNUM_AFTER}[^.\\n]{0,40}${NOT_ALNUM_BEFORE}quota${NOT_ALNUM_AFTER}`,
    'i'
  ),
  // `<subject> limit reached` — no `rate`/`quota` in front of the noun, e.g.
  // `monthly limit reached`. Anchored on the trailing verb to stay narrow.
  new RegExp(
    `${NOT_ALNUM_BEFORE}limit(?:ed|s|ing)?${NOT_ALNUM_AFTER}[^.\\n]{0,24}${NOT_ALNUM_BEFORE}(reached|exceeded|exhausted|depleted|refilled)${NOT_ALNUM_AFTER}`,
    'i'
  )
];

/** `<local resource> ... quota` — an OS/storage condition, never a provider quota. */
const LOCAL_RESOURCE_QUOTA_PATTERN = new RegExp(
  `${NOT_ALNUM_BEFORE}(?:disk|filesystem|file[\\s_-]?system|storage|inodes?)${NOT_ALNUM_AFTER}` +
    `[^\\n]{0,24}${NOT_ALNUM_BEFORE}quota${NOT_ALNUM_AFTER}`,
  'i'
);

/** `retry-after: 120` | `retryAfter=45` | `"retry_after": "90"` */
const RETRY_AFTER_PATTERN = /retry[\s_-]*after"?\s*[:=]\s*"?(\d{1,6})"?/i;

const PROVIDER_PATTERN =
  /\b(anthropic|gemini|google|openai|ollama|openrouter|groq|mistral)\b/i;

const NO_SIGNAL: QuotaExhaustionSignal = Object.freeze({
  isQuotaExhausted: false,
  status: null,
  retryAfterSeconds: null,
  provider: null,
  evidence: null
});

/**
 * Total function: any input (including `null`/`undefined`/objects) yields a
 * signal. Never throws, so an adapter can classify before deciding to throw.
 */
export function classifyQuotaExhaustion(raw: unknown): QuotaExhaustionSignal {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!text.trim()) {
    return NO_SIGNAL;
  }

  const codeMatch = QUOTA_CODE_PATTERNS.some((pattern) => pattern.test(text));
  const phraseMatch =
    !LOCAL_RESOURCE_QUOTA_PATTERN.test(text) &&
    QUOTA_PHRASE_PATTERNS.some((pattern) => pattern.test(text));
  if (!codeMatch && !phraseMatch) {
    return NO_SIGNAL;
  }

  const retryMatch = text.match(RETRY_AFTER_PATTERN);
  const providerMatch = text.match(PROVIDER_PATTERN);

  return {
    isQuotaExhausted: true,
    status: QUOTA_STATUS,
    retryAfterSeconds: retryMatch ? Number(retryMatch[1]) : null,
    provider: providerMatch ? providerMatch[1].toLowerCase() : null,
    evidence: text.slice(0, QUOTA_EVIDENCE_MAX_CHARS)
  };
}

/** Resolves the reset instant plus whether it is an estimate. */
function resolveResetWindow(
  retryAfterSeconds: number | null,
  now: Date
): { readonly resetAt: string; readonly estimated: boolean } {
  const estimated = retryAfterSeconds === null;
  const seconds = estimated ? QUOTA_DEFAULT_RETRY_AFTER_SECONDS : retryAfterSeconds;
  return {
    resetAt: new Date(now.getTime() + seconds * 1000).toISOString(),
    estimated
  };
}

/**
 * Human-facing diagnostic. MUST state the quota reset time and the explicit
 * resume command (issue #218 AC4). `now` is injected so tests are deterministic.
 */
export function formatQuotaDiagnostic(
  signal: QuotaExhaustionSignal,
  now: Date = new Date(),
  subject = 'Model provider',
  failover?: { readonly attempted: boolean; readonly error?: string | null }
): string {
  const { resetAt, estimated } = resolveResetWindow(signal.retryAfterSeconds, now);
  const origin = signal.provider ? `reported by ${signal.provider}` : 'reported by the provider';
  const stamp = estimated
    ? `${resetAt} (estimated ${QUOTA_DEFAULT_RETRY_AFTER_SECONDS}s window; provider reported no Retry-After)`
    : `${resetAt} (~${signal.retryAfterSeconds}s from now)`;

  const lines = [
    `${subject} quota exhausted (HTTP ${signal.status ?? QUOTA_STATUS}) ${origin}.`,
    `Quota is expected to reset at ${stamp}.`,
    `Pipeline state was checkpointed at the ${GATE_CIRCUIT_BREAKER} gate — nothing is lost.`,
    `Resume with \`${QUOTA_RESUME_COMMAND}\` once the quota window resets.`
  ];

  if (failover?.attempted) {
    const detail = failover.error ? `: ${failover.error}` : '.';
    lines.push(`A fallback runner was attempted and also failed${detail}`);
  }

  return lines.join(' ');
}

/**
 * Sealed domain error for provider quota exhaustion. Modelled on
 * `CircuitBreakerTrippedError` (breaker/limit/actual/action) so callers can
 * treat both halts uniformly: structured fields on the instance, a single
 * diagnostic string on `message`, everything machine-readable in `details`.
 */
export class QuotaExhaustedError extends AgyLoopError {
  public readonly code = ERR_QUOTA_EXHAUSTED;
  public readonly signal: QuotaExhaustionSignal;
  public readonly subject: string;

  /** Breaker identity, mirroring `CircuitBreakerTrippedError.breaker`. */
  public readonly breaker: string;
  /** Action taken — `failover` when a fallback runner was tried. */
  public readonly action: string;
  /** 1-based attempt counter (primary = 1). */
  public readonly attempt: number;

  public readonly runner: string | null;
  public readonly model: string | null;
  public readonly stage: string | null;
  public readonly provider: string | null;
  public readonly providerCode: number | null;
  public readonly retryAfterSeconds: number | null;
  /** ISO instant the quota window is expected to reopen. */
  public readonly quotaResetAt: string;
  /** True when `quotaResetAt` is derived from the default window, not a header. */
  public readonly quotaResetEstimated: boolean;
  /** ISO instant the rejection was observed — carried through failover chains. */
  public readonly detectedAt: string;
  public readonly fallbackRunner: string | null;
  public readonly failoverAttempted: boolean;
  public readonly failoverError: string | null;
  public readonly evidence: string | null;

  constructor(options: QuotaExhaustedErrorOptions) {
    const subject = options.subject ?? 'Model provider';
    const now = options.now === undefined ? new Date() : new Date(options.now);
    const retryAfterSeconds = options.signal.retryAfterSeconds;
    const { resetAt, estimated } = resolveResetWindow(retryAfterSeconds, now);
    const failoverAttempted = options.failoverAttempted ?? false;
    const action = failoverAttempted ? CB_ACTION_FAILOVER : CB_ACTION_PAUSE_FOR_HUMAN;
    const runner = options.runner ?? null;

    super(
      formatQuotaDiagnostic(options.signal, now, subject, {
        attempted: failoverAttempted,
        error: options.failoverError ?? null
      }),
      {
        status: options.signal.status,
        provider: options.signal.provider,
        providerCode: options.signal.status,
        retryAfterSeconds,
        quotaResetAt: resetAt,
        quotaResetEstimated: estimated,
        runner,
        model: options.model ?? null,
        stage: options.stage ?? null,
        attempt: options.attempt ?? 1,
        fallbackRunner: options.fallbackRunner ?? null,
        failoverAttempted,
        failoverError: options.failoverError ?? null,
        evidence: options.signal.evidence
      }
    );

    this.signal = options.signal;
    this.subject = subject;
    this.breaker = failoverAttempted ? CB_FAILOVER_BREAKER_NAME : 'providerQuota';
    this.action = action;
    this.attempt = options.attempt ?? 1;
    this.runner = runner;
    this.model = options.model ?? null;
    this.stage = options.stage ?? null;
    this.provider = options.signal.provider;
    this.providerCode = options.signal.status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.quotaResetAt = resetAt;
    this.quotaResetEstimated = estimated;
    this.detectedAt = now.toISOString();
    this.fallbackRunner = options.fallbackRunner ?? null;
    this.failoverAttempted = failoverAttempted;
    this.failoverError = options.failoverError ?? null;
    this.evidence = options.signal.evidence;
  }
}
