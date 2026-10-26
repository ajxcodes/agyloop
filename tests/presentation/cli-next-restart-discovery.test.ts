/**
 * agyloop - `next --restart` / `--skip-discovery` e2e through runCli (issue #237)
 *
 * Pins the two new explicit-intent flags end to end, from `parseArguments`
 * through the CLI dispatcher into the persisted checkpoint.
 *
 * T7 / AC4: `--skip-discovery` is parsed, threaded `CliOptions ->
 *   RunLifecycleParams -> StartPlanningParams`, enforced by
 *   `resolveDiscoveryReentry`, and recorded in `history[].metadata`.
 * T8 / AC4 + AC8: e2e over a task-scoped COMPLETED checkpoint.
 *   Case A: plain `next` is a read — the persisted file is untouched.
 *   Case B: `--restart` is the ONLY destructive path, and it lands at
 *     DISCOVERY (never PLAN).
 *   Case C: `--skip-discovery` releases the DISCOVERY park, and the bypass is
 *     auditable in history.
 *
 * Harness: in-process `runCli` sandbox copied from cli-yolo-discovery.test.ts
 * (cwd under os.tmpdir() so FileStateRepository's smoke isolation proves the
 * temp state file).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli, parseArguments } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS } = require('../../dist/domain');
const { NOTE_RESTARTED_FROM_COMPLETED } = require('../../dist/domain');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/**
 * Runs runCli inside a throwaway cwd with captured console streams,
 * restoring cwd/env/console afterwards. `seed` runs after `chdir` so a fixture
 * can lay down a task-scoped checkpoint.
 */
async function runCliInSandbox(
  args: readonly string[],
  { env = {}, seed }: { env?: Record<string, string | undefined>; seed?: (dir: string) => void } = {}
): Promise<any> {
  const prevCwd = process.cwd();
  const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-next-restart-'));
  const originalEnv: any = {};
  for (const key of Object.keys(env)) {
    originalEnv[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(tempDir);
    if (seed) {
      seed(tempDir);
    }
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    let persistedRaw = '';
    try {
      persistedRaw = fs.readFileSync(taskStatePath(tempDir, 237), 'utf8');
    } catch {
      persistedRaw = '';
    }
    return {
      code,
      stdout: stdout.replace(ANSI_ESCAPE, ''),
      stderr: stderr.replace(ANSI_ESCAPE, ''),
      tempDir,
      persisted: persistedRaw ? JSON.parse(persistedRaw) : null,
      persistedRaw
    };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    for (const key of Object.keys(env)) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Task-scoped state file, which is what `next --issue <n>` resolves. */
function taskStatePath(dir: string, issue: number): string {
  return path.join(dir, '.agyloop', 'tasks', `${issue}.json`);
}

function readState(dir: string): any {
  try {
    return JSON.parse(fs.readFileSync(taskStatePath(dir, 237), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Seeds a COMPLETED checkpoint and remembers its exact bytes so the test can
 * assert the query path left the file byte-identical.
 */
function captureCompletedCheckpoint(): { before: { text: string }; seed: (dir: string) => void } {
  const before: { text: string } = { text: '' };
  return {
    before,
    seed: (dir: string) => {
      seedCompletedTask(dir);
      before.text = fs.readFileSync(taskStatePath(dir, 237), 'utf8');
    }
  };
}

/** A COMPLETED checkpoint carrying everything a destructive `reset()` would lose. */
function seedCompletedTask(dir: string): void {
  const now = new Date().toISOString();
  const stages = [
    'INITIALIZED',
    'DISCOVERY',
    'PLAN',
    'APPROVAL',
    'IMPLEMENT',
    'QUALITY_GATE',
    'REVIEW',
    'COMMIT',
    'COMPLETED'
  ];
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(
    taskStatePath(dir, 237),
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'COMPLETED',
      mode: 'standard',
      issue: 237,
      milestoneTitle: 'Phase 6',
      baseBranch: 'phase/6',
      planDir: 'artifacts/plans/237-done',
      worktree: null,
      triagePayload: null,
      createdAt: now,
      updatedAt: now,
      history: stages.map((stage) => ({ stage, timestamp: now })),
      totalHumanWaitMs: 123000,
      planRevisionCount: 2
    })
  );
}

/** A checkpoint parked at DISCOVERY (the #234 bug-issue park). */
function seedDiscoveryPark(dir: string): void {
  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts', 'plans', '237-bug-probe'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'artifacts', 'plans', '237-bug-probe', '[Discovery] - [bug] probe.md'),
    [
      '# [Discovery] - [bug] probe',
      '',
      '**Issue:** #237',
      '',
      '## 1. Problem Statement & Symptoms',
      '- **Observed Behavior:**'
    ].join('\n')
  );
  fs.writeFileSync(
    taskStatePath(dir, 237),
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'DISCOVERY',
      mode: 'yolo',
      issue: 237,
      planDir: 'artifacts/plans/237-bug-probe',
      createdAt: now,
      updatedAt: now,
      history: [
        { stage: 'INITIALIZED', timestamp: now },
        { stage: 'DISCOVERY', timestamp: now }
      ]
    })
  );
}

describe('codeloop next --restart / --skip-discovery (issue #237)', () => {
  describe('T7: --skip-discovery flag parsing (AC4)', () => {
    test('parses --skip-discovery, defaults false, and honours the = form', () => {
      assert.strictEqual(parseArguments(['yolo', '--issue', '237', '--skip-discovery']).options.skipDiscovery, true);
      assert.strictEqual(parseArguments(['yolo']).options.skipDiscovery, false);
      assert.strictEqual(parseArguments(['yolo', '--skip-discovery=false']).options.skipDiscovery, false);
      assert.strictEqual(parseArguments(['yolo', '--skip-discovery=true']).options.skipDiscovery, true);
      assert.strictEqual(parseArguments(['plan', '--issue', '237', '--skip-discovery']).command, 'plan');
    });

    test('--restart is next-scoped and defaults false', () => {
      assert.strictEqual(parseArguments(['next', '--issue', '237', '--restart']).options.restart, true);
      assert.strictEqual(parseArguments(['next']).options.restart, false);
      assert.strictEqual(parseArguments(['next', '--restart=false']).options.restart, false);
    });
  });

  describe('T8: end-to-end write contract', () => {
    test('Case A: next --issue <n> on COMPLETED is a pure read', async () => {
      const capture = captureCompletedCheckpoint();
      const result = await runCliInSandbox(['next', '--issue', '237', '--json'], {
        env: { AGY_SUBAGENT: undefined },
        seed: capture.seed
      });
      const parsed = JSON.parse(result.stdout.trim());

      assert.strictEqual(result.code, EXIT_CODE_SUCCESS);
      assert.strictEqual(parsed.currentStage, 'COMPLETED');
      assert.strictEqual(parsed.actionType, 'completed');
      assert.match(parsed.humanSummary, /--restart/);
      assert.strictEqual(
        result.persistedRaw,
        capture.before.text,
        'the persisted checkpoint must be byte-identical'
      );
    });

    test('Case B: --restart is the only destructive path and it lands at DISCOVERY', async () => {
      const result = await runCliInSandbox(['next', '--issue', '237', '--restart', '--json'], {
        env: { AGY_SUBAGENT: undefined },
        seed: seedCompletedTask
      });
      const parsed = JSON.parse(result.stdout.trim());

      assert.strictEqual(result.code, EXIT_CODE_SUCCESS);
      assert.strictEqual(parsed.currentStage, 'DISCOVERY');
      // Issue #283: a restart lands at DISCOVERY with NO plan directory, so
      // `next` names the command that scaffolds the canonical one instead of
      // dispatching a discovery subagent with an unspecified write target.
      assert.strictEqual(parsed.actionType, 'human_gate');
      assert.ok(parsed.humanSummary.includes('codeloop plan --issue 237'), parsed.humanSummary);

      const persisted = result.persisted;
      assert.ok(persisted, 'a restarted checkpoint must be persisted');
      assert.strictEqual(persisted.currentStage, 'DISCOVERY');
      assert.strictEqual(persisted.planDir, null);
      assert.strictEqual(persisted.history.length, 2);
      assert.ok(!persisted.history.some((h: any) => h.stage === 'PLAN'), 'no restart may land at PLAN');
      assert.strictEqual(persisted.history[1].metadata.note, NOTE_RESTARTED_FROM_COMPLETED);
    });

    test('Case C: --skip-discovery releases the DISCOVERY park and records the bypass', async () => {
      const result = await runCliInSandbox(['plan', '--issue', '237', '--skip-discovery'], {
        env: { AGY_SUBAGENT: undefined },
        seed: seedDiscoveryPark
      });

      assert.strictEqual(result.code, EXIT_CODE_SUCCESS, `stdout=${result.stdout} stderr=${result.stderr}`);

      const persisted = result.persisted;
      assert.ok(persisted, 'the plan run must be checkpointed');
      assert.strictEqual(persisted.currentStage, 'PLAN');
      // The re-entry branch issues exactly ONE transition (PLAN); the historical
      // DISCOVERY entry from the park is preserved, not duplicated.
      assert.strictEqual(persisted.history.length, 3);
      const planEntry = persisted.history[persisted.history.length - 1];
      assert.strictEqual(planEntry.stage, 'PLAN');
      // AC4: the bypassed RCA gate is auditable from `codeloop status`.
      assert.strictEqual(planEntry.metadata.skipDiscovery, true);
      assert.strictEqual(
        persisted.history.filter((h: any) => h.stage === 'PLAN').length,
        1,
        'no duplicate PLAN entry'
      );
    });
  });
});
