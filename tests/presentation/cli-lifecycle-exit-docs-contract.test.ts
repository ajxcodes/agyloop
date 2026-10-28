/**
 * agyloop - Lifecycle exit documentation contract (issue #351, AC-4)
 *
 * Two contracts the tool STATED but did not implement are now real, and every
 * operator-facing surface must say the same thing:
 *
 * DOC1 - `--help` states the TRIAGE exit on the `next` row
 * DOC2 - `--help` states the collector caveat on `--create-pr`
 * DOC3 - `skills/agyloop/SKILL.md` states the TRIAGE exit condition and qualifies
 *        its read-only / pause-clearing claims with that one exception
 * DOC4 - the OpenCode skill states the same exit condition and qualification
 * DOC5 - both skills state the collector caveat for the operator
 * DOC6 - README states the caveat (the fourth surface cannot drift)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { printHelp } = require('../../dist/presentation/cli');

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

function readDoc(relativePath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

const SKILL = path.join('skills', 'agyloop', 'SKILL.md');
const OPENCODE_SKILL = path.join('integrations', 'opencode', 'codeloop-skill.md');

describe('lifecycle exit documentation contract (issue #351)', () => {
  test('DOC1: --help names the TRIAGE exit on the `next` row', () => {
    assert.match(help, /TRIAGE/, '--help must mention the TRIAGE gate');
    assert.match(help, /MERGED\/CLOSED/, '--help must name the terminal PR states');
    assert.match(help, /exits to COMPLETED/, '--help must name the destination stage');
  });

  test('DOC2: --help states the collector caveat on --create-pr', () => {
    assert.match(help, /does NOT auto-close/, '--help must say the keyword does not auto-close');
    assert.match(help, /codeloop sync/, '--help must name the compensator');
    assert.match(help, /closes the issue after the merge/, '--help must say what sync does');
  });

  test('DOC3: skills/agyloop/SKILL.md states the TRIAGE exit condition', () => {
    const doc = readDoc(SKILL);
    assert.match(doc, /merged or closed/i, `${SKILL} must document the terminal PR exit`);
    assert.match(doc, /records? `?COMPLETED/, `${SKILL} must say the gate records COMPLETED`);
    assert.match(doc, /no `?codeloop resume/, `${SKILL} must say no resume is needed`);
    assert.match(
      doc,
      /never advances[^.]*except/,
      `${SKILL} must qualify the read-only claim: plain next never advances a checkpoint except the documented TRIAGE exit`
    );
    assert.doesNotMatch(
      doc,
      /never clears one/,
      `${SKILL} must not keep the unqualified "never clears one" claim (the TRIAGE exit clears itself)`
    );
    assert.doesNotMatch(
      doc,
      /only \*reports\* a pause/,
      `${SKILL} must not keep the unqualified "only *reports* a pause" claim (the TRIAGE exit clears itself)`
    );
  });

  test('DOC4: the OpenCode skill states the same TRIAGE exit condition', () => {
    const doc = readDoc(OPENCODE_SKILL);
    assert.match(doc, /merged or closed/i, `${OPENCODE_SKILL} must document the terminal PR exit`);
    assert.match(doc, /records? `?COMPLETED/, `${OPENCODE_SKILL} must say the gate records COMPLETED`);
    assert.match(doc, /no `?codeloop resume/, `${OPENCODE_SKILL} must say no resume is needed`);
    assert.match(
      doc,
      /never clears a pause other than the terminal TRIAGE exit/,
      `${OPENCODE_SKILL} must qualify the pause-clearing rule with the terminal TRIAGE exit`
    );
    assert.doesNotMatch(
      doc,
      /never clears one/,
      `${OPENCODE_SKILL} must not keep the unqualified "never clears one" claim (the TRIAGE exit clears itself)`
    );
    assert.doesNotMatch(
      doc,
      /only \*reports\* a pause/,
      `${OPENCODE_SKILL} must not keep the unqualified "only *reports* a pause" claim (the TRIAGE exit clears itself)`
    );
  });

  test('DOC5: both skills state the collector caveat', () => {
    for (const file of [SKILL, OPENCODE_SKILL]) {
      const doc = readDoc(file);
      assert.match(doc, /auto-close/i, `${file} must say a collector PR does not auto-close`);
      assert.match(doc, /closing keyword/i, `${file} must name the closing keyword`);
      assert.match(doc, /codeloop sync/, `${file} must name the compensator`);
    }
  });

  test('DOC6: README states the collector caveat', () => {
    const doc = readDoc('README.md');
    assert.match(doc, /auto-close/i, 'README.md must say a collector PR does not auto-close');
    assert.match(doc, /closing keyword/i, 'README.md must name the closing keyword');
  });
});
