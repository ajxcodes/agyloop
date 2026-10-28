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
 *
 * Issue #349 adds the two local-review rules to the same surfaces:
 *
 * DOC6  - SKILL.md states the actionability rule and keeps --critique-report (DOC3)
 * DOC7  - the OpenCode skill states the same rule
 * DOC8  - `--help` names --refute on the review row and documents the grammar
 * DOC9  - SKILL.md names --refute on the row and in prose, with a mandatory reason
 * DOC10 - the OpenCode skill names --refute, the mandatory reason and the audit key
 * DOC11 - the refutation paragraph in BOTH skills states the APPROVED scope and
 *         the stderr surface (it can never claim to rescue CHANGES_REQUESTED,
 *         and it can never be silent)
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

function readSkill(relativePath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

const SKILL = path.join('skills', 'agyloop', 'SKILL.md');
const OPENCODE_SKILL = path.join('integrations', 'opencode', 'codeloop-skill.md');

/** Every blank-line-delimited paragraph that mentions the flag. */
function refutationParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.includes('--refute'));
}

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

  test('DOC6: SKILL.md states the actionability rule and keeps --critique-report', () => {
    const skill = readSkill(SKILL);

    assert.match(skill, /request a change/i, 'SKILL.md does not state what counts as blocking');
    assert.match(skill, /not counted as blocking/i, 'SKILL.md does not say an affirmation is exempt');

    const row = skill.split('\n').find((line: string) => line.startsWith('| `codeloop review`'));
    if (!row) {
      throw new Error('SKILL.md has no codeloop review row');
    }
    assert.ok(row.includes('--critique-report'), `the review row lost --critique-report: ${row}`);
  });

  test('DOC7: the OpenCode skill states the same actionability rule', () => {
    const opencode = readSkill(OPENCODE_SKILL);

    assert.match(opencode, /request a change/i, 'the OpenCode skill omits the actionability rule');
    assert.match(opencode, /not counted as blocking/i, 'the OpenCode skill omits the exemption');
  });

  test('DOC8: --help names --refute on the review row and documents the grammar', () => {
    const row = help.split('\n').find((line) => /^ {2}review\s/.test(line));
    if (!row) {
      throw new Error('the help output has no review row');
    }
    assert.ok(row.includes('--refute'), `review row is missing the flag: ${row}`);

    const flagLine = help.split('\n').find((line) => /^\s+--refute\s/.test(line));
    if (!flagLine) {
      throw new Error('the flag list no longer documents --refute');
    }
    assert.ok(flagLine.includes('<path>:<line>'), `flag line lost its grammar: ${flagLine}`);
    assert.match(flagLine, /reason/i, `flag line does not state the mandatory reason: ${flagLine}`);
  });

  test('DOC9: SKILL.md documents --refute on the row and in prose', () => {
    const skill = readSkill(SKILL);

    const row = skill.split('\n').find((line: string) => line.startsWith('| `codeloop review`'));
    if (!row) {
      throw new Error('SKILL.md has no codeloop review row');
    }
    assert.ok(row.includes('--refute'), `the review row is missing --refute: ${row}`);
    assert.match(skill, /reason is mandatory/i, 'SKILL.md does not state that a reason is mandatory');
    assert.match(skill, /verified/i, 'SKILL.md does not scope refutation to verified-false findings');
  });

  test('DOC10: the OpenCode skill documents the flag, the reason and the audit trail', () => {
    const opencode = readSkill(OPENCODE_SKILL);

    assert.ok(opencode.includes('--refute'), 'the OpenCode skill does not mention --refute');
    assert.match(opencode, /reason is mandatory/i, 'the OpenCode skill omits the mandatory reason');
    assert.match(opencode, /reviewRefutations/, 'the OpenCode skill does not document the audit trail');
  });

  test('DOC11: both skills state the APPROVED scope and the stderr surface', () => {
    for (const relativePath of [SKILL, OPENCODE_SKILL]) {
      const paragraphs = refutationParagraphs(readSkill(relativePath));
      assert.ok(paragraphs.length > 0, `${relativePath} has no --refute paragraph`);

      assert.ok(
        paragraphs.some((paragraph) => /APPROVED/.test(paragraph) && /stderr/i.test(paragraph)),
        `${relativePath}: the --refute paragraph must state the APPROVED scope and the stderr warning`
      );
    }
  });
});
