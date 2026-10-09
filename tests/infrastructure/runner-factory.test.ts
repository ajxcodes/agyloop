const { describe, test } = require('node:test');
const assert = require('node:assert');
const { RunnerFactory } = require('../../dist/infrastructure/runner-factory');
const { AntigravityAgentRunner } = require('../../dist/infrastructure/antigravity-agent-runner');
const { OpenCodeAgentRunner } = require('../../dist/infrastructure/opencode-agent-runner');

const BASE_MOCK_CONFIG = {
  models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
  options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true }
};

describe('RunnerFactory', () => {
  test('returns AntigravityAgentRunner when runner is explicitly antigravity', () => {
    const config = {
      ...BASE_MOCK_CONFIG,
      runner: 'antigravity'
    };

    const runner = RunnerFactory.createRunner({ config, env: {} });
    assert.ok(runner instanceof AntigravityAgentRunner);
  });

  test('returns OpenCodeAgentRunner when runner is explicitly opencode', () => {
    const config = {
      ...BASE_MOCK_CONFIG,
      runner: 'opencode',
      opencode: { model: 'custom:7b' }
    };

    const runner = RunnerFactory.createRunner({ config, env: {} });
    assert.ok(runner instanceof OpenCodeAgentRunner);
    assert.strictEqual(runner.defaultModel, 'custom:7b');
  });

  test('environment variable CODELOOP_RUNNER overrides config', () => {
    const config = {
      ...BASE_MOCK_CONFIG,
      runner: 'antigravity'
    };

    const runner = RunnerFactory.createRunner({
      config,
      env: { CODELOOP_RUNNER: 'opencode', OPENCODE_MODEL: 'env-model:14b' }
    });

    assert.ok(runner instanceof OpenCodeAgentRunner);
    assert.strictEqual(runner.defaultModel, 'env-model:14b');
  });

  test('auto detection defaults safely to Antigravity if environment is ambiguous', () => {
    const config = {
      ...BASE_MOCK_CONFIG,
      runner: 'auto'
    };

    // Environment without opencode variables or binary
    const runner = RunnerFactory.createRunner({
      config,
      env: { PATH: '' }
    });

    assert.ok(runner instanceof AntigravityAgentRunner);
  });

  test('auto detection selects OpenCode when OPENCODE env var is present', () => {
    const config = {
      ...BASE_MOCK_CONFIG,
      runner: 'auto'
    };

    const runner = RunnerFactory.createRunner({
      config,
      env: { OPENCODE: '1' }
    });

    assert.ok(runner instanceof OpenCodeAgentRunner);
    assert.strictEqual(runner.defaultModel, 'ollama/ornith:9b-128k');
  });
});
