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

function scaffoldWorkspace(currentStage: string, history: Array<Record<string, unknown>>) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-gate-evidence-'));
  const dir = path.join(ws, 'artifacts', 'plans', `${ISSUE}-smoke`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'implementation_plan.md'),
    '# [Implementation] - Smoke\n\n- [ ] Step 1: probe\n',
    'utf8'
  );
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
      assert.strictEqual(
        row(summary, '4. Quality Gate'),
        '| 4. Quality Gate | `gate` | `flash_lite` | COMPLETED | 3m 16s |'
      );
      assert.ok(!summary.includes('Build Status:** PENDING'), `PENDING must never survive, got:\n${summary}`);

      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
      assert.strictEqual(last.metadata.gateVerdict, 'PASSED');
      assert.strictEqual(last.metadata.gateTests, 'PASSED (1408 passed)');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('a gate with NO filed evidence says "not recorded" and warns once', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 200_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();

    try {
      await runTransition(ws, STAGE_REVIEW, repo);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(
        summary.includes('- **Build Status:** not recorded'),
        `an unrecorded gate must say so, got:\n${summary}`
      );
      assert.ok(
        summary.includes('- **Tests:** not recorded'),
        `an unrecorded gate must say so, got:\n${summary}`
      );
      assert.strictEqual(
        row(summary, '4. Quality Gate'),
        '| 4. Quality Gate | `gate` | `flash_lite` | NOT RECORDED | - |'
      );
      assert.ok(
        !summary.includes('Build Status:** PENDING'),
        `PENDING must never survive, got:\n${summary}`
      );
      assert.strictEqual(warnings.length, 1, `exactly one warning expected, got: ${warnings.join(' | ')}`);
      assert.ok(
        warnings[0].includes('codeloop gate-report'),
        `the warning must name the filing command, got: ${warnings[0]}`
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('a report from a DIFFERENT round is not applied', async () => {
    const now = Date.now();
    const { ws, summaryPath } = scaffoldWorkspace(STAGE_QUALITY_GATE, [
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 400_000).toISOString() },
      { stage: STAGE_IMPLEMENT, timestamp: new Date(now - 300_000).toISOString() },
      { stage: STAGE_QUALITY_GATE, timestamp: new Date(now - 200_000).toISOString() }
    ]);
    const repo = new FakeGateReportRepository();
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
      await runTransition(ws, STAGE_REVIEW, repo);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.strictEqual(
        row(summary, '4. Quality Gate'),
        '| 4. Quality Gate | `gate` | `flash_lite` | NOT RECORDED | - |'
      );
      assert.ok(
        !summary.includes('9999 passed'),
        `a stale report must not certify this round, got:\n${summary}`
      );
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
      assert.strictEqual(
        row(summary, '4. Quality Gate'),
        '| 4. Quality Gate | `gate` | `flash_lite` | COMPLETED | 3m 16s |'
      );
      const last = sm.history[sm.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
      assert.strictEqual(last.metadata.gateVerdict, 'PASSED');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
