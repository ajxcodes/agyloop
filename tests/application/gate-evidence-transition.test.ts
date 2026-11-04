/**
 * agyloop - Gate evidence is ingested on gate exit (issue #284, AC1/AC2)
 *
 * The defect: a gate that reported PASSED with 1408 tests left the summary at
 * `Build Status: PENDING` forever, because the dispatched gate's result had no
 * channel into the writer. These cases file a synthetic report and drive the
 * REAL TransitionStageUseCase against a REAL summary file, asserting the
 * printed lines — and that a gate with no evidence says `not recorded`.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TransitionStageUseCase } = require('../../dist/application');
const { FileStateRepository, FilePlanGenerator, FileGateReportRepository } = require('../../dist/infrastructure');
const {
  GateResultReport,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_IMPLEMENT,
  resolveGateRound
} = require('../../dist/domain');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ISSUE = 487;

const PASSED_REPORT = GateResultReport.fromJSON(
  {
    verdict: 'PASSED',
    buildSystem: 'node',
    buildStatus: 'PASSED',
    testsStatus: 'PASSED (1408 passed)',
    testsPassed: 1408,
    testsFailed: 0,
    durationMs: 196000,
    executedCommands: ['npm run lint', 'npm test'],
    smokeProtocol: 'PASSED',
    notRun: [],
    gateRound: 1
  },
  1
);

class FakeGateReportRepository {
  public reports: Map<string, any> = new Map();
  public loads = 0;
  public clears = 0;

  load(issue: any): any {
    this.loads += 1;
    return this.reports.get(String(issue)) ?? null;
  }

  save(issue: any, report: any): string {
    this.reports.set(String(issue), report);
    return `/fake/${issue}.gate.json`;
  }

  clear(issue: any): void {
    this.clears += 1;
    this.reports.delete(String(issue));
  }
}

function scaffoldWorkspace(
  currentStage: string,
  history: Array<Record<string, unknown>>,
  planContent = '# [Implementation] - Smoke\n\n- [ ] Step 1: probe\n'
) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-gate-evidence-'));
  const dir = path.join(ws, 'artifacts', 'plans', `${ISSUE}-smoke`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'implementation_plan.md'), planContent, 'utf8');
  const summaryPath = path.join(dir, 'CodeLoop Summary.md');
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', 'summary-log.md'), summaryPath);

  const tasksDir = path.join(ws, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(tasksDir, `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage,
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        planDir: `artifacts/plans/${ISSUE}-smoke`,
        createdAt: now,
        updatedAt: now,
        history,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0
      },
      null,
      2
    ),
    'utf8'
  );

  return { ws, summaryPath };
}

async function runTransition(ws: string, targetStage: string, repo: unknown) {
  const stateRepo = createStateRepository({ workspaceDir: ws, issue: ISSUE });
  const useCase = new TransitionStageUseCase(
    stateRepo,
    undefined,
    undefined,
    new FilePlanGenerator(),
    repo
  );
  return useCase.execute({
    targetStage,
    issue: ISSUE,
    workspaceDir: ws,
    noWorktree: true
  });
}

function row(summary: string, label: string): string {
  const line = summary
    .split('\n')
    .find((candidate) => candidate.startsWith(`| ${label} |`));
  assert.ok(line, `the summary must contain the '${label}' row, got:\n${summary}`);
  return line as string;
}

/**
 * The gate row's Duration cell: exactly ONE clock (issue #376, AC16).
 *
 * The cell used to pack the gate's self-timer and the wall window into one
 * non-summable string. It now carries the wall clock only (or `-`), so nothing
 * but `1m 32s` / `-` may appear here.
 */
function gateRowWallSeconds(summary: string): number | null {
  const cell = (row(summary, '5. Quality Gate').split('|')[5] ?? '').trim();
  if (cell === '-') return null;
  const match = /^(?:(\d+)m )?(\d+)s$/.exec(cell);
  if (match === null) {
    throw new Error(`the gate Duration cell must carry exactly ONE clock, got: ${cell}`);
  }
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
}

/** The gate's self-reported timer for `round`, as a named note. */
function gateSelfReport(summary: string, round: number): string {
  const prefix = `- **Quality Gate self-report (round ${round}):**`;
  const line = summary
    .split('\n')
    .find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `the round-${round} self-report note must exist, got:\n${summary}`);
  return (line as string).slice(prefix.length).trim();
}

/** A plan carrying the declared verification targets (for the #325/#412 cases). */
function planWithTargets(commands: readonly string[] = ['npm test']): string {
  return [
    '# [Implementation] - Smoke',
    '',
    '- [ ] Step 1: probe',
    '',
    '## 4. Quality Gate & Test Verification',
    '',
    '### Quality Gate Targets',
    '',
    '```bash',
    ...commands,
    '```',
    ''
  ].join('\n');
}

describe('gate evidence ingested on gate exit (issue #284)', () => {
  let warnings: string[] = [];
  const originalWarn = console.warn;

  beforeEach(() => {
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test('the Quality Gate row has one wall clock and the self-report note names both clocks (#376)', async () => {
    // State 1: the wall window IS measurable (the gate entry is penultimate).
    const now = Date.now();
    const measured = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
    repo.reports.set(String(ISSUE), PASSED_REPORT);

    try {
      await runTransition(measured.ws, STAGE_REVIEW, repo);
      const summary = fs.readFileSync(measured.summaryPath, 'utf8');

      const cell = (row(summary, '5. Quality Gate').split('|')[5] ?? '').trim();
      assert.match(cell, /^(?:\d+m )?\d+s$/, `the cell must carry ONE clock, got: ${cell}`);
      const wallSeconds = gateRowWallSeconds(summary);
      assert.ok(
        wallSeconds !== null && Math.abs(wallSeconds - 200) <= 5,
        `the cell must be the wall window, got: ${cell}`
      );
      assert.match(
        gateSelfReport(summary, 1),
        /^3m 16s \(gate-reported; .* wall\)$/,
        `round 1's note must name both clocks, got: ${gateSelfReport(summary, 1)}`
      );
    } finally {
      fs.rmSync(measured.ws, { recursive: true, force: true });
    }

    // State 2: no QUALITY_GATE history entry, so no wall window is measurable.
    const unmeasured = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo2 = new FakeGateReportRepository();
    repo2.reports.set(String(ISSUE), PASSED_REPORT);
    try {
      await runTransition(unmeasured.ws, STAGE_REVIEW, repo2);
      const summary = fs.readFileSync(unmeasured.summaryPath, 'utf8');
      const cell = (row(summary, '5. Quality Gate').split('|')[5] ?? '').trim();
      assert.strictEqual(cell, '-', `an unmeasurable window must print '-', got: ${cell}`);
      assert.strictEqual(
        gateSelfReport(summary, 1),
        '3m 16s (gate-reported)',
        `the note must name the clock it shows, got:\n${summary}`
      );
    } finally {
      fs.rmSync(unmeasured.ws, { recursive: true, force: true });
    }
  });

  test('a filed PASSED report writes the verdict, build system, test count and measured duration', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
    repo.reports.set(String(ISSUE), PASSED_REPORT);

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(
        summary.includes('- **Build Status:** PASSED'),
        `the gate verdict must be recorded, got:\n${summary}`
      );
      assert.ok(
        summary.includes('- **Tests:** PASSED (1408 passed)'),
        `the test count must be recorded, got:\n${summary}`
      );
      assert.ok(
        summary.includes('- **Build System:** node'),
        `the build system must be recorded, got:\n${summary}`
      );
      // Issue #315 (AC-15/AC-18) / #376 (AC16): the Duration cell is the WALL
      // clock; the gate's self-timer lives in a named note carrying both.
      const wallSeconds = gateRowWallSeconds(summary);
      assert.ok(
        wallSeconds !== null && Math.abs(wallSeconds - 200) <= 5,
        `the gate row must report the stage wall clock it measured, got: ${wallSeconds}`
      );
      assert.match(
        gateSelfReport(summary, 1),
        /^3m 16s \(gate-reported; .* wall\)$/,
        `the note must name both clocks, got: ${gateSelfReport(summary, 1)}`
      );
      assert.ok(!summary.includes('Build Status:** PENDING'), `PENDING must never survive, got:\n${summary}`);

      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
      assert.strictEqual(last.metadata.gateVerdict, 'PASSED');
      assert.strictEqual(last.metadata.gateTests, 'PASSED (1408 passed)');
      // Issue #315 (AC-15): the transport field is renamed so `stageDurationMs`
      // keeps its single meaning ("this stage measured itself").
      assert.strictEqual(last.metadata.gateReportedDurationMs, 196000);
      assert.strictEqual(
        last.metadata.stageDurationMs,
        undefined,
        'a gate duration must never be transported as the entered stage’s own measurement'
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('a gate with NO filed evidence REFUSES the exit and writes nothing (#327)', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
    const checkpointPathLocal = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const checkpointBefore = fs.readFileSync(checkpointPathLocal, 'utf8');
    const summaryBefore = fs.readFileSync(summaryPath, 'utf8');

    try {
      await assert.rejects(
        async () => runTransition(ws, STAGE_REVIEW, repo),
        (err: any) => {
          assert.match(String(err.message), /Gate evidence refused/);
          assert.match(String(err.message), /gate round 1/);
          assert.match(String(err.message), /codeloop gate-report --issue 487/);
          assert.match(String(err.message), /codeloop transition REVIEW --issue 487/);
          return true;
        },
        'a certification exit must consume evidence or not happen'
      );

      // NOTHING was written: no checkpoint change, no summary row, no consume.
      assert.strictEqual(fs.readFileSync(checkpointPathLocal, 'utf8'), checkpointBefore);
      assert.strictEqual(fs.readFileSync(summaryPath, 'utf8'), summaryBefore);
      assert.strictEqual(repo.clears, 0, 'a refused exit must not consume anything');
      assert.strictEqual(repo.loads, 1, 'the ingest side reads the evidence once');
      const checkpoint = JSON.parse(checkpointBefore);
      assert.ok(
        !checkpoint.history.some((entry: any) => entry.stage === STAGE_REVIEW),
        'no REVIEW entry may be written by a refusal'
      );
      assert.strictEqual(warnings.length, 0, `no warning-plus-advance, got: ${warnings.join(' | ')}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('a report from a DIFFERENT round is REFUSED, not silently discarded (#327)', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 400_000).toISOString() },
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 300_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
    const checkpointPathLocal = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const checkpointBefore = fs.readFileSync(checkpointPathLocal, 'utf8');
    const summaryBefore = fs.readFileSync(summaryPath, 'utf8');
    // A stale report for round 0 while the checkpoint is at round 2.
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          verdict: 'PASSED',
          buildSystem: 'node',
          buildStatus: 'PASSED',
          testsStatus: 'PASSED (9999 passed)',
          testsPassed: 9999,
          testsFailed: 0,
          durationMs: 1000,
          executedCommands: ['npm test'],
          gateRound: 0
        },
        0
      )
    );

    try {
      await assert.rejects(
        async () => runTransition(ws, STAGE_REVIEW, repo),
        (err: any) => {
          assert.match(String(err.message), /Gate evidence refused/);
          assert.match(String(err.message), /certifies gate round 0, not gate round 2/);
          return true;
        }
      );

      assert.strictEqual(fs.readFileSync(checkpointPathLocal, 'utf8'), checkpointBefore);
      assert.strictEqual(fs.readFileSync(summaryPath, 'utf8'), summaryBefore);
      assert.ok(
        !summaryBefore.includes('9999 passed'),
        'a stale report must not certify this round'
      );
      assert.strictEqual(repo.clears, 0, 'a stale report is not consumed by a refusal');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('a non-certifying exit keeps NOT RECORDED and names a LEGAL walk back (#327 AC-7)', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();

    try {
      const sm = await runTransition(ws, STAGE_IMPLEMENT, repo);

      assert.strictEqual(sm.currentStage, STAGE_IMPLEMENT);
      assert.strictEqual(sm.history[sm.history.length - 1].metadata.gateVerdict, 'NOT_RECORDED');
      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.strictEqual(
        row(summary, '5. Quality Gate'),
        '| 5. Quality Gate | `gate` | `flash_lite` | NOT RECORDED | 3m 20s |'
      );
      assert.strictEqual(warnings.length, 1, warnings.join(' | '));
      assert.ok(
        warnings[0].includes('codeloop transition QUALITY_GATE --issue 487'),
        `the advice must be executable from IMPLEMENT, got: ${warnings[0]}`
      );
      assert.ok(warnings[0].includes('codeloop gate-report --issue <n>'), warnings[0]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('the report is CONSUMED on ingest so it cannot certify a second round', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
    repo.reports.set(String(ISSUE), PASSED_REPORT);

    try {
      await runTransition(ws, STAGE_REVIEW, repo);
      assert.strictEqual(repo.clears, 1, 'ingest must consume the report exactly once');
      assert.strictEqual(repo.load(ISSUE), null, 'the same report must not be readable again');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('entering QUALITY_GATE clears a stale report before the save', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(STAGE_IMPLEMENT, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
    repo.reports.set(String(ISSUE), PASSED_REPORT);

    try {
      await runTransition(ws, STAGE_QUALITY_GATE, repo);
      assert.strictEqual(repo.clears, 1, 'a stale report must be discarded on entry');
      assert.strictEqual(repo.load(ISSUE), null);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('#311 T1: filing and ingest agree on round 1 when the history has no QUALITY_GATE entry', async () => {
    // A checkpoint that sits at QUALITY_GATE without a QG entry in its history:
    // the filing side clamps to max(1, count), the ingest side used to read the
    // raw count (0) and discarded a freshly filed round-1 report as stale.
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
    const filedRound = resolveGateRound([{ stage: STAGE_IMPLEMENT }]);
    assert.strictEqual(filedRound, 1, 'a count-0 checkpoint files round 1');
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON({ ...PASSED_REPORT.toJSON(), gateRound: filedRound }, filedRound)
    );

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);

      assert.ok(
        !warnings.some((entry) => entry.includes('no gate evidence')),
        `a freshly filed round-1 report must not be discarded, got: ${warnings.join(' | ')}`
      );
      const summary = fs.readFileSync(summaryPath, 'utf8');
      // No QUALITY_GATE entry existed, so no wall clock is measurable: the cell
      // is `-` and the note names only the clock it is showing.
      assert.strictEqual(
        gateRowWallSeconds(summary),
        null,
        'an unmeasurable wall window must not be invented'
      );
      assert.strictEqual(gateSelfReport(summary, 1), '3m 16s (gate-reported)');
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
      assert.strictEqual(last.metadata.gateVerdict, 'PASSED');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('the act not-run reason is the TOOL’s, not the agent’s (#325, AC-19)', async () => {
    // The #311 gate wrote "this repo is a local TypeScript/Node project with no
    // CI-workflow simulation in scope" while `.github/workflows/` existed. The
    // true reason was precedence: plan targets outrank `act`. An agent's
    // explanation of its own omission is not evidence.
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets()
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          notRun: [
            {
              id: 'act',
              label: 'act',
              reason: 'this repo is a local TypeScript/Node project with no CI-workflow simulation in scope'
            }
          ]
        },
        1
      )
    );

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(
        summary.includes('plan targets took precedence'),
        `the tool must supply the act reason, got:\n${summary}`
      );
      assert.ok(
        !summary.includes('no CI-workflow simulation in scope'),
        `the agent's prose must never be published as evidence, got:\n${summary}`
      );
      const last = sm.history[sm.history.length - 1];
      assert.ok(
        JSON.stringify(last.metadata.gateNotRun).includes('plan targets took precedence'),
        'the checkpoint must record the same reason as the summary'
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('a not-run entry the tool cannot evidence passes through untouched (#325, AC-19)', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          notRun: [{ id: 'act', label: 'act', reason: 'the runtime is not installed' }, { id: 'e2e', label: 'e2e', reason: 'no fixtures' }]
        },
        1
      )
    );

    try {
      await runTransition(ws, STAGE_REVIEW, repo);
      const summary = fs.readFileSync(summaryPath, 'utf8');
      // No plan targets: the tool cannot claim precedence, so it does not
      // rewrite the reporter's text into a fact it has not measured.
      assert.ok(summary.includes('act (the runtime is not installed)'), summary);
      assert.ok(summary.includes('e2e (no fixtures)'), summary);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
  test('T-D2-3 (#408 D2): a PASSED report that skips a declared target is refused and writes nothing', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets()
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        { ...PASSED_REPORT.toJSON(), executedCommands: ['npm run lint'] },
        1
      )
    );
    const checkpointPathLocal = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const checkpointBefore = fs.readFileSync(checkpointPathLocal, 'utf8');
    const summaryBefore = fs.readFileSync(summaryPath, 'utf8');

    try {
      await assert.rejects(
        async () => runTransition(ws, STAGE_REVIEW, repo),
        (err: any) => {
          assert.match(String(err.message), /Missing 1 of 1 declared commands/);
          assert.match(String(err.message), /npm test/);
          assert.match(String(err.message), /NOT consumed/);
          return true;
        }
      );

      assert.strictEqual(fs.readFileSync(checkpointPathLocal, 'utf8'), checkpointBefore);
      assert.strictEqual(fs.readFileSync(summaryPath, 'utf8'), summaryBefore);
      assert.strictEqual(repo.clears, 0, 'a coverage refusal must not consume the report');
      assert.ok(repo.load(ISSUE) !== null, 'the report stays readable for a corrected refile');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z1 (#412): a PASSED zero-test report is refused on the certifying exit and consumes nothing', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets()
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED (0 passed)',
          testsPassed: 0,
          executedCommands: ['npm test']
        },
        1
      )
    );
    const checkpointPathLocal = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const checkpointBefore = fs.readFileSync(checkpointPathLocal, 'utf8');
    const summaryBefore = fs.readFileSync(summaryPath, 'utf8');

    try {
      await assert.rejects(
        async () => runTransition(ws, STAGE_REVIEW, repo),
        (err: any) => {
          assert.match(String(err.message), /npm test/);
          assert.match(String(err.message), /testsPassed/);
          return true;
        }
      );

      assert.strictEqual(fs.readFileSync(checkpointPathLocal, 'utf8'), checkpointBefore);
      assert.strictEqual(fs.readFileSync(summaryPath, 'utf8'), summaryBefore);
      assert.strictEqual(repo.clears, 0, 'a zero-test refusal must not consume the report');
      assert.ok(repo.load(ISSUE) !== null, 'the report stays readable for a corrected refile');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z2 (#412): the same zero-test report is not refused on the non-certifying exit', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets()
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED (0 passed)',
          testsPassed: 0,
          executedCommands: ['npm test']
        },
        1
      )
    );

    try {
      const sm = await runTransition(ws, STAGE_IMPLEMENT, repo);
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_IMPLEMENT);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z3 (#412): a build-only PASSED report with zero tests still certifies', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets(['npm run build'])
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED (0 passed)',
          testsPassed: 0,
          testsFailed: 0,
          executedCommands: ['npm run build']
        },
        1
      )
    );

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z4 (#412): a PASSED report with a positive test count certifies', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets(['npm test'])
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED (1 passed)',
          testsPassed: 1,
          executedCommands: ['npm test']
        },
        1
      )
    );

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z5 (#412): the #410 build-only commandResult cannot zero a real test total', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets(['npm run build', 'npm test'])
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED (1 passed)',
          testsPassed: 1,
          executedCommands: ['npm run build', 'npm test'],
          commandResults: [{ command: 'npm run build', passed: 0, failed: 0 }]
        },
        1
      )
    );

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
      assert.strictEqual(last.metadata.gateTests, 'PASSED (1 passed)');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z6 (#415): a PASSED null-count report is refused on the certifying exit and consumes nothing', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets()
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED',
          testsPassed: null,
          executedCommands: ['npm test']
        },
        1
      )
    );
    const checkpointPathLocal = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const checkpointBefore = fs.readFileSync(checkpointPathLocal, 'utf8');
    const summaryBefore = fs.readFileSync(summaryPath, 'utf8');

    try {
      await assert.rejects(
        async () => runTransition(ws, STAGE_REVIEW, repo),
        (err: any) => {
          assert.match(String(err.message), /npm test/);
          assert.match(String(err.message), /testsPassed/);
          assert.match(String(err.message), /TEST_METRICS/);
          return true;
        }
      );

      assert.strictEqual(fs.readFileSync(checkpointPathLocal, 'utf8'), checkpointBefore);
      assert.strictEqual(fs.readFileSync(summaryPath, 'utf8'), summaryBefore);
      assert.strictEqual(repo.clears, 0, 'an unmeasured refusal must not consume the report');
      assert.ok(repo.load(ISSUE) !== null, 'the report stays readable for a corrected refile');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z7 (#415): the same null-count report is not refused on the non-certifying exit', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets()
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED',
          testsPassed: null,
          executedCommands: ['npm test']
        },
        1
      )
    );

    try {
      const sm = await runTransition(ws, STAGE_IMPLEMENT, repo);
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_IMPLEMENT);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z8 (#415): a build-only PASSED report with a null count still certifies', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets(['npm run build'])
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED',
          testsPassed: null,
          executedCommands: ['npm run build']
        },
        1
      )
    );

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('T-Z9 (#415): a positive per-command breakdown measures a null aggregate', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(
      STAGE_QUALITY_GATE,
      [
        { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
        { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
      ],
      planWithTargets(['npm test'])
    );
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      GateResultReport.fromJSON(
        {
          ...PASSED_REPORT.toJSON(),
          testsStatus: 'PASSED (12 passed)',
          testsPassed: null,
          executedCommands: ['npm test'],
          commandResults: [{ command: 'npm test', passed: 12, failed: 0 }]
        },
        1
      )
    );

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
      assert.strictEqual(last.metadata.gateTests, 'PASSED (12 passed)');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('#338 T5: evidence then none — the second round clears the first round’s metrics', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();

    try {
      // Round 1: full evidence, certified exit to REVIEW.
      repo.reports.set(
        String(ISSUE),
        GateResultReport.fromJSON(
          {
            verdict: 'PASSED',
            buildSystem: 'node',
            buildStatus: 'PASSED',
            testsStatus: 'PASSED (3 passed)',
            testsPassed: 3,
            testsFailed: 0,
            durationMs: 69000,
            executedCommands: ['npm run lint', 'npm test'],
            smokeChecks: [{ id: 'check-1', label: 'app boots', passed: null }],
            smokeProtocol: 'PASSED',
            notRun: [{ id: 'e2e', label: 'e2e', reason: 'no fixtures' }],
            gateRound: 1
          },
          1
        )
      );
      await runTransition(ws, STAGE_REVIEW, repo);

      const first = fs.readFileSync(summaryPath, 'utf8');
      for (const line of [
        '- **Executed Commands:** `npm run lint`, `npm test`',
        '- **Smoke Checks:** check-1 ❔',
        '- **Smoke Protocol:** PASSED',
        '- **Not Run:** e2e (no fixtures)'
      ]) {
        assert.ok(first.includes(line), `round 1 is missing: ${line}\n${first}`);
      }
      // S3: the `❔` is resolvable because the protocol verdict is on screen.
      assert.ok(
        first.indexOf('Smoke Checks') < first.indexOf('Smoke Protocol'),
        'the protocol verdict must follow the per-check marks'
      );

      // Round 2: walk back to the gate and exit with NO evidence (the
      // non-certifying exit — REVIEW refuses an evidence-less certification).
      await runTransition(ws, STAGE_IMPLEMENT, repo);
      await runTransition(ws, STAGE_QUALITY_GATE, repo);
      await runTransition(ws, STAGE_IMPLEMENT, repo);

      const second = fs.readFileSync(summaryPath, 'utf8');
      // Issue #376: the second gate pass is its own labelled row, never an
      // overwrite of round 1.
      const gateRows = second
        .split('\n')
        .filter((line: string) => line.startsWith('| 5. Quality Gate'));
      assert.strictEqual(gateRows.length, 2, `both gate rounds must render, got:\n${second}`);
      const secondRoundRow = gateRows.find((line: string) => line.includes('(round 2)'));
      assert.ok(secondRoundRow, `the round-2 gate row must be labelled, got:\n${second}`);
      assert.match(
        secondRoundRow as string,
        /^\| 5\. Quality Gate \(round 2\) \| `gate` \| `flash_lite` \| NOT RECORDED \| (?:\d+m )?\d+s \|$/,
        `the round-2 row must be NOT RECORDED with one wall clock, got: ${secondRoundRow}`
      );
      const stale = second
        .split('\n')
        .filter(
          (line: string) =>
            line.startsWith('- **Build System:**') ||
            line.startsWith('- **Executed Commands:**') ||
            line.startsWith('- **Smoke Checks:**') ||
            line.startsWith('- **Smoke Protocol:**') ||
            line.startsWith('- **Not Run:**')
        );
      assert.deepStrictEqual(
        stale,
        [],
        `stale metrics survived a NOT RECORDED round: ${stale.join(' | ')}\n${second}`
      );
      assert.ok(second.includes('- **Build Status:** not recorded'), second);
      assert.ok(second.includes('- **Tests:** not recorded'), second);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  /** A real checkpoint repository whose COMMIT fails, exactly like an unwritable file. */
  class ThrowingSaveStateRepo {
    public saves = 0;
    private readonly inner: any;

    constructor(inner: any) {
      this.inner = inner;
    }

    async load() {
      return this.inner.load();
    }

    async save() {
      this.saves += 1;
      throw new Error('simulated checkpoint save fault');
    }

    async reset() {
      return this.inner.reset();
    }

    getStateFilePath() {
      return this.inner.getStateFilePath();
    }
  }

  test('T-D1-7 (#410): a throwing save leaves the filed report on disk, and the retry consumes it once', async () => {
    const now = Date.now();
    const { ws } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const checkpointPathLocal = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const before = fs.readFileSync(checkpointPathLocal, 'utf8');
    const round = resolveGateRound(JSON.parse(before).history);

    const inner = createStateRepository({ workspaceDir: ws, issue: ISSUE });
    const gateRepo = new FileGateReportRepository({ workspaceDir: ws, issue: ISSUE });
    const evidencePath = gateRepo.save(
      ISSUE,
      GateResultReport.fromJSON({ ...PASSED_REPORT.toJSON(), gateRound: round }, round)
    );
    const evidenceBytes = fs.readFileSync(evidencePath, 'utf8');

    const faulty = new ThrowingSaveStateRepo(inner);
    const useCase = new TransitionStageUseCase(
      faulty,
      undefined,
      undefined,
      new FilePlanGenerator(),
      gateRepo
    );
    await assert.rejects(
      async () =>
        useCase.execute({
          targetStage: STAGE_REVIEW,
          issue: ISSUE,
          workspaceDir: ws,
          noWorktree: true
        }),
      /simulated checkpoint save fault/
    );

    assert.strictEqual(faulty.saves, 1);
    assert.strictEqual(
      fs.readFileSync(checkpointPathLocal, 'utf8'),
      before,
      'the checkpoint is byte-identical'
    );
    assert.ok(fs.existsSync(evidencePath), 'the filed report must survive the failed save');
    assert.strictEqual(
      fs.readFileSync(evidencePath, 'utf8'),
      evidenceBytes,
      'the report is byte-identical'
    );
    assert.strictEqual(JSON.parse(before).currentStage, STAGE_QUALITY_GATE);

    // The retry runs on the real repository and certifies with that same block.
    const retry = new TransitionStageUseCase(
      inner,
      undefined,
      undefined,
      new FilePlanGenerator(),
      gateRepo
    );
    const sm = await retry.execute({
      targetStage: STAGE_REVIEW,
      issue: ISSUE,
      workspaceDir: ws,
      noWorktree: true
    });
    assert.strictEqual(sm.currentStage, STAGE_REVIEW);
    assert.strictEqual(sm.history[sm.history.length - 1].metadata.gateVerdict, 'PASSED');
    assert.ok(!fs.existsSync(evidencePath), 'the committed retry consumes the block exactly once');
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

/**
 * Issue #444: the ingest side must adjudicate the plan's declared smoke
 * protocol exactly as the filing side does. A PASSED block that declares
 * NOT_DECLARED, covers a subset or skips a declared check consumes nothing.
 */
describe('gate smoke protocol coverage on gate exit (issue #444)', () => {
  const FOUR_CHECK_PLAN = (() => {
    const blocks: string[] = [
      '# [Implementation] - Smoke',
      '',
      '- [ ] Step 1: probe',
      '',
      '### Manual Smoke Test Protocol',
      ''
    ];
    for (const n of [1, 2, 3, 4]) {
      blocks.push(`#### Check ${n} — check ${n}`, '', '```bash', `echo ok-${n}`, '```', '');
    }
    return blocks.join('\n');
  })();

  const checks = () =>
    [1, 2, 3, 4].map((n) => ({ id: `check-${n}`, label: `check ${n}`, passed: true }));

  function smokeReport(overrides: Record<string, unknown> = {}) {
    return GateResultReport.fromJSON(
      {
        verdict: 'PASSED',
        buildSystem: 'node',
        buildStatus: 'PASSED',
        testsStatus: 'PASSED (4 passed)',
        testsPassed: 4,
        testsFailed: 0,
        durationMs: 1000,
        executedCommands: ['npm test'],
        smokeProtocol: 'PASSED',
        smokeChecks: checks(),
        notRun: [],
        gateRound: 1,
        ...overrides
      },
      1
    );
  }

  const history = () => {
    const now = Date.now();
    return [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ];
  };

  test('SC-TR-1: a NOT_DECLARED zero-check PASSED report is refused on ingest and consumes nothing', async () => {
    const { ws } = scaffoldWorkspace(STAGE_QUALITY_GATE, history(), FOUR_CHECK_PLAN);
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      smokeReport({ smokeProtocol: 'NOT_DECLARED', smokeChecks: [] })
    );
    const checkpointPathLocal = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const checkpointBefore = fs.readFileSync(checkpointPathLocal, 'utf8');

    try {
      await assert.rejects(
        async () => runTransition(ws, STAGE_REVIEW, repo),
        (err: any) => {
          assert.strictEqual(err.field, 'smokeProtocol');
          assert.match(String(err.message), /Manual Smoke Test Protocol/);
          for (const n of [1, 2, 3, 4]) {
            assert.match(String(err.message), new RegExp(`check-${n}`));
          }
          return true;
        }
      );

      assert.strictEqual(repo.clears, 0);
      assert.strictEqual(fs.readFileSync(checkpointPathLocal, 'utf8'), checkpointBefore);
      assert.strictEqual(JSON.parse(checkpointBefore).currentStage, STAGE_QUALITY_GATE);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('SC-TR-2: a fully covering report certifies and records smokeProtocol', async () => {
    const { ws } = scaffoldWorkspace(STAGE_QUALITY_GATE, history(), FOUR_CHECK_PLAN);
    const repo = new FakeGateReportRepository();
    repo.reports.set(String(ISSUE), smokeReport());

    try {
      const sm = await runTransition(ws, STAGE_REVIEW, repo);
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
      assert.strictEqual(last.metadata.smokeProtocol, 'PASSED');
      assert.strictEqual(last.metadata.gateSmokeChecks.length, 4);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('SC-TR-3: a notRun entry for a declared check is refused on ingest', async () => {
    const { ws } = scaffoldWorkspace(STAGE_QUALITY_GATE, history(), FOUR_CHECK_PLAN);
    const repo = new FakeGateReportRepository();
    repo.reports.set(
      String(ISSUE),
      smokeReport({
        notRun: [{ id: 'check-3', label: 'check 3', reason: 'skipped in this run' }]
      })
    );

    try {
      await assert.rejects(
        async () => runTransition(ws, STAGE_REVIEW, repo),
        (err: any) => {
          assert.match(String(err.message), /check-3/);
          return true;
        }
      );
      assert.strictEqual(repo.clears, 0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

const { createStateRepository } = require('../helpers/state-repo.ts');
