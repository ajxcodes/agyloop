/**
 * agyloop - SmokeProtocol tests (issue #298, AC8/AC10)
 *
 * SP1 - the #283 JSON-quoted comparison shape is named at its plan line
 * SP2 - a bare relative module path is named; `node:`/`./`/builtins allowed
 * SP3 - a section with no shell fence is not executable
 * SP4 - the runner emits one marker per check and attributes the failure
 * SP5 - a comment-only check is empty
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { SmokeProtocol } = require('../../dist/domain');

const SMOKE_HEADING = '## 6. Manual Smoke Test Protocol';

function planOf(lines: string[]): string {
  return ['# Plan', '', SMOKE_HEADING, '', ...lines, ''].join('\n');
}

describe('SmokeProtocol.fromPlan (issue #298)', () => {
  test('SP1: a JSON-quoted shell comparison is reported at the comparison line with a label', () => {
    const markdown = planOf([
      '#### Check 1 — RTM state helper',
      '',
      '```bash',
      'state() {',
      '  node -e \'process.stdout.write(JSON.stringify(process.argv[1]))\' "$1"',
      '}',
      'if [ "$(state 283 currentStage)" = "PLAN" ]; then',
      '  echo "PASS"',
      'fi',
      '```'
    ]);

    const protocol = SmokeProtocol.fromPlan(markdown);

    assert.strictEqual(protocol.found, true);
    assert.strictEqual(protocol.checks.length, 1);
    const finding = protocol.findings.find((f: any) => f.rule === 'quoted-json-comparison');
    assert.ok(finding, 'the quoted comparison must be reported');
    assert.strictEqual(finding.checkIndex, 1);
    assert.ok(finding.label.includes('Check 1'), `label=${finding.label}`);
    assert.ok(finding.line > 0);
    assert.ok(finding.excerpt.includes('state 283'), finding.excerpt);
    assert.strictEqual(protocol.executable, false);
  });

  test('SP2: a bare relative module path is reported; node:/./builtins are allowed', () => {
    const broken = SmokeProtocol.fromPlan(
      planOf([
        '```bash',
        'node -e \'const m = require("fixture.js");\'',
        '```'
      ])
    );
    const finding = broken.findings.find((f: any) => f.rule === 'bare-module-path');
    assert.ok(finding, 'a bare `require("fixture.js")` must be reported');
    assert.ok(finding.excerpt.includes('fixture.js'));

    const allowed = SmokeProtocol.fromPlan(
      planOf([
        '```bash',
        'node -e \'const fs = require("fs"); const p = require("node:path"); const x = require("./x.js");\'',
        '```'
      ])
    );
    assert.deepStrictEqual(allowed.findings, []);
    assert.strictEqual(allowed.executable, true);
  });

  test('SP3: a section with zero shell fences is not executable', () => {
    const protocol = SmokeProtocol.fromPlan(
      ['# Plan', '', SMOKE_HEADING, '', 'Run the checks below.', '', '## 7. Next', ''].join('\n')
    );

    assert.strictEqual(protocol.checks.length, 0);
    const finding = protocol.findings.find((f: any) => f.rule === 'no-executable-check');
    assert.ok(finding, 'a zero-check protocol must be rejected');
    assert.strictEqual(finding.line, 3, 'the finding names the section heading line');
    assert.strictEqual(protocol.executable, false);
  });

  test('SP3b: a placeholder-only scaffold section is NOT DECLARED, not broken', () => {
    // The generated plan template (never dispatched through the PLANNER by the
    // yolo fast path) emits exactly this shape. Treating it as a broken
    // protocol would strand every auto-scaffolded plan at IMPLEMENT.
    const protocol = SmokeProtocol.fromPlan(
      [
        '# Plan',
        '',
        SMOKE_HEADING,
        '- **Check 1:** ',
        '',
        '## 7. Next',
        ''
      ].join('\n')
    );

    assert.strictEqual(protocol.found, false);
    assert.strictEqual(protocol.checks.length, 0);
    assert.deepStrictEqual(protocol.findings, []);
    assert.strictEqual(protocol.executable, true);
    assert.strictEqual(protocol.toScript(), null);
  });

  test('SP3c: a section whose only fence is not shell is not executable', () => {
    const protocol = SmokeProtocol.fromPlan(
      ['# Plan', '', SMOKE_HEADING, '', '```text', 'echo not shell', '```', ''].join('\n')
    );

    assert.strictEqual(protocol.found, true);
    assert.strictEqual(protocol.checks.length, 0);
    assert.ok(protocol.findings.some((f: any) => f.rule === 'no-executable-check'));
  });

  test('SP4: toScript emits one marker per check and attributeFailure maps the last one', () => {
    const protocol = SmokeProtocol.fromPlan(
      planOf([
        '#### Check 1 — first',
        '',
        '```bash',
        'echo "C1 PASS"',
        '```',
        '',
        '#### Check 2 — second',
        '',
        '```bash',
        'echo "C2 FAIL: boom"',
        'exit 1',
        '```'
      ])
    );

    assert.strictEqual(protocol.checks.length, 2);
    const script = protocol.toScript();
    assert.ok(script.includes('__AGYLOOP_SMOKE_CHECK_1__'));
    assert.ok(script.includes('__AGYLOOP_SMOKE_CHECK_2__'));
    assert.ok(script.startsWith('set -e'));

    const failure = protocol.attributeFailure(
      [
        '__AGYLOOP_SMOKE_CHECK_1__',
        'C1 PASS',
        '__AGYLOOP_SMOKE_CHECK_2__',
        'C2 FAIL: boom'
      ].join('\n')
    );

    assert.ok(failure);
    assert.strictEqual(failure.checkIndex, 2);
    assert.ok(failure.label.includes('Check 2'), failure.label);
    assert.ok(failure.planLine > 0);
    assert.ok(failure.failLine.includes('C2 FAIL'), failure.failLine);

    assert.strictEqual(protocol.attributeFailure(null), null);
    assert.strictEqual(protocol.attributeFailure('no markers here'), null);
  });

  test('SP5: a comment-only fenced check is empty', () => {
    const protocol = SmokeProtocol.fromPlan(
      planOf([
        '```bash',
        '# nothing to run here',
        '',
        '```'
      ])
    );

    const finding = protocol.findings.find((f: any) => f.rule === 'empty-check');
    assert.ok(finding, 'an empty check must be rejected');
    assert.strictEqual(protocol.executable, false);
  });

  test('an absent section is found:false and executable (nothing to run)', () => {
    const protocol = SmokeProtocol.fromPlan('# Plan\n\n## Context\n');
    assert.strictEqual(protocol.found, false);
    assert.strictEqual(protocol.checks.length, 0);
    assert.deepStrictEqual(protocol.findings, []);
    assert.strictEqual(protocol.toScript(), null);
  });
});
