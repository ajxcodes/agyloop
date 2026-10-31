/**
 * agyloop - Gate evidence documentation contract (issue #415)
 *
 * The `TEST_METRICS:` count token is the escape hatch for a runner that prints
 * no count of its own (`go test ./...`, `ctest`, a bare Gradle run). It existed
 * only in the parser, so the operator who needed it was never told. Every
 * operator-facing surface now names the SAME interpolated constant:
 *
 * DOC415-1 - `codeloop --help` names the token and a count-less runner
 * DOC415-2 - `prompts/gate.md` names the token and the null-count refusal
 * DOC415-3 - `README.md` names the token (and no longer advertises TEST_COUNT)
 * DOC415-4 - the default gate prompt and the in-process refusal both carry it
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { printHelp } = require('../../dist/presentation/cli');
const {
  TOKEN_TEST_METRICS,
  DEFAULT_GATE_SYSTEM_PROMPT,
  MSG_GATE_NO_TEST_EVIDENCE
} = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const readDoc = (relativePath: string): string =>
  fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');

function captureHelp(): string {
  const original = console.log;
  let help = '';
  console.log = (...args: any[]) => {
    help += `${args.map(String).join(' ')}\n`;
  };
  try {
    printHelp();
  } finally {
    console.log = original;
  }
  return help;
}

const help = captureHelp();

describe('gate evidence documentation contract (issue #415)', () => {
  test('DOC415-1: --help names the count token and a count-less runner', () => {
    assert.ok(help.includes(TOKEN_TEST_METRICS), '--help must name the count token');
    assert.ok(help.includes('go test'), '--help must name a count-less runner');
  });

  test('DOC415-2: prompts/gate.md names the token and the null-count refusal', () => {
    const gateMd = readDoc('prompts/gate.md');
    assert.ok(gateMd.includes(TOKEN_TEST_METRICS), 'the static gate prompt must name the token');
    assert.ok(gateMd.includes('testsPassed'), 'the static gate prompt must name the null refusal');
  });

  test('DOC415-3: README names the token and no longer advertises TEST_COUNT', () => {
    const readme = readDoc('README.md');
    assert.ok(readme.includes(TOKEN_TEST_METRICS), 'README must name the token');
    assert.ok(
      !readme.includes('`TEST_COUNT: X passed'),
      'the diagram must advertise the canonical token, not the legacy alias'
    );
  });

  test('DOC415-4: the default gate prompt and the in-process refusal carry the remedy', () => {
    assert.ok(DEFAULT_GATE_SYSTEM_PROMPT.includes(TOKEN_TEST_METRICS));
    assert.ok(MSG_GATE_NO_TEST_EVIDENCE.includes(TOKEN_TEST_METRICS));
    assert.ok(MSG_GATE_NO_TEST_EVIDENCE.includes('skipped every file'));
    assert.ok(MSG_GATE_NO_TEST_EVIDENCE.includes('prints no counts'));
  });
});
