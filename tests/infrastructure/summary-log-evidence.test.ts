/**
 * agyloop - The summary writer records evidence, not template defaults
 * (issue #284, AC2/AC3/AC6)
 *
 * The defect: the summary kept its scaffold defaults (`Build Status: PENDING`),
 * appended a second review note on a re-review, and blamed a fabricated
 * `Suggested Commit`. These cases drive the REAL FilePlanGenerator against a
 * copy of `templates/summary-log.md` and assert the file's lines.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FilePlanGenerator } = require('../../dist/infrastructure');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(REPO_ROOT, 'templates', 'summary-log.md');

function tempSummary(): { dir: string; summaryPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-summary-evidence-'));
  const summaryPath = path.join(dir, 'CodeLoop Summary.md');
  fs.copyFileSync(TEMPLATE, summaryPath);
  return { dir, summaryPath };
}

function reviewRecord(round: number, verdict: string, base: string | null, summary: string) {
  return {
    round,
    verdict,
    baseCommit: base,
    timestamp: '2026-10-26T12:00:00.000Z',
    summary
  };
}

describe('summary writer evidence (issue #284)', () => {
  test('finalize turns every unrun row and metric into an honest "not recorded"', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      const ok = generator.updateSummaryLog(summaryPath, { finalize: true });
      assert.strictEqual(ok, true);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(!summary.includes('PENDING'), `no PENDING may survive, got:\n${summary}`);
      assert.ok(!summary.includes('IN PROGRESS'), `no IN PROGRESS may survive, got:\n${summary}`);

      for (const label of [
        '1. Discovery',
        '2. Plan Review',
        '3. Implementation',
        '4. Quality Gate',
        '5. AI Review',
        '6. Commit Gate'
      ]) {
        const line = summary.split('\n').find((candidate: string) => candidate.startsWith(`| ${label} |`));
        assert.ok(line, `row '${label}' must exist, got:\n${summary}`);
        assert.ok(
          line.includes('| NOT RECORDED |'),
          `row '${label}' must be terminal, got: ${line}`
        );
      }

      assert.ok(
        summary.includes('- **Build Status:** not recorded'),
        `the metric must be honest, got:\n${summary}`
      );
      assert.ok(
        summary.includes('- **Tests:** not recorded'),
        `the metric must be honest, got:\n${summary}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a second review round REPLACES the first — exactly one note, naming the base', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, {
        stage: 'AI Review',
        status: 'CHANGES_REQUESTED',
        reviewRecord: reviewRecord(1, 'CHANGES_REQUESTED', 'aaaaaaa1111', 'Round one found a nil dereference.')
      });
      generator.updateSummaryLog(summaryPath, {
        stage: 'AI Review',
        status: 'APPROVED',
        reviewRecord: reviewRecord(2, 'APPROVED', 'bbbbbbb2222', 'Round two is clean.')
      });

      const summary = fs.readFileSync(summaryPath, 'utf8');
      const bullets = summary.match(/^- \*\*Round /gm) ?? [];
      assert.strictEqual(bullets.length, 1, `exactly one review note expected, got:\n${summary}`);
      assert.ok(summary.includes('Round 2'), `the surviving note must be round 2, got:\n${summary}`);
      assert.ok(!summary.includes('Round 1'), `round 1 must be superseded, got:\n${summary}`);
      assert.ok(!summary.includes('nil dereference'), `round 1's text must be gone, got:\n${summary}`);
      assert.ok(
        summary.includes('base `bbbbbbb`'),
        `the note must name the reviewed base commit, got:\n${summary}`
      );
      assert.ok(
        !summary.includes('Suggested Commit'),
        `no fabricated commit subject may appear, got:\n${summary}`
      );
      assert.ok(
        !summary.includes('implementation_plan'),
        `the old scaffold-filename subject must never appear, got:\n${summary}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a review note does not disturb the Quality Gate Metrics section or the headings', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, {
        buildStatus: 'PASSED',
        testsStatus: 'PASSED (1408 passed)',
        buildSystem: 'node'
      });
      generator.updateSummaryLog(summaryPath, {
        reviewRecord: reviewRecord(1, 'APPROVED', 'ccccccc3333', 'Looks good.')
      });

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(summary.includes('## Quality Gate Metrics'), 'headings must survive');
      assert.ok(summary.includes('## Review Notes'), 'headings must survive');
      assert.ok(
        summary.includes('- **Build Status:** PASSED'),
        `the gate metrics must survive a review write, got:\n${summary}`
      );
      assert.ok(
        summary.includes('- **Tests:** PASSED (1408 passed)'),
        `the gate metrics must survive a review write, got:\n${summary}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a freshly scaffolded summary claims nothing and names the discovery subagent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-summary-scaffold-'));
    try {
      const generator = new FilePlanGenerator();
      const scaffold = generator.scaffoldPlanDirectory({
        projectRoot: dir,
        issue: 488,
        type: 'discovery',
        title: 'Summary Template Probe'
      });

      const summary = fs.readFileSync(scaffold.summaryPath, 'utf8');
      assert.ok(
        summary.includes('| 1. Discovery | `discovery` |'),
        `the Discovery row must name the discovery subagent, got:\n${summary}`
      );
      assert.ok(
        !summary.includes('`planner`'),
        `the Discovery row must never name the planner, got:\n${summary}`
      );
      assert.ok(
        summary.includes('Build Status:** not recorded'),
        `a fresh scaffold must claim nothing, got:\n${summary}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the Not Run line records a declared gate that never executed', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, {
        buildStatus: 'PASSED',
        testsStatus: 'PASSED (1408 passed)',
        notRun: [{ id: 'act', label: 'act', reason: 'no usable container runtime' }]
      });

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(
        summary.includes('- **Not Run:** act (no usable container runtime)'),
        `the skipped gate must be recorded, got:\n${summary}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #338: the summary reports what THIS round measured.
 *
 * The writer has three states per metric — untouched (`undefined`), REMOVED
 * (`null` / `[]`), and replaced (a value) — so a NOT RECORDED round can no
 * longer inherit the previous round's command list, check marks or reasons.
 */
describe('summary writer metrics are this round’s (issue #338)', () => {
  const FULL_EVIDENCE = {
    buildStatus: 'PASSED',
    testsStatus: 'PASSED (1899 passed)',
    buildSystem: 'node',
    executedCommands: ['npm run lint', 'npm test'],
    smokeChecks: [
      { id: 'check-1', label: 'check-1', passed: null },
      { id: 'check-2', label: 'check-2', passed: true },
      { id: 'check-3', label: 'check-3', passed: false }
    ],
    smokeProtocol: 'PASSED',
    notRun: [{ id: 'e2e', label: 'e2e', reason: 'no fixtures' }]
  };

  const CLEARING = {
    buildStatus: 'not recorded',
    testsStatus: 'not recorded',
    buildSystem: null,
    executedCommands: [],
    smokeChecks: [],
    smokeProtocol: null,
    notRun: []
  };

  function read(summaryPath: string): string {
    return fs.readFileSync(summaryPath, 'utf8');
  }

  test('#338 T4.1: a NOT RECORDED round removes every metric the previous round named', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, FULL_EVIDENCE);
      generator.updateSummaryLog(summaryPath, CLEARING);

      const summary = read(summaryPath);
      for (const label of [
        'Build System',
        'Executed Commands',
        'Smoke Checks',
        'Smoke Protocol',
        'Not Run'
      ]) {
        assert.ok(
          !summary.includes(`- **${label}:**`),
          `a metric no round measured must be gone (${label}), got:\n${summary}`
        );
      }
      assert.ok(summary.includes('- **Build Status:** not recorded'), summary);
      assert.ok(summary.includes('- **Tests:** not recorded'), summary);
      assert.ok(summary.includes('## Quality Gate Metrics'), 'the section heading survives');
      assert.ok(summary.includes('## Review Notes'), 'the next section survives');
      assert.ok(!summary.includes('\n\n\n'), `the removal must not leave blank runs, got:\n${summary}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#338 T4.2: applying the clearing payload twice is byte-identical', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, FULL_EVIDENCE);
      generator.updateSummaryLog(summaryPath, CLEARING);
      const once = read(summaryPath);
      generator.updateSummaryLog(summaryPath, CLEARING);
      assert.strictEqual(read(summaryPath), once, 'removal must be idempotent');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#338 T4.3: the protocol verdict renders next to the per-check marks', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, FULL_EVIDENCE);
      const summary = read(summaryPath);

      const checksLine = '- **Smoke Checks:** check-1 ❔, check-2 ✅, check-3 ❌';
      assert.ok(summary.includes(checksLine), summary);
      assert.ok(summary.includes('- **Smoke Protocol:** PASSED'), summary);

      const checksIndex = summary.indexOf('- **Smoke Checks:**');
      const protocolIndex = summary.indexOf('- **Smoke Protocol:**');
      const notRunIndex = summary.indexOf('- **Not Run:**');
      assert.ok(checksIndex < protocolIndex, 'the protocol verdict must follow the check marks');
      assert.ok(protocolIndex < notRunIndex, 'Not Run stays last');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('#338 T4.4: the three readings of a ❔ are distinguishable', () => {
    for (const value of ['PASSED', 'NOT_DECLARED', 'not reported']) {
      const { dir, summaryPath } = tempSummary();
      try {
        const generator = new FilePlanGenerator();
        generator.updateSummaryLog(summaryPath, { ...FULL_EVIDENCE, smokeProtocol: value });
        assert.ok(
          read(summaryPath).includes(`- **Smoke Protocol:** ${value}`),
          `smokeProtocol '${value}' must render verbatim`
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('#338 T4.5: a missing metric is inserted in order, inside the metrics section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-summary-order-'));
    const summaryPath = path.join(dir, 'CodeLoop Summary.md');
    fs.writeFileSync(
      summaryPath,
      [
        '# CodeLoop Execution Summary',
        '',
        '## Quality Gate Metrics',
        '- **Tests:** PASSED (12 passed)',
        '',
        '## Review Notes',
        '- looks good',
        ''
      ].join('\n'),
      'utf8'
    );
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, FULL_EVIDENCE);
      const summary = read(summaryPath);

      const metricsSection = summary
        .split('## Quality Gate Metrics')[1]
        .split('\n## ')[0];
      const renderedOrder = metricsSection
        .split('\n')
        .filter((line: string) => line.startsWith('- **'))
        .map((line: string) => line.slice(4, line.indexOf(':**')));
      assert.deepStrictEqual(renderedOrder, [
        'Build System',
        'Tests',
        'Executed Commands',
        'Smoke Checks',
        'Smoke Protocol',
        'Not Run'
      ]);
      const reviewIndex = summary.indexOf('## Review Notes');
      assert.ok(
        summary.indexOf('- **Not Run:**') < reviewIndex,
        `metrics must never be appended into the review section, got:\n${summary}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
