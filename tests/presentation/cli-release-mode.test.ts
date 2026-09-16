/**
 * agyloop - CLI Release Mode & Parsing Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseArguments, printHelp } = require('../../dist/presentation');

describe('CLI Release Mode & Flag Parsing', () => {
  test('parses release subcommand with positional phase branch', () => {
    const parsed = parseArguments(['release', 'phase/1-bridge-arch']);
    assert.strictEqual(parsed.command, 'release');
    assert.strictEqual(parsed.options.phaseBranch, 'phase/1-bridge-arch');
  });

  test('parses release subcommand without positional branch', () => {
    const parsed = parseArguments(['release']);
    assert.strictEqual(parsed.command, 'release');
    assert.strictEqual(parsed.options.phaseBranch, null);
  });

  test('parses release with --dry-run and --refresh flags', () => {
    const parsed = parseArguments(['release', 'phase/1-bridge', '--dry-run', '--refresh']);
    assert.strictEqual(parsed.command, 'release');
    assert.strictEqual(parsed.options.phaseBranch, 'phase/1-bridge');
    assert.strictEqual(parsed.options.dryRun, true);
    assert.strictEqual(parsed.options.refresh, true);
  });

  test('parses --base-branch option for release targeting non-main branch', () => {
    const parsed = parseArguments(['release', 'phase/2-feature', '--base-branch', 'develop']);
    assert.strictEqual(parsed.command, 'release');
    assert.strictEqual(parsed.options.phaseBranch, 'phase/2-feature');
    assert.strictEqual(parsed.options.baseBranch, 'develop');
  });

  test('parses --base-branch=develop syntax', () => {
    const parsed = parseArguments(['release', '--base-branch=develop']);
    assert.strictEqual(parsed.command, 'release');
    assert.strictEqual(parsed.options.baseBranch, 'develop');
  });

  test('help text includes release command and documentation', () => {
    let captured = '';
    const origLog = console.log;
    try {
      console.log = (str) => {
        captured += str + '\n';
      };
      printHelp();
    } finally {
      console.log = origLog;
    }

    assert(captured.includes('release [branch]'));
    assert(captured.includes('--dry-run'));
    assert(captured.includes('--refresh'));
    assert(captured.includes('--base-branch'));
  });
});
