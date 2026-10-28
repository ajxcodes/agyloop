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

  test('init gitignores exactly the state paths the tool writes (issue #315, AC-12)', async () => {
    assert.strictEqual(await runCli(['init', '--yes', '--workspace', dir]), EXIT_CODE_SUCCESS);
    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    const rules = gitignore.split('\n').map((line: string) => line.trim());

    // State lives in `.agyloop/`; those are the paths the tool actually writes.
    for (const rule of ['.agyloop/state.json', '.agyloop/tasks/', '.agyloop/locks/', '.agyloop/logs/']) {
      assert.ok(rules.includes(rule), `missing state rule '${rule}', got:\n${gitignore}`);
    }

    // The dead `.codeloop/*` STATE rules are gone: no code path writes them, so
    // gitignoring them was a false claim about where state lives.
    for (const rule of [
      '.codeloop/state.json',
      '.codeloop/tasks/',
      '.codeloop/locks/',
      '.codeloop/logs/',
      '.codeloop/critique-update-cache.json',
      '.codeloop/*.bak'
    ]) {
      assert.ok(!rules.includes(rule), `dead state rule '${rule}' must not be written, got:\n${gitignore}`);
    }

    // Config stays trackable, and it is the only thing in `.codeloop/`.
    assert.ok(fs.existsSync(path.join(dir, '.codeloop', 'config.json')));
    assert.ok(!rules.some((rule: string) => rule.endsWith('.codeloop/config.json') && !rule.startsWith('!')));
  });
});
