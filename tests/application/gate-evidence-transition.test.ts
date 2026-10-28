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
const { FileStateRepository, FilePlanGenerator } = require('../../dist/infrastructure');
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
  const stateRepo = new FileStateRepository({ workspaceDir: ws, issue: ISSUE });
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
 * The gate row's duration cell, split into the labelled clocks (issue #315,
 * AC-15/AC-18). A cell that does not name its clock fails here: the defect was
 * a self-timer posing as the stage's wall clock.
 */
function gateRowDuration(summary: string): {
  reported: string;
  wallSeconds: number | null;
} {
  const cell = (row(summary, '4. Quality Gate').split('|')[5] ?? '').trim();
  const match: RegExpExecArray | null =
    /^(.*?) \(gate-reported(?:; (?:(\d+)m )?(\d+)s wall)?\)$/.exec(cell);
  if (match === null) {
    throw new Error(`the gate row must label the clock it reports, got: ${cell}`);
  }
  const wallSeconds =
    match[2] === undefined && match[3] === undefined
      ? null
      : Number(match[2] ?? 0) * 60 + Number(match[3]);
  return { reported: match[1], wallSeconds };
}

/** A plan carrying ONE declared verification target (for the #325 cases). */
function planWithTargets(): string {
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
    'npm test',
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
      // Issue #315 (AC-15/AC-18): the gate's self-timer is labelled, and the
      // wall window is derived from the seeded history (entered 200 s ago).
      const clock = gateRowDuration(summary);
      assert.strictEqual(clock.reported, '3m 16s');
      assert.ok(
        clock.wallSeconds !== null && Math.abs(clock.wallSeconds - 200) <= 5,
        `the gate row must report the stage wall clock it measured, got: ${clock.wallSeconds}`
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
    const checkpointPath = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const checkpointBefore = fs.readFileSync(checkpointPath, 'utf8');
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
      assert.strictEqual(fs.readFileSync(checkpointPath, 'utf8'), checkpointBefore);
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
    const checkpointPath = path.join(ws, '.agyloop', 'tasks', `${ISSUE}.json`);
    const checkpointBefore = fs.readFileSync(checkpointPath, 'utf8');
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

      assert.strictEqual(fs.readFileSync(checkpointPath, 'utf8'), checkpointBefore);
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
        row(summary, '4. Quality Gate'),
        '| 4. Quality Gate | `gate` | `flash_lite` | NOT RECORDED | - |'
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
      // No QUALITY_GATE entry existed, so only the next entry's timestamp is
      // available: the self-timer is labelled, with no wall window claimed.
      const clock = gateRowDuration(summary);
      assert.strictEqual(clock.reported, '3m 16s');
      assert.strictEqual(
        clock.wallSeconds,
        null,
        'an unmeasurable wall window must not be invented'
      );
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
});
