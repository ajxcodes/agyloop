/**
 * agyloop - Transition durations come from measurement, not from transition
 * gaps (issue #284, AC5)
 *
 * Each case seeds a synthetic checkpoint, runs the REAL TransitionStageUseCase
 * against a REAL summary file copied from `templates/summary-log.md`, and
 * asserts the printed FILE LINE — the defect was in the text the operator
 * reads, so a state-only assertion would pass against the buggy code.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TransitionStageUseCase } = require('../../dist/application');
const { FileStateRepository, FilePlanGenerator } = require('../../dist/infrastructure');
const {
  StateMachine,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE
} = require('../../dist/domain');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ISSUE = 486;
const HUMAN_WAIT_50M = 3_038_481; // 50m 38s — the live #248 bank

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-transition-duration-'));
}

function scaffoldSummary(ws: string): string {
  const dir = path.join(ws, 'artifacts', 'plans', `${ISSUE}-smoke`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'implementation_plan.md'),
    '# [Implementation] - Smoke\n\n- [ ] Step 1: probe\n',
    'utf8'
  );
  const summaryPath = path.join(dir, 'CodeLoop Summary.md');
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', 'summary-log.md'), summaryPath);
  return summaryPath;
}

function seedCheckpoint(ws: string, snapshot: Record<string, unknown>): string {
  const tasksDir = path.join(ws, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const file = path.join(tasksDir, `${ISSUE}.json`);
  const now = Date.now();
  const base = {
    version: '1.0.0',
    mode: 'standard',
    issue: ISSUE,
    baseBranch: 'main',
    planDir: `artifacts/plans/${ISSUE}-smoke`,
    createdAt: iso(now - 900_000),
    updatedAt: iso(now),
    pausedAtGate: null,
    pausedAtTimestamp: null,
    totalHumanWaitMs: 0
  };
  fs.writeFileSync(file, JSON.stringify({ ...base, ...snapshot }, null, 2), 'utf8');
  return file;
}

async function runTransition(ws: string, targetStage: string): Promise<any> {
  const stateRepo = new FileStateRepository({ workspaceDir: ws, issue: ISSUE });
  const useCase = new TransitionStageUseCase(stateRepo, undefined, undefined, new FilePlanGenerator());
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

describe('transition durations (issue #284, AC5)', () => {
  test('leaving the APPROVAL gate never prints human idle time as Plan Review work', async () => {
    const ws = makeWorkspace();
    try {
      const summaryPath = scaffoldSummary(ws);
      const now = Date.now();
      seedCheckpoint(ws, {
        currentStage: STAGE_APPROVAL,
        history: [{ stage: STAGE_APPROVAL, timestamp: iso(now - 100_000) }],
        pausedAtGate: STAGE_APPROVAL,
        pausedAtTimestamp: iso(now - 80_000),
        totalHumanWaitMs: HUMAN_WAIT_50M
      });

      await runTransition(ws, STAGE_IMPLEMENT);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.strictEqual(
        row(summary, '2. Plan Review'),
        '| 2. Plan Review | Human Gate | - | COMPLETED | - |'
      );
      assert.ok(
        !summary.includes('50m 39s'),
        `the cumulative human wait must never be printed as work, got:\n${summary}`
      );
      assert.ok(
        !row(summary, '2. Plan Review').includes('50m'),
        `the Plan Review row must not carry the human wait, got:\n${summary}`
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('an hour of banked wait must not clamp a real Implementation window to 0s', async () => {
    const ws = makeWorkspace();
    try {
      const summaryPath = scaffoldSummary(ws);
      const now = Date.now();
      seedCheckpoint(ws, {
        currentStage: STAGE_IMPLEMENT,
        createdAt: iso(now - 3_600_000),
        history: [
          { stage: STAGE_APPROVAL, timestamp: iso(now - 160_000) },
          { stage: STAGE_IMPLEMENT, timestamp: iso(now - 60_000) }
        ],
        totalHumanWaitMs: HUMAN_WAIT_50M
      });

      await runTransition(ws, STAGE_QUALITY_GATE);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.strictEqual(
        row(summary, '3. Implementation'),
        '| 3. Implementation | `implementer` | `inherit` | COMPLETED | 1m 0s |'
      );
      assert.ok(
        !summary.includes('50m 38s'),
        `the cumulative bank must not leak into a row, got:\n${summary}`
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('a pause TIMESTAMP without a gate name still subtracts the consumed wait', async () => {
    const ws = makeWorkspace();
    try {
      const summaryPath = scaffoldSummary(ws);
      const now = Date.now();
      seedCheckpoint(ws, {
        currentStage: STAGE_IMPLEMENT,
        createdAt: iso(now - 3_600_000),
        history: [
          { stage: STAGE_APPROVAL, timestamp: iso(now - 160_000) },
          { stage: STAGE_IMPLEMENT, timestamp: iso(now - 60_000) }
        ],
        // The second pause shape: a timestamp with no gate name.
        pausedAtGate: null,
        pausedAtTimestamp: iso(now - 20_000),
        totalHumanWaitMs: 0
      });

      await runTransition(ws, STAGE_QUALITY_GATE);

      const summary = fs.readFileSync(summaryPath, 'utf8');
      // 60s window − 20s wait consumed by this transition.
      assert.strictEqual(
        row(summary, '3. Implementation'),
        '| 3. Implementation | `implementer` | `inherit` | COMPLETED | 40s |'
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('no printed duration exceeds the run’s active execution duration', async () => {
    const ws = makeWorkspace();
    try {
      const summaryPath = scaffoldSummary(ws);
      const now = Date.now();
      seedCheckpoint(ws, {
        currentStage: STAGE_IMPLEMENT,
        createdAt: iso(now - 3_600_000),
        history: [
          { stage: STAGE_APPROVAL, timestamp: iso(now - 160_000) },
          { stage: STAGE_IMPLEMENT, timestamp: iso(now - 60_000) }
        ],
        totalHumanWaitMs: HUMAN_WAIT_50M
      });

      const sm = await runTransition(ws, STAGE_QUALITY_GATE);
      const activeMs = StateMachine.fromSnapshot(sm.toSnapshot()).activeExecutionDurationMs();

      const summary = fs.readFileSync(summaryPath, 'utf8');
      const durations = [...summary.matchAll(/\|\s*(\d+)m\s+(\d+)s\s*\|/g)].map(
        (m) => Number(m[1]) * 60_000 + Number(m[2]) * 1000
      );
      assert.ok(durations.length > 0, `expected at least one printed duration, got:\n${summary}`);
      for (const duration of durations) {
        assert.ok(
          duration <= activeMs,
          `a printed duration (${duration}ms) must not exceed the active run (${activeMs}ms):\n${summary}`
        );
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
