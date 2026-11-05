/**
 * codeloop - The summary writer records evidence, not template defaults
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-summary-evidence-'));
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
        '3. Plan Approval',
        '4. Implementation',
        '5. Quality Gate',
        '6. AI Review',
        '7. Commit Gate'
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

  test('a second review round keeps both notes and marks the latest current', () => {
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
      assert.strictEqual(bullets.length, 2, `one note per round expected, got:\n${summary}`);
      assert.ok(summary.includes('Round 1'), `round 1 must be kept, got:\n${summary}`);
      assert.ok(summary.includes('CHANGES_REQUESTED'), `round 1's verdict must survive, got:\n${summary}`);
      assert.ok(
        summary.includes('Round 2 · APPROVED (current)'),
        `the latest round must be marked current, got:\n${summary}`
      );
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-summary-scaffold-'));
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-summary-order-'));
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

/**
 * Issue #376 (absorbing #396): the summary renders EVERY remediation round.
 *
 * `updateSummaryLog` rewrote the first matching stage row and `break`ed, so a
 * run that went IMPLEMENT → QUALITY_GATE → REVIEW twice kept only round 2's
 * numbers — the earlier round's duration and verdict vanished from the run's
 * own deliverable. Rounds are now labelled rows and the Review Notes accumulate.
 */
describe('summary renders remediation rounds (issue #376, absorbing #396)', () => {
  const note = (round: number, verdict: string, timestamp: string) => ({
    round,
    verdict,
    baseCommit: '23544c9',
    timestamp,
    summary: `round ${round} ${verdict.toLowerCase()}`
  });

  function seedTwoRounds(generator: any, summaryPath: string): void {
    generator.updateSummaryLog(summaryPath, {
      stage: 'Implementation',
      status: 'COMPLETED',
      duration: '26m 29s',
      round: 1
    });
    generator.updateSummaryLog(summaryPath, {
      stage: 'Quality Gate',
      status: 'COMPLETED',
      duration: '2m 55s',
      round: 1,
      gateSelfReport: { round: 1, text: '1m 32s (gate-reported; 2m 55s wall)' }
    });
    generator.updateSummaryLog(summaryPath, {
      stage: 'AI Review',
      status: 'CHANGES_REQUESTED',
      duration: '4m 45s',
      round: 1,
      reviewRecord: note(1, 'CHANGES_REQUESTED', '2026-11-03T01:28:40Z')
    });
    generator.updateSummaryLog(summaryPath, {
      stage: 'Implementation',
      status: 'COMPLETED',
      duration: '4m 11s',
      round: 2
    });
    generator.updateSummaryLog(summaryPath, {
      stage: 'Quality Gate',
      status: 'COMPLETED',
      duration: '2m 55s',
      round: 2,
      gateSelfReport: { round: 2, text: '1m 32s (gate-reported; 2m 55s wall)' }
    });
    generator.updateSummaryLog(summaryPath, {
      stage: 'AI Review',
      status: 'APPROVED',
      duration: '4m 56s',
      round: 2,
      reviewRecord: note(2, 'APPROVED', '2026-11-03T01:45:13Z')
    });
  }

  test('a two-round summary renders every round, keeps round 1, and marks the latest review current (#376, #396)', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      seedTwoRounds(generator, summaryPath);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      const implementationRows = summary
        .split('\n')
        .filter((line: string) => line.startsWith('| 4. Implementation'));

      assert.strictEqual(
        implementationRows.length,
        2,
        `both implement rounds must render, got:\n${summary}`
      );
      const roundOne = implementationRows.find((line: string) => line.includes('(round 1)'));
      const roundTwo = implementationRows.find((line: string) => line.includes('(round 2)'));
      assert.ok(roundOne, `round 1 must be named, got:\n${summary}`);
      assert.ok(roundTwo, `round 2 must be named, got:\n${summary}`);
      assert.ok(roundOne!.includes('26m 29s'), `round 1 duration must survive: ${roundOne}`);
      assert.ok(roundTwo!.includes('4m 11s'), `round 2 duration must render: ${roundTwo}`);
      assert.match(
        roundTwo as string,
        /^\| 4\. Implementation \(round 2\) \|/,
        `the round-2 row must be labelled, got: ${roundTwo}`
      );

      // The review history survives too.
      assert.ok(summary.includes('CHANGES_REQUESTED'), `round 1's verdict must survive:\n${summary}`);
      const bullets = summary.match(/^- \*\*Round /gm) ?? [];
      assert.strictEqual(bullets.length, 2, `one bullet per review round expected, got:\n${summary}`);
      assert.ok(
        summary.includes('Round 2 · APPROVED (current)'),
        `the latest round must be marked current, got:\n${summary}`
      );

      // The gate row carries ONE clock; both clocks live in the named notes.
      assert.ok(summary.includes('Quality Gate self-report (round 1)'), summary);
      assert.ok(summary.includes('Quality Gate self-report (round 2)'), summary);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a single-round summary gains no round labels and keeps one row per stage (#376)', () => {
    const { dir, summaryPath } = tempSummary();
    try {
      const generator = new FilePlanGenerator();
      generator.updateSummaryLog(summaryPath, {
        stage: 'Implementation',
        status: 'COMPLETED',
        duration: '4m 11s',
        round: 1
      });
      generator.updateSummaryLog(summaryPath, {
        stage: 'AI Review',
        status: 'APPROVED',
        duration: '4m 56s',
        round: 1,
        reviewRecord: {
          round: 1,
          verdict: 'APPROVED',
          baseCommit: 'aaaaaaa1111',
          timestamp: '2026-10-26T12:00:00.000Z',
          summary: 'Looks good.'
        }
      });

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(!summary.includes('(round'), `no round label may appear, got:\n${summary}`);
      for (const label of [
        '1. Discovery',
        '2. Plan Review',
        '3. Plan Approval',
        '4. Implementation',
        '5. Quality Gate',
        '6. AI Review',
        '7. Commit Gate'
      ]) {
        const rows = summary
          .split('\n')
          .filter((line: string) => line.startsWith(`| ${label} |`));
        assert.strictEqual(rows.length, 1, `exactly one '${label}' row expected, got:\n${summary}`);
      }
      // The single-round bullet is byte-identical to the pre-#376 shape.
      assert.ok(
        summary.includes(
          '- **Round 1 · APPROVED · base `aaaaaaa` · 2026-10-26T12:00:00.000Z** — Looks good.'
        ),
        `the single-round bullet must be unchanged, got:\n${summary}`
      );
      assert.ok(!summary.includes('(current)'), `no current marker on a single round, got:\n${summary}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the Duration column sums to Session Started → Commit for a two-round run (#376)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-summary-rounds-'));
    const summaryPath = path.join(dir, 'CodeLoop Summary.md');
    const sessionStarted = '2026-11-03T01:00:00.000Z';
    const commitTimestamp = '2026-11-03T02:10:00.000Z';

    const template = fs.readFileSync(TEMPLATE, 'utf8').replace('{Timestamp}', sessionStarted);
    fs.writeFileSync(summaryPath, template, 'utf8');
    try {
      const generator = new FilePlanGenerator();
      const write = (data: any) => {
        assert.strictEqual(generator.updateSummaryLog(summaryPath, data), true);
      };

      write({ stage: 'Discovery', status: 'COMPLETED', duration: '2m 22s', round: 1 });
      write({ stage: 'Plan Review', status: 'APPROVED', duration: '6m 1s', round: 1 });
      write({ stage: 'Plan Approval', status: 'COMPLETED', duration: '1m 0s', round: 1 });
      write({ stage: 'Implementation', status: 'COMPLETED', duration: '26m 29s', round: 1 });
      write({ stage: 'Quality Gate', status: 'COMPLETED', duration: '3m 16s', round: 1 });
      write({
        stage: 'AI Review',
        status: 'CHANGES_REQUESTED',
        duration: '4m 45s',
        round: 1,
        reviewRecord: note(1, 'CHANGES_REQUESTED', '2026-11-03T01:28:40Z')
      });
      write({ stage: 'Implementation', status: 'COMPLETED', duration: '4m 11s', round: 2 });
      write({ stage: 'Quality Gate', status: 'COMPLETED', duration: '2m 0s', round: 2 });
      write({
        stage: 'AI Review',
        status: 'APPROVED',
        duration: '4m 56s',
        round: 2,
        reviewRecord: note(2, 'APPROVED', '2026-11-03T01:45:13Z')
      });
      write({ stage: 'Commit Gate', status: 'COMPLETED', duration: '15m 0s', round: 1 });
      write({ commitHash: 'abc1234', commitMessage: 'fix(app): a subject (#376)', commitTimestamp });

      const summary = fs.readFileSync(summaryPath, 'utf8');
      const durationCells = summary
        .split('\n')
        .filter((line: string) => /^\| \d+\. /.test(line))
        .map((line: string) => (line.split('|')[5] || '').trim())
        .filter((cell: string) => /^(?:\d+m )?\d+s$/.test(cell));

      const totalSeconds = durationCells.reduce((total: number, cell: string) => {
        const match = /^(?:(\d+)m )?(\d+)s$/.exec(cell) as RegExpExecArray;
        return total + Number(match[1] ?? 0) * 60 + Number(match[2]);
      }, 0);

      const elapsedSeconds = (Date.parse(commitTimestamp) - Date.parse(sessionStarted)) / 1000;
      assert.ok(
        Math.abs(totalSeconds - elapsedSeconds) <= 1,
        `the table must reconcile with Session Started → Commit: ${totalSeconds}s vs ${elapsedSeconds}s (${durationCells.join(', ')})`
      );
      assert.strictEqual(
        durationCells.length,
        10,
        `every stage row must carry a wall clock: ${durationCells.join(', ')}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
