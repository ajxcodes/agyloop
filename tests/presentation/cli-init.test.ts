/**
 * agyloop - CLI init Presentation Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { runCli } = require('../../dist/presentation');
const { EXIT_CODE_SUCCESS } = require('../../dist/domain');

describe('CLI init', () => {
  let dir: string;
  let originalLog: any;
  let output = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-cli-init-'));
    output = '';
    originalLog = console.log;
    console.log = (...a: any[]) => {
      output += a.join(' ') + '\n';
    };
  });
  afterEach(() => {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('init --dry-run --json writes nothing', async () => {
    const code = await runCli(['init', '--dry-run', '--json', '--workspace', dir]);
    assert.strictEqual(code, EXIT_CODE_SUCCESS);
    const parsed = JSON.parse(output);
    assert.strictEqual(parsed.dryRun, true);
    assert.strictEqual(fs.existsSync(path.join(dir, '.codeloop')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, '.agyloop')), false);
  });

  test('init writes config, then skips; --force overwrites', async () => {
    assert.strictEqual(await runCli(['init', '--yes', '--workspace', dir]), EXIT_CODE_SUCCESS);
    assert.ok(fs.existsSync(path.join(dir, '.codeloop', 'config.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.codeloop', 'state.json')));
    assert.strictEqual(fs.existsSync(path.join(dir, '.agyloop')), false);

    output = '';
    await runCli(['init', '--yes', '--json', '--workspace', dir]);
    assert.strictEqual(JSON.parse(output).skipped, true);

    output = '';
    await runCli(['init', '--force', '--json', '--workspace', dir]);
    assert.strictEqual(JSON.parse(output).skipped, false);
  });

  test('init --json on existing config without --yes reports skipped', async () => {
    await runCli(['init', '--yes', '--workspace', dir]);
    output = '';
    const code = await runCli(['init', '--json', '--workspace', dir]);
    assert.strictEqual(code, EXIT_CODE_SUCCESS);
    assert.strictEqual(JSON.parse(output).skipped, true);
  });
});
