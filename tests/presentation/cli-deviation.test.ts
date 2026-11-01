/**
 * agyloop - `codeloop deviation` CLI channel (issue #432, TR-36..TR-38)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS, EXIT_CODE_FAILURE } = require('../../dist/domain');

const BLOCK = [
  'PLAN_DEVIATION:',
  '{ "planSection": "§4.2", "planLiteral": "a === 1", "implementedAssertion": "a === 2", "reason": "pinned" }'
].join('\n');

const SEEDED_AT = '2026-11-01T00:00:00.000Z';

function seedImplementCheckpoint(dir: string): string {
  const tasks = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  const statePath = path.join(tasks, '432.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'IMPLEMENT',
      mode: 'standard',
      issue: 432,
      planDir: null,
      planPath: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      history: [{ stage: 'IMPLEMENT', timestamp: SEEDED_AT, metadata: {} }]
    })
  );
  return statePath;
}

describe('codeloop deviation (issue #432)', () => {
  let root: string;
  let statePath: string;
  let deviationPath: string;
  let originalLog: any;
  let originalError: any;
  let stdout: string;
  let stderr: string;
  let originalEnvSubagent: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-deviation-'));
    statePath = seedImplementCheckpoint(root);
    deviationPath = path.join(root, 'deviation.txt');
    fs.writeFileSync(deviationPath, BLOCK);
    stdout = '';
    stderr = '';
    originalLog = console.log;
    originalError = console.error;
    console.log = (message?: unknown) => {
      stdout += `${String(message)}\n`;
    };
    console.error = (message?: unknown) => {
      stderr += `${String(message)}\n`;
    };
    originalEnvSubagent = process.env.AGY_SUBAGENT;
    delete process.env.AGY_SUBAGENT;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    if (originalEnvSubagent !== undefined) {
      process.env.AGY_SUBAGENT = originalEnvSubagent;
    } else {
      delete process.env.AGY_SUBAGENT;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('CD1 files a deviation and lists it as unacknowledged', async () => {
    const code = await runCli([
      'deviation',
      '--issue',
      '432',
      '--workspace',
      root,
      '--deviation-file',
      deviationPath
    ]);
    assert.strictEqual(code, EXIT_CODE_SUCCESS, stderr);

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(saved.planDeviations.length, 1);
    assert.strictEqual(saved.planDeviations[0].acknowledged, false);

    stdout = '';
    const listCode = await runCli(['deviation', '--issue', '432', '--workspace', root]);
    assert.strictEqual(listCode, EXIT_CODE_SUCCESS);
    assert.ok(/PD-1/.test(stdout));
    assert.ok(/unacknowledged/.test(stdout));
  });

  test('CD2 refuses filing inside a dispatched subagent session', async () => {
    process.env.AGY_SUBAGENT = '1';
    const code = await runCli([
      'deviation',
      '--issue',
      '432',
      '--workspace',
      root,
      '--deviation-file',
      deviationPath
    ]);
    assert.strictEqual(code, EXIT_CODE_FAILURE);
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(saved.planDeviations, undefined);
  });

  test('CD3 --dry-run writes nothing', async () => {
    const before = fs.readFileSync(statePath, 'utf8');
    const code = await runCli([
      'deviation',
      '--issue',
      '432',
      '--workspace',
      root,
      '--deviation-file',
      deviationPath,
      '--dry-run'
    ]);
    assert.strictEqual(code, EXIT_CODE_SUCCESS, stderr);
    assert.strictEqual(fs.readFileSync(statePath, 'utf8'), before);
  });
});
