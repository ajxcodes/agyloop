/**
 * agyloop - deviation & plan docs contract (issue #487, AC1-AC3)
 *
 * DDC1 - `deviation --help` states the accepted wire format and the plan row
 *        names the stage `codeloop plan` actually leaves.
 * DDC2 - the shipped `prompts/implementer.md` and the embedded default prompt
 *        both state the accepted keys and the filing command.
 * DDC3 - `codeloop prompt implementer` renders the deviation channel.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { printHelp, runCli } = require('../../dist/presentation/cli');
const {
  PLAN_DEVIATION_EXAMPLE,
  PLAN_DEVIATION_PROSE_LABELS,
  DEFAULT_IMPLEMENTER_SYSTEM_PROMPT
} = require('../../dist/domain');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROMPT_FILE = path.join(REPO_ROOT, 'prompts', 'implementer.md');

function captureHelp(): string {
  const originalLog = console.log;
  let out = '';
  try {
    console.log = (...args: unknown[]) => {
      out += `${args.map(String).join(' ')}\n`;
    };
    printHelp();
  } finally {
    console.log = originalLog;
  }
  return out;
}

async function capturePrompt(): Promise<string> {
  const originalLog = console.log;
  let out = '';
  try {
    console.log = (...args: unknown[]) => {
      out += `${args.map(String).join(' ')}\n`;
    };
    const code = await runCli(['prompt', 'implementer']);
    assert.strictEqual(code, 0, 'codeloop prompt implementer must exit 0');
  } finally {
    console.log = originalLog;
  }
  return out;
}

describe('deviation & plan docs contract (issue #487)', () => {
  test('DDC1 the help states the deviation wire format and the real plan entry stage (#487)', () => {
    const help = captureHelp();
    assert.ok(help.includes(PLAN_DEVIATION_EXAMPLE), 'the help must print the accepted shape');
    assert.ok(help.includes(PLAN_DEVIATION_PROSE_LABELS), help);

    const planLine =
      help.split('\n').find((line) => line.trimStart().startsWith('plan ')) ?? '';
    assert.ok(planLine.length > 0, 'the help must document the plan command');
    assert.ok(planLine.includes('[PLAN]'), `the plan row must name [PLAN]: ${planLine}`);
    assert.ok(
      !planLine.includes('halts at [APPROVAL]'),
      `the plan row must not claim an APPROVAL halt: ${planLine}`
    );
    assert.ok(planLine.includes('codeloop next'), `the plan row must name the dispatch: ${planLine}`);
  });

  test('DDC2 the implementer prompt is the shipped file and states the accepted keys (#487 AC1)', () => {
    const promptFile = fs.readFileSync(PROMPT_FILE, 'utf8');
    assert.ok(promptFile.includes(PLAN_DEVIATION_EXAMPLE), 'the shipped prompt must print the shape');
    assert.ok(promptFile.includes('codeloop deviation --deviation-file'), promptFile);
    for (const key of ['planSection', 'planLiteral', 'implementedAssertion', 'reason']) {
      assert.ok(promptFile.includes(key), `the shipped prompt must name ${key}`);
    }
    assert.ok(
      DEFAULT_IMPLEMENTER_SYSTEM_PROMPT.includes(PLAN_DEVIATION_EXAMPLE),
      'the embedded default must match the shipped prompt'
    );
  });

  test('DDC3 codeloop prompt implementer renders the deviation channel (#487 AC1)', async () => {
    const output = await capturePrompt();
    assert.ok(output.includes('PLAN_DEVIATION:'), output);
    assert.ok(output.includes('planSection'), output);
    assert.ok(output.includes('implementedAssertion'), output);
  });
});
