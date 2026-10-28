/**
 * agyloop - `--critique-report` documentation contract (issue #242 / AC13)
 *
 * The flag is the hermetic Tier 1 evidence channel, but it was documented only
 * in the `--help` flag list: the review COMMAND row and both shipped skills
 * omitted it. These tests read the shipped surfaces, so a future edit cannot
 * leave one behind without a red test.
 *
 * DOC1 - the help review row names --critique-report and keeps --verdict-file
 * DOC2 - the standalone flag line still documents <path|->
 * DOC3 - skills/agyloop/SKILL.md documents it on the review row
 * DOC4 - the OpenCode skill names it and explains when to use it
 * DOC5 - both reviewer prompts carry the verdict-filing contract
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { printHelp } = require('../../dist/presentation/cli');
const { DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT } = require('../../dist/domain');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

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

describe('--critique-report documentation contract', () => {
  test('DOC1: the help review row names --critique-report and --verdict-file', () => {
    const row = help.split('\n').find((line) => /^ {2}review\s/.test(line));
    if (!row) {
      throw new Error('the help output has no review row');
    }
    assert.ok(row.includes('--critique-report'), `review row is missing the flag: ${row}`);
    assert.ok(row.includes('--verdict-file'), `review row lost --verdict-file: ${row}`);
  });

  test('DOC2: the flag list still documents --critique-report <path|->', () => {
    const flagLine = help.split('\n').find((line) => /^\s+--critique-report\s/.test(line));
    if (!flagLine) {
      throw new Error('the flag list no longer documents --critique-report');
    }
    assert.ok(flagLine.includes('<path|->'), `flag line lost its placeholder: ${flagLine}`);
  });

  test('DOC3: SKILL.md documents the flag on the review row', () => {
    const skill = fs.readFileSync(path.join(PROJECT_ROOT, 'skills', 'agyloop', 'SKILL.md'), 'utf8');
    const row = skill.split('\n').find((line: string) => line.startsWith('| `codeloop review`'));
    if (!row) {
      throw new Error('SKILL.md has no codeloop review row');
    }
    assert.ok(row.includes('--critique-report'), `SKILL.md review row is missing the flag: ${row}`);
  });

  test('DOC4: the OpenCode skill names the flag and explains when to use it', () => {
    const opencode = fs.readFileSync(
      path.join(PROJECT_ROOT, 'integrations', 'opencode', 'codeloop-skill.md'),
      'utf8'
    );
    assert.ok(opencode.includes('--critique-report'), 'the OpenCode skill does not mention the flag');
    assert.match(
      opencode,
      /no critique subprocess|hermetic|already-produced/i,
      'the OpenCode skill does not explain when to use --critique-report'
    );
  });

  test('DOC5: both reviewer prompts carry the verdict-filing contract', () => {
    const filePrompt = fs.readFileSync(path.join(PROJECT_ROOT, 'prompts', 'reviewer.md'), 'utf8');
    const prompts: Array<[string, string]> = [
      ['prompts/reviewer.md', filePrompt],
      ['DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT', DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT]
    ];

    for (const [name, text] of prompts) {
      for (const token of ['codeloop review --issue', '--verdict-file', '--verdict-stdin']) {
        assert.ok(text.includes(token), `${name} does not name ${token}`);
      }
      assert.match(text, /Recording the verdict/i, `${name} has no Recording the verdict section`);
    }
  });
});
