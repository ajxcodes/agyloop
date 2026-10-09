const { describe, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

describe('CLI Launchers and Rebranding', () => {
  const rootDir = path.resolve(__dirname, '..');
  const codeloopJs = path.join(rootDir, 'bin', 'codeloop.js');
  const agyloopJs = path.join(rootDir, 'bin', 'agyloop.js');
  const codeloopSh = path.join(rootDir, 'bin', 'codeloop');
  const agyloopSh = path.join(rootDir, 'bin', 'agyloop');

  test('bin/codeloop.js runs --help successfully without deprecation notice', () => {
    const res = spawnSync(process.execPath, [codeloopJs, '--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(!res.stderr.includes('deprecated'), 'Expected stderr not to contain deprecation notice');
  });

  test('bin/agyloop.js runs --help with deprecation notice in stderr', () => {
    const res = spawnSync(process.execPath, [agyloopJs, '--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(
      res.stderr.includes("Warning: The 'agyloop' command is deprecated. Please use 'codeloop' instead."),
      'Expected stderr to contain deprecation notice'
    );
  });

  test('bin/codeloop shell launcher runs --help without deprecation notice', () => {
    const res = spawnSync(codeloopSh, ['--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(!res.stderr.includes('deprecated'), 'Expected stderr not to contain deprecation notice');
  });

  test('bin/agyloop shell launcher runs --help with deprecation notice in stderr', () => {
    const res = spawnSync(agyloopSh, ['--help'], {
      encoding: 'utf-8',
      cwd: rootDir,
    });
    assert.strictEqual(res.status, 0, `Process failed with stderr: ${res.stderr}`);
    assert.ok(res.stdout.includes('Usage:'), 'Expected stdout to contain "Usage:"');
    assert.ok(
      res.stderr.includes("Warning: The 'agyloop' command is deprecated. Please use 'codeloop' instead."),
      'Expected stderr to contain deprecation notice'
    );
  });

  test('bin/codeloop.js exports main, parseArguments, runCli, checkStaleDist', () => {
    const codeloop = require('../bin/codeloop.js');
    assert.strictEqual(typeof codeloop.main, 'function');
    assert.strictEqual(typeof codeloop.parseArguments, 'function');
    assert.strictEqual(typeof codeloop.runCli, 'function');
    assert.strictEqual(typeof codeloop.checkStaleDist, 'function');
  });
});
