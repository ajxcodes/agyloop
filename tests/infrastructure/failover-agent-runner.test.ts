/**
 * agyloop - FailoverAgentRunner Decorator Tests (issue #218 AC4)
 *
 * Contract: quota exhaustion triggers EXACTLY ONE fallback invocation; every
 * other failure propagates untouched so genuine errors are never masked.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { FailoverAgentRunner } = require('../../dist/infrastructure/failover-agent-runner');
const { QuotaExhaustedError, classifyQuotaExhaustion, CB_ACTION_FAILOVER, CB_FAILOVER_BREAKER_NAME } =
  require('../../dist/domain');

const PAYLOAD = { subagentName: 'implementer', prompt: 'do the thing' };

function quotaError(raw = 'RESOURCE_EXHAUSTED retry-after: 120', overrides = {}) {
  return new QuotaExhaustedError({
    signal: classifyQuotaExhaustion(raw),
    runner: 'opencode',
    now: new Date('2026-10-14T12:00:00.000Z'),
    ...overrides
  });
}

function makeRunner(impl: any) {
  return { invokeSubagent: impl };
}

describe('FailoverAgentRunner', () => {
  test('invokes the primary and never touches the fallback on success', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;

    const runner = new FailoverAgentRunner({
      primary: makeRunner(async () => {
        primaryCalls++;
      }),
      fallback: makeRunner(async () => {
        fallbackCalls++;
      })
    });

    await runner.invokeSubagent(PAYLOAD);

    assert.strictEqual(primaryCalls, 1);
    assert.strictEqual(fallbackCalls, 0);
  });

  test('fails over exactly once when the primary reports quota exhaustion', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;

    const runner = new FailoverAgentRunner({
      primary: makeRunner(async () => {
        primaryCalls++;
        throw quotaError();
      }),
      fallback: makeRunner(async () => {
        fallbackCalls++;
      })
    });

    await runner.invokeSubagent(PAYLOAD);

    assert.strictEqual(primaryCalls, 1);
    assert.strictEqual(fallbackCalls, 1);
  });

  test('propagates the quota error when no fallback is configured', async () => {
    let primaryCalls = 0;
    const original = quotaError();

    const runner = new FailoverAgentRunner({
      primary: makeRunner(async () => {
        primaryCalls++;
        throw original;
      })
    });

    await assert.rejects(
      async () => runner.invokeSubagent(PAYLOAD),
      (err: any) => {
        assert.ok(err instanceof QuotaExhaustedError);
        assert.strictEqual(err, original);
        return true;
      }
    );
    assert.strictEqual(primaryCalls, 1);
  });

  test('does not fail over on a non-quota error', async () => {
    let fallbackCalls = 0;
    const original = new Error('boom');

    const runner = new FailoverAgentRunner({
      primary: makeRunner(async () => {
        throw original;
      }),
      fallback: makeRunner(async () => {
        fallbackCalls++;
      })
    });

    await assert.rejects(
      async () => runner.invokeSubagent(PAYLOAD),
      (err: any) => {
        assert.strictEqual(err, original);
        return true;
      }
    );
    assert.strictEqual(fallbackCalls, 0);
  });

  test('rethrows as QuotaExhaustedError when the fallback also exhausts quota (no retry loop)', async () => {
    let fallbackCalls = 0;

    const runner = new FailoverAgentRunner({
      primary: makeRunner(async () => {
        throw quotaError('RESOURCE_EXHAUSTED retry-after: 120');
      }),
      fallback: makeRunner(async () => {
        fallbackCalls++;
        throw quotaError('anthropic RESOURCE_EXHAUSTED retry-after: 45', { runner: 'failover' });
      }),
      fallbackName: 'failover'
    });

    await assert.rejects(
      async () => runner.invokeSubagent(PAYLOAD),
      (err: any) => {
        assert.ok(err instanceof QuotaExhaustedError);
        assert.strictEqual(fallbackCalls, 1, 'the fallback must be attempted exactly once');
        assert.strictEqual(err.failoverAttempted, true);
        assert.strictEqual(err.attempt, 2);
        assert.strictEqual(err.fallbackRunner, 'failover');
        assert.strictEqual(err.action, CB_ACTION_FAILOVER);
        assert.strictEqual(err.breaker, CB_FAILOVER_BREAKER_NAME);
        // The fallback's newer reset metadata wins.
        assert.strictEqual(err.retryAfterSeconds, 45);
        return true;
      }
    );
  });

  test('annotates a non-quota fallback failure onto the original quota signal', async () => {
    const runner = new FailoverAgentRunner({
      primary: makeRunner(async () => {
        throw quotaError();
      }),
      fallback: makeRunner(async () => {
        throw new Error('fallback binary missing');
      })
    });

    await assert.rejects(
      async () => runner.invokeSubagent(PAYLOAD),
      (err: any) => {
        assert.ok(err instanceof QuotaExhaustedError);
        assert.strictEqual(err.failoverAttempted, true);
        assert.strictEqual(err.failoverError, 'fallback binary missing');
        assert.strictEqual(err.retryAfterSeconds, 120, 'the original quota metadata must survive');
        assert.ok(err.message.includes('fallback binary missing'), err.message);
        return true;
      }
    );
  });

  test('invokes the onFailover callback with the quota reset metadata', async () => {
    const events: any[] = [];

    const runner = new FailoverAgentRunner({
      primaryName: 'opencode',
      fallbackName: 'failover',
      primary: makeRunner(async () => {
        throw quotaError('anthropic RESOURCE_EXHAUSTED retry-after: 120');
      }),
      fallback: makeRunner(async () => {}),
      onFailover: (event: any) => events.push(event)
    });

    await runner.invokeSubagent(PAYLOAD);

    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], {
      breaker: 'providerQuota',
      action: CB_ACTION_FAILOVER,
      from: 'opencode',
      to: 'failover',
      retryAfterSeconds: 120,
      provider: 'anthropic',
      attempt: 1
    });
  });

  test('is inert when constructed without arguments (architecture fitness ctor)', async () => {
    const runner = new FailoverAgentRunner();
    assert.strictEqual(typeof runner.invokeSubagent, 'function');
    await runner.invokeSubagent(PAYLOAD);
  });
});
