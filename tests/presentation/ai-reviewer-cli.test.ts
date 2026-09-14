/**
 * agyloop - AI Reviewer CLI Presentation Tests
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  parseCliArguments,
  printHelp
} = require('../../dist/presentation/ai-reviewer-cli');

describe('AI Reviewer CLI Argument Parsing', () => {
  test('parses default empty arguments', () => {
    const parsed = parseCliArguments(['node', 'ai-reviewer']);
    assert.strictEqual(parsed.staged, false);
    assert.strictEqual(parsed.baseRef, undefined);
    assert.strictEqual(parsed.json, false);
    assert.strictEqual(parsed.help, false);
  });

  test('parses --staged and -s flags', () => {
    const parsedLong = parseCliArguments(['node', 'ai-reviewer', '--staged']);
    assert.strictEqual(parsedLong.staged, true);

    const parsedShort = parseCliArguments(['node', 'ai-reviewer', '-s']);
    assert.strictEqual(parsedShort.staged, true);
  });

  test('parses --base and -b flags', () => {
    const parsedLong = parseCliArguments(['node', 'ai-reviewer', '--base', 'origin/main']);
    assert.strictEqual(parsedLong.baseRef, 'origin/main');

    const parsedShort = parseCliArguments(['node', 'ai-reviewer', '-b', 'HEAD~1']);
    assert.strictEqual(parsedShort.baseRef, 'HEAD~1');
  });

  test('parses --json and --help flags', () => {
    const parsedJson = parseCliArguments(['node', 'ai-reviewer', '--json']);
    assert.strictEqual(parsedJson.json, true);

    const parsedHelp = parseCliArguments(['node', 'ai-reviewer', '--help']);
    assert.strictEqual(parsedHelp.help, true);
  });

  test('parses --timeout flag', () => {
    const parsed = parseCliArguments(['node', 'ai-reviewer', '--timeout', '45000']);
    assert.strictEqual(parsed.timeoutMs, 45000);
  });

  test('printHelp logs without throwing', () => {
    assert.doesNotThrow(() => printHelp());
  });
});
