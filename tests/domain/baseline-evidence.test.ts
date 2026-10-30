/**
 * agyloop - BaselineEvidence value object tests (issue #388, Defect 1)
 *
 * BE1 - a claim parses its declared value, command and output
 * BE2 - the #382 DA-METRICS-1 fixture declares `{ additions: 3 }` while its
 *       command prints `{ additions: 4 }` (the shape the approval guard refuses)
 * BE3 - a header claim with no `### Baseline Evidence` section is a finding
 * BE3b - a body baseline number with no evidence carrier is a finding, and an
 *        incomplete claim names the missing label
 * BE4 - a body restatement of a claim id with a different value is a finding
 * BE5 - the ONE shared comparator: whitespace, backticks, JSON key order,
 *       numeric equality and a real mismatch
 * BE6 - a plan fixture embedded in a fenced smoke block is DATA, not evidence
 *       (the #388 plan's `cat > … <<'PLAN'` sample)
 * BE7 - a row quoting BOTH the declared and the measured value passes when the
 *       declared span matches the claim
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { BaselineEvidence, baselineValuesMatch } = require('../../dist/domain');

const HEADER_CLAIM =
  '**Revision analysed:** `abc1234`. Every baseline value was reproduced through `dist/` before this plan was written.';

function planOf(lines: string[]): string {
  return ['# [Implementation] - probe', '', ...lines, ''].join('\n');
}

function claimPlan(overrides: Record<string, string> = {}): string {
  const declared = overrides.declared ?? '`{ additions: 3, deletions: 0 }`';
  const command =
    overrides.command ?? "`node -e 'console.log(\"{ additions: 4, deletions: 0 }\")'`";
  const output = overrides.output ?? '`{ additions: 4, deletions: 0 }`';

  return planOf([
    '## 1. Context & Objectives',
    '- **Feature Overview:** probe',
    '',
    '### Baseline Evidence',
    '',
    '#### DA-METRICS-1',
    '',
    `- **Declared:** ${declared}`,
    `- **Command:** ${command}`,
    `- **Output:** ${output}`
  ]);
}

describe('BaselineEvidence.fromPlan (issue #388)', () => {
  test('BE1: a complete claim parses its declared, command and output values', () => {
    const parsed = BaselineEvidence.fromPlan(claimPlan());

    assert.strictEqual(parsed.found, true);
    assert.strictEqual(parsed.claimedReproduction, false, 'no header claim in this fixture');
    assert.strictEqual(parsed.claims.length, 1, JSON.stringify(parsed));
    assert.strictEqual(parsed.claims[0].id, 'DA-METRICS-1');
    assert.strictEqual(parsed.claims[0].declared, '{ additions: 3, deletions: 0 }');
    assert.ok(parsed.claims[0].command.includes('additions: 4'), parsed.claims[0].command);
    assert.strictEqual(parsed.claims[0].output, '{ additions: 4, deletions: 0 }');
    assert.deepStrictEqual(parsed.findings, []);
  });

  test('BE1b: a numbered chapter heading above the section is outline prose, not a claim', () => {
    const parsed = BaselineEvidence.fromPlan(
      planOf([
        '## 4. Baseline Evidence',
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `3`',
        "- **Command:** `node -e 'console.log(3)'`",
        '- **Output:** `3`'
      ])
    );

    assert.strictEqual(parsed.claims.length, 1, JSON.stringify(parsed));
    assert.strictEqual(parsed.claims[0].id, 'DA-METRICS-1');
    assert.deepStrictEqual(parsed.findings, []);
  });

  test('BE2: the #382 DA-METRICS-1 shape declares 3 while the command prints 4', () => {
    const parsed = BaselineEvidence.fromPlan(claimPlan());

    assert.strictEqual(parsed.claims.length, 1, JSON.stringify(parsed));
    assert.strictEqual(parsed.claims[0].declared, '{ additions: 3, deletions: 0 }');
    assert.match(parsed.claims[0].command, /additions: 4/);
    // The evidence itself is structurally complete: only measurement can catch
    // the lie, which is what the application guard does.
    assert.deepStrictEqual(parsed.findings, []);
  });

  test('BE3: a header reproduction claim with no evidence section is a finding', () => {
    const unbacked = BaselineEvidence.fromPlan(
      planOf([
        HEADER_CLAIM,
        '',
        '## 1. Context & Objectives',
        '- **Feature Overview:** probe'
      ])
    );

    assert.strictEqual(unbacked.claimedReproduction, true);
    assert.strictEqual(unbacked.found, false);
    assert.ok(
      unbacked.findings.some((finding: any) => finding.rule === 'missing-baseline-evidence'),
      JSON.stringify(unbacked.findings)
    );
  });

  test('BE3b: a body baseline number with no carrier is a finding; an incomplete claim names the label', () => {
    const unbacked = BaselineEvidence.fromPlan(
      planOf([
        HEADER_CLAIM,
        '',
        '## 1. Context & Objectives',
        'The affected suites measured 76 tests, 76 pass.',
        '',
        'Baseline of the affected suites: 76 tests, 76 pass, 0 fail.'
      ])
    );
    const missing = unbacked.findings.filter(
      (finding: any) => finding.rule === 'missing-baseline-evidence'
    );
    assert.ok(
      missing.some((finding: any) => finding.excerpt.includes('76 tests')),
      JSON.stringify(unbacked.findings)
    );
    // The body number is a finding in its own right; the header claim itself is
    // reported once, at its header line.
    assert.ok(
      missing.some((finding: any) => finding.line === 8),
      JSON.stringify(missing)
    );

    const incomplete = BaselineEvidence.fromPlan(
      planOf([
        '## 1. Context & Objectives',
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `{ additions: 3, deletions: 0 }`'
      ])
    );
    const rules = incomplete.findings.map((finding: any) => finding.rule);
    assert.ok(rules.includes('missing-baseline-command'), JSON.stringify(incomplete.findings));
    assert.ok(rules.includes('missing-baseline-output'), JSON.stringify(incomplete.findings));
    assert.ok(!rules.includes('missing-baseline-value'), JSON.stringify(incomplete.findings));
  });

  test('BE3c: a §1 problem statement cannot arm the header rule', () => {
    const bodyClaim = BaselineEvidence.fromPlan(
      planOf([
        '## 1. Context & Objectives',
        'Every baseline value was reproduced through `dist/` before this plan was written.',
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `3`',
        '- **Command:** `node -e \'console.log(3)\'`',
        '- **Output:** `3`'
      ])
    );

    assert.strictEqual(bodyClaim.claimedReproduction, false);
    assert.deepStrictEqual(bodyClaim.findings, []);
  });

  test('BE4: a body line that restates a claim id with a different value is a finding', () => {
    const bodyRow = (value: string): string =>
      planOf([
        '## 4. Quality Gate & Test Verification',
        '',
        `| ID | Asserts |`,
        '|---|---|',
        `| DA-METRICS-1 | totals are \`${value}\` |`,
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `{ additions: 3, deletions: 0 }`',
        "- **Command:** `node -e 'console.log(\"{ additions: 3, deletions: 0 }\")'`",
        '- **Output:** `{ additions: 3, deletions: 0 }`'
      ]);

    const agreeing = BaselineEvidence.fromPlan(bodyRow('{ additions: 3, deletions: 0 }'));
    assert.deepStrictEqual(agreeing.findings, [], JSON.stringify(agreeing.findings));

    const drifted = BaselineEvidence.fromPlan(bodyRow('{ additions: 4, deletions: 0 }'));
    const mismatch = drifted.findings.find(
      (finding: any) => finding.rule === 'baseline-body-mismatch'
    );
    assert.ok(mismatch, JSON.stringify(drifted.findings));
    assert.strictEqual(mismatch.claim, 'DA-METRICS-1');
  });

  test('BE6: a fenced plan sample is not evidence (the #388 `cat > … <<\'PLAN\'` shape)', () => {
    const FENCE = String.fromCharCode(96, 96, 96);
    const sample = [
      '# [Implementation] - sample',
      '',
      '### Baseline Evidence',
      '',
      '#### DA-METRICS-1',
      '',
      '- **Declared:** `{ additions: 4, deletions: 0 }`',
      "- **Command:** `node -e 'console.log(\"{ additions: 4, deletions: 0 }\")'`",
      '- **Output:** `{ additions: 4, deletions: 0 }`'
    ];

    const plan = planOf([
      '## 1. Context & Objectives',
      '| ID | Declared |',
      '|---|---|',
      '| DA-METRICS-1 | `{ additions: 3, deletions: 0 }` |',
      '',
      '### Manual Smoke Test Protocol',
      '',
      `${FENCE}bash`,
      'set -eu',
      'SBX="$HOME/.cache/agyloop/smoke-388/fenced-sample"',
      'mkdir -p "$SBX/artifacts/plans/388-probe"',
      'cat > "$SBX/artifacts/plans/388-probe/implementation_plan.md" <<\'PLAN\'',
      ...sample,
      'PLAN',
      FENCE
    ]);

    const parsed = BaselineEvidence.fromPlan(plan);
    assert.strictEqual(parsed.found, false, JSON.stringify(parsed));
    assert.strictEqual(parsed.claims.length, 0, JSON.stringify(parsed.claims));
    assert.deepStrictEqual(parsed.findings, [], JSON.stringify(parsed.findings));

    // A real section outside the fence is still found, even when the sample
    // appears first in document order.
    const withRealSection = planOf([
      '## 1. Context & Objectives',
      '| ID | Declared |',
      '|---|---|',
      '| DA-METRICS-1 | `{ additions: 3, deletions: 0 }` |',
      '',
      '### Manual Smoke Test Protocol',
      '',
      `${FENCE}bash`,
      'cat > sample.md <<\'PLAN\'',
      ...sample,
      'PLAN',
      FENCE,
      '',
      '### Baseline Evidence',
      '',
      '#### DA-METRICS-1',
      '',
      '- **Declared:** `{ additions: 3, deletions: 0 }`',
      "- **Command:** `node -e 'console.log(3)'`",
      '- **Output:** `{ additions: 3, deletions: 0 }`'
    ]);
    const real = BaselineEvidence.fromPlan(withRealSection);
    assert.strictEqual(real.found, true, JSON.stringify(real));
    assert.strictEqual(real.claims.length, 1, JSON.stringify(real.claims));
    assert.strictEqual(real.claims[0].declared, '{ additions: 3, deletions: 0 }');
    assert.deepStrictEqual(real.findings, [], JSON.stringify(real.findings));
  });

  test('BE7: a declared/measured row passes when the declared span matches the claim', () => {
    const withRow = (row: string): string =>
      planOf([
        '## 4. Quality Gate & Test Verification',
        '',
        '| ID | Asserts |',
        '|---|---|',
        `| DA-METRICS-1 | ${row} |`,
        '',
        '### Baseline Evidence',
        '',
        '#### DA-METRICS-1',
        '',
        '- **Declared:** `{ additions: 3, deletions: 0 }`',
        "- **Command:** `node -e 'console.log(3)'`",
        '- **Output:** `{ additions: 3, deletions: 0 }`'
      ]);

    const agreeing = BaselineEvidence.fromPlan(
      withRow('declared `{ additions: 3, deletions: 0 }`, measured `{ additions: 4, deletions: 0 }`')
    );
    assert.deepStrictEqual(agreeing.findings, [], JSON.stringify(agreeing.findings));

    const drifted = BaselineEvidence.fromPlan(
      withRow('declared `{ additions: 5, deletions: 0 }`, measured `{ additions: 4, deletions: 0 }`')
    );
    const mismatch = drifted.findings.find(
      (finding: any) => finding.rule === 'baseline-body-mismatch'
    );
    assert.ok(mismatch, JSON.stringify(drifted.findings));
    assert.strictEqual(mismatch.declared, '{ additions: 3, deletions: 0 }');
    assert.ok(mismatch.restated.includes('additions: 5'), mismatch.restated);
    assert.ok(mismatch.restated.includes('additions: 4'), mismatch.restated);
  });

  test('BE5: the shared comparator normalises whitespace, backticks and JSON key order', () => {
    assert.strictEqual(
      baselineValuesMatch('{ additions: 3, deletions: 0 }', '  { additions: 3,   deletions: 0 } '),
      true
    );
    assert.strictEqual(baselineValuesMatch('`4`', '4'), true);
    assert.strictEqual(
      baselineValuesMatch('{"additions":4,"deletions":0}', '{"deletions":0,"additions":4}'),
      true
    );
    assert.strictEqual(baselineValuesMatch('76', '76.0'), true);
    assert.strictEqual(
      baselineValuesMatch('{ additions: 3, deletions: 0 }', '{ additions: 4, deletions: 0 }'),
      false
    );
    assert.strictEqual(baselineValuesMatch('', '4'), false);
  });
});
