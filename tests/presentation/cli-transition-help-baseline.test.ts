/**
 * agyloop - CLI transition help agrees with the APPROVAL baseline behaviour
 * (issue #402, AC7)
 *
 * CH1 - `codeloop --help` names the APPROVAL baseline measurement, the
 *       build-like refusal, and embeds the SAME root-build prohibition the
 *       DISCOVERY directive states.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { printHelp } = require('../../dist/presentation/cli');
const { ROOT_BUILD_PROHIBITION_SENTENCE } = require('../../dist/domain');

function captureHelp(): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: any[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    printHelp();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('transition help <-> APPROVAL baseline behaviour (issue #402)', () => {
  test('CH1: the help names the baseline gate and the shared prohibition', () => {
    const help = captureHelp();

    assert.ok(help.includes('transition <STAGE>'), help);
    assert.ok(help.includes('### Baseline Evidence'), help);
    assert.ok(help.includes('refuses a build-like command'), help);
    assert.ok(help.includes(ROOT_BUILD_PROHIBITION_SENTENCE), help);
  });
});
