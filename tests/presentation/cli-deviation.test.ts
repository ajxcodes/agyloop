/**
 * agyloop - `codeloop deviation` CLI channel (issue #432, TR-36..TR-38)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../../dist/presentation/cli');
const {
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE,
  PLAN_DEVIATION_EXAMPLE
} = require('../../dist/domain');

const BLOCK = [
  'PLAN_DEVIATION:',
  '{ "planSection": "§4.2", "planLiteral": "a === 1", "implementedAssertion": "a === 2", "reason": "pinned" }'
].join('\n');

const SEEDED_AT = '2026-11-01T00:00:00.000Z';

function seedCheckpoint(dir: string, stage: string): string {
  const tasks = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  const statePath = path.join(tasks, '432.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: '1.0.0',
      currentStage: stage,
      mode: 'standard',
      issue: 432,
      planDir: null,
      planPath: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      history: [{ stage, timestamp: SEEDED_AT, metadata: {} }]
    })
  );
  return statePath;
}

function seedImplementCheckpoint(dir: string): string {
  return seedCheckpoint(dir, 'IMPLEMENT');
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

  test('CD4 files a prose deviation at REVIEW end to end (#437)', async () => {
    statePath = seedCheckpoint(root, 'REVIEW');
    const prosePath = path.join(root, 'tr15.txt');
    fs.writeFileSync(
      prosePath,
      [
        'PLAN_DEVIATION:',
        'Plan section: §4.4 Test Register row TR-15',
        'Plan literal: /run-lifecycle\\.test\\.ts:664/',
        'Implemented: /run-lifecycle\\.test\\.ts:4/',
        'Reason: the pinned fixture asserts pausedAtGate at line 4'
      ].join('\n')
    );

    const code = await runCli([
      'deviation',
      '--issue',
      '432',
      '--workspace',
      root,
      '--deviation-file',
      prosePath
    ]);
    assert.strictEqual(code, EXIT_CODE_SUCCESS, stderr);

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(saved.planDeviations.length, 1);
    assert.strictEqual(saved.planDeviations[0].id, 'PD-1');
    assert.strictEqual(saved.planDeviations[0].planSection, '§4.4 Test Register row TR-15');
    assert.strictEqual(
      saved.planDeviations[0].implementedAssertion,
      '/run-lifecycle\\.test\\.ts:4/'
    );
  });

  test('CD5 a block that misses a key is refused with the accepted shape (#451 AC2)', async () => {
    const incompletePath = path.join(root, 'incomplete.txt');
    fs.writeFileSync(
      incompletePath,
      ['PLAN_DEVIATION:', '{ "planSection": "§4.2", "planLiteral": "a" }'].join('\n')
    );

    const code = await runCli([
      'deviation',
      '--issue',
      '432',
      '--workspace',
      root,
      '--deviation-file',
      incompletePath
    ]);
    assert.strictEqual(code, EXIT_CODE_FAILURE);
    assert.ok(stderr.includes(PLAN_DEVIATION_EXAMPLE), stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).planDeviations, undefined);
  });
});
