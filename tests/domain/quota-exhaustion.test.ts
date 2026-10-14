/**
 * agyloop - Provider Quota Exhaustion Classification Tests (issue #218 AC4)
 *
 * Covers the pure classifier, the human-facing diagnostic and the sealed
 * QuotaExhaustedError shape, including the false-positive boundary that must
 * keep the existing non-quota runner error intact.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  classifyQuotaExhaustion,
  formatQuotaDiagnostic,
  QuotaExhaustedError,
  AgyLoopError,
  GATE_CIRCUIT_BREAKER,
  QUOTA_RESUME_COMMAND,
  QUOTA_STATUS
} = require('../../dist/domain');

const {
  ERR_QUOTA_EXHAUSTED,
  ERROR_CODES,
  QUOTA_DEFAULT_RETRY_AFTER_SECONDS,
  CB_ACTION_FAILOVER,
  CB_FAILOVER_BREAKER_NAME
} = require('../../dist/domain/constants');

const FIXED_NOW = new Date('2026-10-14T12:00:00.000Z');

describe('classifyQuotaExhaustion', () => {
  test('detects RESOURCE_EXHAUSTED with the canonical 429 status', () => {
    const signal = classifyQuotaExhaustion('Error: RESOURCE_EXHAUSTED: quota exceeded');
    assert.strictEqual(signal.isQuotaExhausted, true);
    assert.strictEqual(signal.status, 429);
    assert.strictEqual(signal.status, QUOTA_STATUS);
  });

  test('detects HTTP 429 status lines', () => {
    assert.strictEqual(classifyQuotaExhaustion('HTTP 429 Too Many Requests').isQuotaExhausted, true);
    assert.strictEqual(classifyQuotaExhaustion('http/429 rate limited').isQuotaExhausted, true);
    assert.strictEqual(classifyQuotaExhaustion('request failed, code: 429').isQuotaExhausted, true);
  });

  test('detects insufficient_quota and rate-limit phrasings', () => {
    assert.strictEqual(classifyQuotaExhaustion('insufficient_quota for this key').isQuotaExhausted, true);
    assert.strictEqual(classifyQuotaExhaustion('You have exceeded your quota').isQuotaExhausted, true);
    assert.strictEqual(classifyQuotaExhaustion('rate limit reached').isQuotaExhausted, true);
    assert.strictEqual(classifyQuotaExhaustion('4290 requests rejected').isQuotaExhausted, false);
  });

  test('parses every retry-after spelling into seconds', () => {
    assert.strictEqual(classifyQuotaExhaustion('quota exceeded; retry-after: 120').retryAfterSeconds, 120);
    assert.strictEqual(classifyQuotaExhaustion('RESOURCE_EXHAUSTED retryAfter=45').retryAfterSeconds, 45);
    assert.strictEqual(classifyQuotaExhaustion('RESOURCE_EXHAUSTED {"retry_after":"90"}').retryAfterSeconds, 90);
    assert.strictEqual(classifyQuotaExhaustion('RESOURCE_EXHAUSTED').retryAfterSeconds, null);
  });

  test('extracts the provider name when the output names one', () => {
    const signal = classifyQuotaExhaustion('anthropic quota exceeded for model claude-opus');
    assert.strictEqual(signal.provider, 'anthropic');
    assert.strictEqual(classifyQuotaExhaustion('no provider here').provider, null);
  });

  test('retains a bounded evidence snippet', () => {
    const signal = classifyQuotaExhaustion(`RESOURCE_EXHAUSTED ${'x'.repeat(2000)}`);
    assert.ok(signal.evidence);
    assert.ok(signal.evidence.length <= 400);
    assert.ok(signal.evidence.startsWith('RESOURCE_EXHAUSTED'));
  });

  test('detects underscore- and suffix-shaped provider codes (word-boundary trap)', () => {
    // `_` is a word character, so a `\b` anchor never fires between `rate` and
    // `_limit`; every one of these is a realistic provider rejection.
    const positives = [
      'rate_limit_error',
      'rate_limit_exceeded',
      'RATE_LIMITED',
      'QUOTA_EXCEEDED',
      'quota_exceeded',
      'monthly limit reached'
    ];

    for (const raw of positives) {
      assert.strictEqual(
        classifyQuotaExhaustion(raw).isQuotaExhausted,
        true,
        `expected positive for ${JSON.stringify(raw)}`
      );
    }
  });

  test('does not treat an incidental 429 anywhere in the output as a status', () => {
    // A misclassification here persists a CIRCUIT_BREAKER pause that an operator
    // has to hand-clear from .agyloop/state.json, so the boundary is pinned hard.
    const negatives = [
      'image 429x429',
      'line 429 of file.ts',
      '0.429 s elapsed',
      'ts=1729000000.429',
      'took 429 ms',
      'rate of 429 bytes/sec',
      'disk quota exceeded: 429 blocks',
      'built 429 files',
      'sha 429abc',
      'chunks 429/1000'
    ];

    for (const raw of negatives) {
      assert.strictEqual(
        classifyQuotaExhaustion(raw).isQuotaExhausted,
        false,
        `expected negative for ${JSON.stringify(raw)}`
      );
    }
  });

  test('distinguishes a local disk/storage quota from a provider quota', () => {
    assert.strictEqual(classifyQuotaExhaustion('filesystem quota exceeded').isQuotaExhausted, false);
    assert.strictEqual(classifyQuotaExhaustion('disk quota exceeded: 429 blocks').isQuotaExhausted, false);
    // An explicit provider code still wins over the local-resource exclusion.
    assert.strictEqual(
      classifyQuotaExhaustion('RESOURCE_EXHAUSTED: disk quota exceeded on provider').isQuotaExhausted,
      true
    );
  });

  test('returns a negative signal for non-quota failures', () => {
    const negatives = [
      'Model not found',
      'OpenCode execution failed with exit code 1: Model not found',
      '500 Internal Server Error',
      'OpenCode execution failed with exit code 1429',
      'connection refused',
      '',
      '   ',
      null,
      undefined
    ];

    for (const raw of negatives) {
      const signal = classifyQuotaExhaustion(raw);
      assert.strictEqual(signal.isQuotaExhausted, false, `expected negative for ${JSON.stringify(raw)}`);
      assert.strictEqual(signal.status, null);
      assert.strictEqual(signal.retryAfterSeconds, null);
      assert.strictEqual(signal.provider, null);
      assert.strictEqual(signal.evidence, null);
    }
  });

  test('is total: never throws on non-string input', () => {
    assert.doesNotThrow(() => classifyQuotaExhaustion({ toString: () => 'RESOURCE_EXHAUSTED' }));
    assert.strictEqual(classifyQuotaExhaustion({ toString: () => 'RESOURCE_EXHAUSTED' }).isQuotaExhausted, true);
    // A bare status number is the HTTP status itself; an exit code is not.
    assert.strictEqual(classifyQuotaExhaustion(429).isQuotaExhausted, true);
    assert.strictEqual(classifyQuotaExhaustion(1429).isQuotaExhausted, false);
  });
});

describe('formatQuotaDiagnostic', () => {
  test('states the reset time, the gate and the resume command', () => {
    const message = formatQuotaDiagnostic(
      classifyQuotaExhaustion('RESOURCE_EXHAUSTED retry-after: 120'),
      FIXED_NOW
    );

    assert.ok(message.includes('429'), message);
    assert.ok(message.includes('2026-10-14T12:02:00.000Z'), message);
    assert.ok(message.includes('~120s from now'), message);
    assert.ok(message.includes(GATE_CIRCUIT_BREAKER), message);
    assert.ok(message.includes(QUOTA_RESUME_COMMAND), message);
  });

  test('flags an estimated window when the provider reports no Retry-After', () => {
    const message = formatQuotaDiagnostic(classifyQuotaExhaustion('quota exceeded'), FIXED_NOW);
    const expected = new Date(
      FIXED_NOW.getTime() + QUOTA_DEFAULT_RETRY_AFTER_SECONDS * 1000
    ).toISOString();

    assert.ok(message.includes('estimated'), message);
    assert.ok(message.includes(expected), message);
  });

  test('appends the failover outcome when a fallback was attempted', () => {
    const message = formatQuotaDiagnostic(
      classifyQuotaExhaustion('RESOURCE_EXHAUSTED'),
      FIXED_NOW,
      'OpenCode provider',
      { attempted: true, error: 'disk gone' }
    );

    assert.ok(message.includes('fallback runner was attempted'), message);
    assert.ok(message.includes('disk gone'), message);
  });
});

describe('QuotaExhaustedError', () => {
  const build = (overrides: any = {}) =>
    new QuotaExhaustedError({
      signal: classifyQuotaExhaustion('anthropic RESOURCE_EXHAUSTED retry-after: 120'),
      now: FIXED_NOW,
      ...overrides
    });

  test('is registered under ERR_QUOTA_EXHAUSTED and extends AgyLoopError', () => {
    const err = build();

    assert.ok(err instanceof Error);
    assert.ok(err instanceof AgyLoopError);
    assert.strictEqual(err.code, ERR_QUOTA_EXHAUSTED);
    assert.strictEqual(err.name, 'QuotaExhaustedError');
    assert.strictEqual(ERROR_CODES.QUOTA_EXHAUSTED, ERR_QUOTA_EXHAUSTED);
    assert.strictEqual(err.details.status, 429);
  });

  test('carries the structured quota metadata modelled on CircuitBreakerTrippedError', () => {
    const err = build({ runner: 'opencode', model: 'anthropic/claude', stage: 'IMPLEMENT', attempt: 2 });

    assert.strictEqual(err.runner, 'opencode');
    assert.strictEqual(err.model, 'anthropic/claude');
    assert.strictEqual(err.stage, 'IMPLEMENT');
    assert.strictEqual(err.attempt, 2);
    assert.strictEqual(err.provider, 'anthropic');
    assert.strictEqual(err.providerCode, 429);
    assert.strictEqual(err.retryAfterSeconds, 120);
    assert.strictEqual(err.quotaResetAt, '2026-10-14T12:02:00.000Z');
    assert.strictEqual(err.quotaResetEstimated, false);
    assert.strictEqual(err.detectedAt, '2026-10-14T12:00:00.000Z');
    assert.strictEqual(err.fallbackRunner, null);
    assert.strictEqual(err.failoverAttempted, false);
    assert.strictEqual(err.action, 'pause_for_human');
  });

  test('names the failover breaker once a fallback runner was attempted', () => {
    const err = build({ failoverAttempted: true, failoverError: 'boom', fallbackRunner: 'failover' });

    assert.strictEqual(err.breaker, CB_FAILOVER_BREAKER_NAME);
    assert.strictEqual(err.action, CB_ACTION_FAILOVER);
    assert.strictEqual(err.fallbackRunner, 'failover');
    assert.strictEqual(err.failoverError, 'boom');
    assert.ok(err.message.includes('fallback runner was attempted'), err.message);
  });

  test('message carries the reset time and resume instructions', () => {
    const message = build().message;

    assert.ok(message.includes('429'), message);
    assert.ok(message.includes('2026-10-14T12:02:00.000Z'), message);
    assert.ok(message.includes(GATE_CIRCUIT_BREAKER), message);
    assert.ok(message.includes(QUOTA_RESUME_COMMAND), message);
  });

  test('defaults the reset window and flags it as estimated without a Retry-After header', () => {
    const err = new QuotaExhaustedError({
      signal: classifyQuotaExhaustion('quota exhausted'),
      now: FIXED_NOW
    });

    assert.strictEqual(err.retryAfterSeconds, null);
    assert.strictEqual(err.quotaResetEstimated, true);
    assert.strictEqual(
      err.quotaResetAt,
      new Date(FIXED_NOW.getTime() + QUOTA_DEFAULT_RETRY_AFTER_SECONDS * 1000).toISOString()
    );
  });
});
