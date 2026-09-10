const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  loadConfig,
  resolveModel,
  fetchAvailableModels,
  DEFAULT_CONFIG,
  deepMerge,
  mapModelToTier
} = require('../dist');

describe('Configuration & Model Routing Engine (TypeScript)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-config-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('DEFAULT_CONFIG contains required roles and valid tiers', () => {
    assert.strictEqual(DEFAULT_CONFIG.models.planner, 'pro');
    assert.strictEqual(DEFAULT_CONFIG.models.implementer, 'inherit');
    assert.strictEqual(DEFAULT_CONFIG.models.gate, 'flash_lite');
    assert.strictEqual(DEFAULT_CONFIG.models.reviewer, 'flash');

    assert.strictEqual(DEFAULT_CONFIG.options.commitAfter, false);
    assert.strictEqual(DEFAULT_CONFIG.options.gateTimeoutSeconds, 300);
    assert.strictEqual(DEFAULT_CONFIG.options.autoApproveInYolo, true);
    assert.strictEqual(DEFAULT_CONFIG.options.enableMcpInPlanner, true);
  });

  test('deepMerge combines nested properties without mutating inputs', () => {
    const target = { a: 1, nested: { b: 2, c: 3 } };
    const source = { nested: { c: 99, d: 4 }, extra: 'new' };

    const merged = deepMerge(target, source) as Record<string, any>;

    assert.strictEqual(merged.a, 1);
    assert.strictEqual(merged.nested.b, 2);
    assert.strictEqual(merged.nested.c, 99);
    assert.strictEqual(merged.nested.d, 4);
    assert.strictEqual(merged.extra, 'new');

    assert.strictEqual(target.nested.c, 3);
  });

  test('mapModelToTier correctly maps short tiers and full canonical names', () => {
    assert.strictEqual(mapModelToTier('pro'), 'pro');
    assert.strictEqual(mapModelToTier('flash'), 'flash');
    assert.strictEqual(mapModelToTier('flash_lite'), 'flash_lite');
    assert.strictEqual(mapModelToTier('inherit'), 'inherit');

    assert.strictEqual(mapModelToTier('gemini-2.5-pro'), 'pro');
    assert.strictEqual(mapModelToTier('gemini-3.5-pro'), 'pro');
    assert.strictEqual(mapModelToTier('gemini-3.5-flash'), 'flash');
    assert.strictEqual(mapModelToTier('gemini-3.5-flash-lite'), 'flash_lite');

    assert.strictEqual(mapModelToTier('models/gemini-2.5-flash'), 'flash');
    assert.strictEqual(mapModelToTier('unknown-exotic-model'), 'inherit');
  });

  test('loadConfig prioritizes workspace .agyloop.json over defaults', () => {
    const configPath = path.join(tempDir, '.agyloop.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          planner: 'gemini-3.5-pro',
          reviewer: 'pro'
        },
        options: {
          commitAfter: true
        }
      }),
      'utf8'
    );

    const loaded = loadConfig({ workspaceDir: tempDir });
    assert.strictEqual(loaded.models.planner, 'gemini-3.5-pro');
    assert.strictEqual(loaded.models.reviewer, 'pro');
    assert.strictEqual(loaded.models.implementer, 'inherit');
    assert.strictEqual(loaded.options.commitAfter, true);
  });

  test('loadConfig supports explicit customPath', () => {
    const customConfig = path.join(tempDir, 'my-custom-config.json');
    fs.writeFileSync(
      customConfig,
      JSON.stringify({
        models: {
          gate: 'flash'
        }
      }),
      'utf8'
    );

    const loaded = loadConfig({ workspaceDir: tempDir, customPath: customConfig });
    assert.strictEqual(loaded.models.gate, 'flash');
    assert.strictEqual(loaded.models.planner, 'pro');
  });

  test('resolveModel resolves short tiers to canonical API defaults', () => {
    const planner = resolveModel('planner', DEFAULT_CONFIG);
    assert.strictEqual(planner.role, 'planner');
    assert.strictEqual(planner.tier, 'pro');
    assert.strictEqual(planner.apiModel, 'gemini-2.5-pro');

    const gate = resolveModel('gate', DEFAULT_CONFIG);
    assert.strictEqual(gate.role, 'gate');
    assert.strictEqual(gate.tier, 'flash_lite');
    assert.strictEqual(gate.apiModel, 'gemini-3.5-flash-lite');
  });

  test('resolveModel resolves explicit full model names and infers tier', () => {
    const customConfig = {
      models: {
        planner: 'gemini-3.5-pro',
        gate: 'gemini-3.5-flash-lite',
        implementer: 'inherit',
        reviewer: 'flash'
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: 300,
        autoApproveInYolo: true,
        enableMcpInPlanner: true
      }
    };

    const planner = resolveModel('planner', customConfig);
    assert.strictEqual(planner.tier, 'pro');
    assert.strictEqual(planner.apiModel, 'gemini-3.5-pro');

    const gate = resolveModel('gate', customConfig);
    assert.strictEqual(gate.tier, 'flash_lite');
    assert.strictEqual(gate.apiModel, 'gemini-3.5-flash-lite');
  });

  test('resolveModel safely falls back to inherit if unknown model tier', () => {
    const customConfig = {
      models: {
        planner: 'pro',
        gate: 'nonexistent-weird-model',
        implementer: 'inherit',
        reviewer: 'flash'
      },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: 300,
        autoApproveInYolo: true,
        enableMcpInPlanner: true
      }
    };
    const gate = resolveModel('gate', customConfig);
    assert.strictEqual(gate.tier, 'inherit');
    assert.strictEqual(gate.apiModel, 'nonexistent-weird-model');
  });

  test('fetchAvailableModels falls back gracefully to static catalog and caches', async () => {
    const cachePath = path.join(tempDir, 'models_cache.json');
    const models = await fetchAvailableModels({
      apiKey: 'dummy-key-for-test-fallback',
      cachePath,
      forceRefresh: true
    });

    assert.ok(Array.isArray(models));
    assert.ok(models.length > 0);
    assert.ok(models.some((m: { tier: string }) => m.tier === 'pro'));
    assert.ok(models.some((m: { tier: string }) => m.tier === 'flash'));
    assert.ok(models.some((m: { tier: string }) => m.tier === 'flash_lite'));
  });
});
