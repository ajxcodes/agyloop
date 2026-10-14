const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  AgyLoopError,
  InvalidTransitionError,
  PhysicalWriteViolationError,
  GitHubContextError,
  ConfigResolutionError,
  StateStorageError,
  ValidationError,
  QuotaExhaustedError,
  classifyQuotaExhaustion,
  ERROR_CODES,
  ERR_INVALID_TRANSITION,
  ERR_PHYSICAL_WRITE_VIOLATION,
  ERR_GITHUB_CONTEXT,
  ERR_CONFIG_RESOLUTION,
  ERR_STATE_STORAGE,
  ERR_VALIDATION,
  ERR_QUOTA_EXHAUSTED
} = require('../../dist/domain');

describe('Sealed Domain Error Hierarchy', () => {
  test('InvalidTransitionError exposes machine-readable code and transition context', () => {
    const err = new InvalidTransitionError('PLAN', 'IMPLEMENT', 'standard');
    assert.ok(err instanceof AgyLoopError);
    assert.ok(err instanceof Error);
    assert.strictEqual(err.code, ERR_INVALID_TRANSITION);
    assert.strictEqual(err.fromStage, 'PLAN');
    assert.strictEqual(err.toStage, 'IMPLEMENT');
    assert.strictEqual(err.mode, 'standard');
    assert.ok(err.message.includes("Cannot transition from 'PLAN' to 'IMPLEMENT' in mode 'standard'"));
  });

  test('PhysicalWriteViolationError exposes tool name and sealed code', () => {
    const err = new PhysicalWriteViolationError('run_command');
    assert.ok(err instanceof AgyLoopError);
    assert.strictEqual(err.code, ERR_PHYSICAL_WRITE_VIOLATION);
    assert.strictEqual(err.toolOrCapability, 'run_command');
    assert.ok(err.message.includes("Physical write suppression violation"));
  });

  test('GitHubContextError wraps operations and optional inner causes', () => {
    const cause = new Error('Process exit 1');
    const err = new GitHubContextError('issue view', { issue: 42 }, cause);
    assert.ok(err instanceof AgyLoopError);
    assert.strictEqual(err.code, ERR_GITHUB_CONTEXT);
    assert.strictEqual(err.operation, 'issue view');
    assert.strictEqual(err.cause, cause);
    assert.ok(err.message.includes('Process exit 1'));
  });

  test('ConfigResolutionError identifies failure target and context', () => {
    const err = new ConfigResolutionError('custom-config.json', 'File missing');
    assert.ok(err instanceof AgyLoopError);
    assert.strictEqual(err.code, ERR_CONFIG_RESOLUTION);
    assert.strictEqual(err.target, 'custom-config.json');
    assert.strictEqual(err.message, 'File missing');
  });

  test('StateStorageError records path and operation with cause', () => {
    const err = new StateStorageError('.agyloop/state.json', 'read', 'File locked');
    assert.ok(err instanceof AgyLoopError);
    assert.strictEqual(err.code, ERR_STATE_STORAGE);
    assert.strictEqual(err.filePath, '.agyloop/state.json');
    assert.strictEqual(err.operation, 'read');
    assert.strictEqual(err.message, 'File locked');
  });

  test('ValidationError tracks violated field, value, and rationale', () => {
    const err = new ValidationError('issueNumber', -1, 'Must be positive');
    assert.ok(err instanceof AgyLoopError);
    assert.strictEqual(err.code, ERR_VALIDATION);
    assert.strictEqual(err.field, 'issueNumber');
    assert.strictEqual(err.value, -1);
    assert.ok(err.message.includes('Must be positive'));
  });

  test('QuotaExhaustedError joins the sealed hierarchy under ERR_QUOTA_EXHAUSTED', () => {
    const err = new QuotaExhaustedError({
      signal: classifyQuotaExhaustion('RESOURCE_EXHAUSTED retry-after: 60'),
      runner: 'opencode',
      now: new Date('2026-10-14T12:00:00.000Z')
    });

    assert.ok(err instanceof AgyLoopError);
    assert.ok(err instanceof Error);
    assert.strictEqual(err.code, ERR_QUOTA_EXHAUSTED);
    assert.strictEqual(ERROR_CODES.QUOTA_EXHAUSTED, ERR_QUOTA_EXHAUSTED);
    assert.strictEqual(err.details.status, 429);
    assert.strictEqual(err.details.runner, 'opencode');
    assert.strictEqual(err.quotaResetAt, '2026-10-14T12:01:00.000Z');
  });
});
