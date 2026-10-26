/**
 * agyloop - CLI Next Action and Branch Info Presentation Tests
 *
 * Issue #250 (Scope A + Scope B):
 *
 *  - the commands used to DISAGREE about which checkpoint was authoritative —
 *    `status` read `tasks/999.json` while `next`, `transition`, `branch-info`
 *    and `halt` read and wrote the root;
 *  - `branch-info` used to WRITE the inferred issue back into the checkpoint,
 *    which made a read-only diagnostic mutate state;
 *  - four different parsers read the `--issue` token, so `999abc` meant four
 *    different things (999 / the root / the literal file `tasks/999abc.json` /
 *    silently ignored).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  parseArguments,
  runCli
} = require('../../dist/presentation');
const { NOTE_RESTARTED_FROM_COMPLETED } = require('../../dist/domain');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const EARLY = '2026-10-19T09:00:00.000Z';
const LATE = '2026-10-19T11:00:00.000Z';

/**
 * Runs `runCli` in a throwaway cwd with both console streams captured.
 *
 * `AGY_SUBAGENT` is cleared for the duration so the state-mutating commands are
 * not refused by the Zero Direct Root Mutation guard — the guard is not what
 * these tests are about, and leaving the environment to chance would make them
 * pass for the wrong reason.
 */
async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void,
  inspect?: (dir: string) => void
): Promise<{ code: number; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalSubagent = process.env.AGY_SUBAGENT;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-scope-'));
  let stdout = '';
  let stderr = '';

  try {
    if (seed) {
      seed(tempDir);
    }
    process.chdir(tempDir);
    delete process.env.AGY_SUBAGENT;
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    const code = await runCli(args);

    if (inspect) {
      inspect(tempDir);
    }

    return { code, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    if (originalSubagent === undefined) {
      delete process.env.AGY_SUBAGENT;
    } else {
      process.env.AGY_SUBAGENT = originalSubagent;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** The root checkpoint (`.agyloop/state.json`). */
function seedRoot(dir: string, overrides: Record<string, unknown> = {}): string {
  const stateDir = path.join(dir, '.agyloop');
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'INITIALIZED',
      mode: 'standard',
      issue: null,
      baseBranch: 'phase/6-codeloop',
      createdAt: EARLY,
      updatedAt: EARLY,
      history: [{ stage: 'INITIALIZED', timestamp: EARLY }],
      ...overrides
    })
  );
  return statePath;
}

/** A task checkpoint (`.agyloop/tasks/<issue>.json`). */
function seedTask(
  dir: string,
  issue: number,
  overrides: Record<string, unknown> = {}
): string {
  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${issue}.json`);
  fs.writeFileSync(
    taskPath,
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'REVIEW',
      mode: 'standard',
      issue,
      baseBranch: 'feature/task-base',
      createdAt: EARLY,
      updatedAt: LATE,
      history: [{ stage: 'REVIEW', timestamp: LATE }],
      ...overrides
    })
  );
  return taskPath;
}

/**
 * The mandated multi-checkpoint fixture (issue #250): a root checkpoint plus a
 * task checkpoint that is NEWER, so the task wins the scan.
 */
function seedMultiCheckpoint(dir: string): void {
  seedRoot(dir);
  // #282: the descriptor must point at a REAL directory, otherwise the truthful
  // staleness rule would (correctly) report it stale and null the path.
  fs.mkdirSync(path.join(dir, '.worktrees', '999'), { recursive: true });
  seedTask(dir, 999, {
    worktree: {
      taskId: '999',
      worktreePath: path.join(dir, '.worktrees', '999'),
      branch: 'task/999-from-checkpoint',
      baseBranch: 'feature/task-base',
      createdAt: EARLY
    }
  });
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function checkpointLine(stdout: string): string {
  const line = stdout.split('\n').find((l) => l.startsWith('Checkpoint'));
  return line === undefined ? '' : line.slice('Checkpoint'.length).trim();
}

describe('CLI Next & Branch-Info Subcommands', () => {
  describe('Argument Parsing', () => {
    test('parses next command with and without --json', () => {
      const parsed = parseArguments(['next']);
      assert.strictEqual(parsed.command, 'next');
      assert.strictEqual(parsed.options.json, false);

      const parsedJson = parseArguments(['next', '--json']);
      assert.strictEqual(parsedJson.command, 'next');
      assert.strictEqual(parsedJson.options.json, true);
    });

    test('parses branch-info command with and without --json', () => {
      const parsed = parseArguments(['branch-info']);
      assert.strictEqual(parsed.command, 'branch-info');
      assert.strictEqual(parsed.options.json, false);

      const parsedJson = parseArguments(['branch-info', '--json']);
      assert.strictEqual(parsedJson.command, 'branch-info');
      assert.strictEqual(parsedJson.options.json, true);
    });

    test('parses --keep-worktree flag', () => {
      const parsed = parseArguments(['commit', '--keep-worktree']);
      assert.strictEqual(parsed.command, 'commit');
      assert.strictEqual(parsed.options.keepWorktree, true);
    });
  });

  describe('runCli Dispatcher Execution', () => {
    test('runCli next outputs human readable action summary', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-test-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'INITIALIZED',
          mode: 'standard',
          issue: 41,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['next']);
        assert.strictEqual(exitCode, 0);
        assert.ok(output.includes('Next Subagent Directive'));
        assert.ok(output.includes('INITIALIZED'));
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli next --json outputs parseable JSON payload', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-json-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      // Issue #283: a canonical plan directory with the discovery artifact, so
      // the dispatch payload carries a concrete target path.
      const planDir = path.join(tempDir, 'artifacts', 'plans', '41-bug-probe');
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, '[Discovery] - probe.md'),
        '# [Discovery] - probe\n\n## 1. Problem Statement & Symptoms\n- **Observed Behavior:** probe\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'DISCOVERY',
          mode: 'standard',
          issue: 41,
          baseBranch: 'phase/1-bridge',
          planDir,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['next', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());
        assert.strictEqual(parsed.currentStage, 'DISCOVERY');
        assert.strictEqual(parsed.nextStage, 'PLAN');
        assert.strictEqual(parsed.actionType, 'subagent');
        assert.ok(parsed.invocationPayload);
        assert.strictEqual(parsed.invocationPayload.Subagents[0].TypeName, 'self');
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli branch-info outputs branch and PR routing table', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-branch-test-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      // A LIVE worktree (#282): the fixture must exist on disk or the truthful
      // staleness rule reports it as MISSING.
      const worktreeDir = path.join(tempDir, '.worktrees', '41');
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: 41,
          baseBranch: 'phase/1-bridge',
          worktree: {
            worktreePath: worktreeDir,
            branch: 'task/41-work',
            baseBranch: 'phase/1-bridge',
            createdAt: new Date().toISOString()
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['branch-info']);
        assert.strictEqual(exitCode, 0);
        assert.ok(output.includes('Branch Lifecycle & Target Diagnostics'));
        assert.ok(output.includes('phase/1-bridge'));
        assert.ok(output.includes('task/41-work'));
        assert.ok(output.includes(`Isolated Worktree     : ${worktreeDir}`));
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli branch-info --json outputs structured JSON', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-branch-json-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      const worktreeDir = path.join(tempDir, '.worktrees', '41');
      fs.mkdirSync(worktreeDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: 41,
          baseBranch: 'phase/1-bridge',
          worktree: {
            worktreePath: worktreeDir,
            branch: 'task/41-work',
            baseBranch: 'phase/1-bridge',
            createdAt: new Date().toISOString()
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['branch-info', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());
        assert.strictEqual(parsed.baseBranch, 'phase/1-bridge');
        assert.strictEqual(parsed.taskBranch, 'task/41-work');
        assert.strictEqual(parsed.worktreePath, worktreeDir);
        assert.strictEqual(parsed.worktreeStale, false);
        assert.strictEqual(parsed.staleWorktreePath, null);
        assert.strictEqual(parsed.prBaseTarget, 'phase/1-bridge');
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli next --issue 51 on a COMPLETED checkpoint is non-destructive', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-completed-'));
      // `next --issue <n>` resolves the TASK-scoped checkpoint
      // (.agyloop/tasks/<n>.json), so that is where the seed must live.
      const stateDir = path.join(tempDir, '.agyloop', 'tasks');
      fs.mkdirSync(stateDir, { recursive: true });
      const seed = {
        version: '1.0.0',
        currentStage: 'COMPLETED',
        mode: 'standard',
        issue: 40,
        milestoneTitle: 'Phase 6',
        baseBranch: 'phase/6',
        planDir: 'artifacts/plans/40-done',
        worktree: {
          taskId: '40',
          worktreePath: '/repo/.worktrees/40',
          branch: 'task/40-work',
          baseBranch: 'phase/6',
          createdAt: new Date().toISOString()
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [
          { stage: 'INITIALIZED', timestamp: new Date().toISOString() },
          { stage: 'DISCOVERY', timestamp: new Date().toISOString() },
          { stage: 'PLAN', timestamp: new Date().toISOString() },
          { stage: 'APPROVAL', timestamp: new Date().toISOString() },
          { stage: 'IMPLEMENT', timestamp: new Date().toISOString() },
          { stage: 'QUALITY_GATE', timestamp: new Date().toISOString() },
          { stage: 'REVIEW', timestamp: new Date().toISOString() },
          { stage: 'COMMIT', timestamp: new Date().toISOString() },
          { stage: 'COMPLETED', timestamp: new Date().toISOString() }
        ],
        totalHumanWaitMs: 123000,
        planRevisionCount: 2
      };
      const statePath = path.join(stateDir, '40.json');
      fs.writeFileSync(statePath, JSON.stringify(seed));

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['next', '--issue', '40', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());

        // Issue #237 (Defect 2): `next` is a query. The forbidden
        // { currentStage: "PLAN", planDir: null } snapshot is gone.
        assert.strictEqual(parsed.currentStage, 'COMPLETED');
        assert.strictEqual(parsed.actionType, 'completed');
        assert.match(parsed.humanSummary, /--restart/);

        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.strictEqual(persisted.currentStage, 'COMPLETED');
        assert.strictEqual(persisted.issue, 40);
        assert.strictEqual(persisted.planDir, seed.planDir);
        assert.deepStrictEqual(persisted.worktree, seed.worktree);
        assert.strictEqual(persisted.milestoneTitle, seed.milestoneTitle);
        assert.strictEqual(persisted.baseBranch, seed.baseBranch);
        assert.strictEqual(persisted.history.length, 9);
        assert.strictEqual(persisted.planRevisionCount, 2);
        assert.strictEqual(persisted.totalHumanWaitMs, 123000);
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli next --issue 51 --restart re-opens the COMPLETED checkpoint at DISCOVERY', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-restart-'));
      // Task-scoped checkpoint for the issue the operator is asking about.
      const stateDir = path.join(tempDir, '.agyloop', 'tasks');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'artifacts', 'plans', '51-done'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'artifacts', 'plans', '51-done', 'implementation-plan.md'),
        '# Approved Technical Plan for Issue 51'
      );
      const statePath = path.join(stateDir, '51.json');
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'COMPLETED',
          mode: 'standard',
          issue: 51,
          planDir: 'artifacts/plans/51-done',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: [{ stage: 'COMPLETED', timestamp: new Date().toISOString() }],
          planRevisionCount: 2
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['next', '--issue', '51', '--restart', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());

        assert.strictEqual(parsed.currentStage, 'DISCOVERY');
        assert.strictEqual(parsed.actionType, 'subagent');
        assert.strictEqual(parsed.role, 'discovery');

        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.strictEqual(persisted.currentStage, 'DISCOVERY');
        // A reset seeds INITIALIZED then the DISCOVERY hop: exactly two entries,
        // and never a PLAN entry.
        assert.strictEqual(persisted.history.length, 2);
        assert.ok(!persisted.history.some((h: any) => h.stage === 'PLAN'));
        assert.strictEqual(persisted.planDir, null);
        assert.strictEqual(persisted.history[1].metadata.note, NOTE_RESTARTED_FROM_COMPLETED);
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('runCli branch-info auto-infers issue when state.issue is null', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-branch-infer-'));
      const stateDir = path.join(tempDir, '.agyloop');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: null,
          worktree: {
            taskId: '51',
            worktreePath: path.join(tempDir, '.worktrees', '51'),
            branch: 'task/51-work',
            baseBranch: 'main',
            createdAt: new Date().toISOString()
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          history: []
        })
      );

      const prevCwd = process.cwd();
      let output = '';
      const originalLog = console.log;
      console.log = (msg) => {
        output += msg + '\n';
      };

      try {
        process.chdir(tempDir);
        const exitCode = await runCli(['branch-info', '--json']);
        assert.strictEqual(exitCode, 0);
        const parsed = JSON.parse(output.trim());
        assert.strictEqual(parsed.taskBranch, 'task/51-work');

        // Issue #250 (AC A4): `branch-info` is a DIAGNOSTIC and performs ZERO
        // checkpoint writes. The previous expectation — that `state.json` was
        // REWRITTEN with the inferred issue 51 — encoded the bug: a read-only
        // command mutated state (and the mutation was swallowed by the
        // isolation guard under /tmp, so the behaviour depended on the cwd).
        const rawState = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
        assert.strictEqual(rawState.issue, null, 'the checkpoint must be left untouched');
      } finally {
        process.chdir(prevCwd);
        console.log = originalLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * T-A1 / T-A4 — `branch-info` reports the TASK checkpoint and writes NOTHING.
 */
describe('branch-info reads the authoritative checkpoint and writes nothing (#250)', () => {
  test('T-A1: reports the task branch/base, not the root’s (AC A1)', async () => {
    const result = await runCliInSandbox(['branch-info', '--json'], seedMultiCheckpoint);

    assert.strictEqual(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.baseBranch, 'feature/task-base');
    assert.strictEqual(parsed.taskBranch, 'task/999-from-checkpoint');
    assert.ok(
      parsed.worktreePath.endsWith(path.join('.worktrees', '999')),
      `unexpected worktreePath: ${parsed.worktreePath}`
    );
    assert.ok(
      !result.stdout.includes('phase/6-codeloop'),
      `the root's collector branch must not be reported:\n${result.stdout}`
    );
  });

  test('T-A1: the JSON payload names the resolved checkpoint', async () => {
    const result = await runCliInSandbox(['branch-info', '--json'], seedMultiCheckpoint);

    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.checkpoint.endsWith(path.join('tasks', '999.json')),
      `unexpected checkpoint: ${parsed.checkpoint}`
    );
  });

  test('T-A4: both checkpoint files are byte-identical after branch-info (AC A4)', async () => {
    let rootBefore = '';
    let taskBefore = '';

    const result = await runCliInSandbox(
      ['branch-info', '--json'],
      (dir) => {
        seedMultiCheckpoint(dir);
        rootBefore = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
        taskBefore = fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '999.json'), 'utf8');
      },
      (dir) => {
        assert.ok(fs.existsSync(path.join(dir, '.agyloop', 'state.json')), 'the root must survive');
        assert.ok(fs.existsSync(path.join(dir, '.agyloop', 'tasks', '999.json')), 'the task must survive');
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8'),
          rootBefore,
          'branch-info must not rewrite the root checkpoint'
        );
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '999.json'), 'utf8'),
          taskBefore,
          'branch-info must not rewrite the task checkpoint'
        );
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
  });

  test('T-A4: a root carrying a worktree is still not rewritten', async () => {
    // The shape that made the root's md5 change: the root registers a
    // worktree, so the branch inference had a base branch to persist.
    let rootBefore = '';

    const result = await runCliInSandbox(
      ['branch-info', '--json'],
      (dir) => {
        seedRoot(dir, {
          worktree: {
            taskId: '42',
            worktreePath: path.join(dir, '.worktrees', '42'),
            branch: 'task/42-work',
            baseBranch: 'phase/6-codeloop',
            createdAt: EARLY
          }
        });
        rootBefore = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      },
      (dir) => {
        assert.ok(rootBefore.includes('"task/42-work"'), 'the fixture must be the worktree shape');
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8'),
          rootBefore,
          'branch-info must not rewrite a root that carries a worktree'
        );
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
  });
});

/**
 * T-A2 — `next` and `status` must never contradict each other.
 */
describe('next agrees with status about the authoritative checkpoint (#250)', () => {
  test('T-A2: both commands report the task checkpoint', async () => {
    const status = await runCliInSandbox(['status'], seedMultiCheckpoint);
    assert.strictEqual(status.code, 0, status.stderr);
    assert.ok(status.stdout.includes('[REVIEW]'), status.stdout);
    assert.ok(
      checkpointLine(status.stdout).endsWith(path.join('.agyloop', 'tasks', '999.json')),
      `unexpected checkpoint: ${checkpointLine(status.stdout)}`
    );

    const next = await runCliInSandbox(['next', '--json'], seedMultiCheckpoint);
    assert.strictEqual(next.code, 0, next.stderr);
    const parsed = JSON.parse(next.stdout);
    assert.strictEqual(parsed.currentStage, 'REVIEW', 'next must not report the root stage');
  });

  test('T-A2: both commands agree about the pause', async () => {
    const seed = (dir: string) => {
      seedRoot(dir);
      seedTask(dir, 999, { pausedAtGate: 'COMMIT', pausedAtTimestamp: EARLY });
    };

    const status = await runCliInSandbox(['status'], seed);
    assert.ok(status.stdout.includes('Paused At Gate: COMMIT'), status.stdout);

    const next = await runCliInSandbox(['next', '--json'], seed);
    const parsed = JSON.parse(next.stdout);
    assert.strictEqual(parsed.pause.gate, 'COMMIT');
    assert.strictEqual(parsed.actionable, false);
  });

  test('T-A2: next never writes the root checkpoint', async () => {
    let rootBefore = '';

    const result = await runCliInSandbox(
      ['next', '--json'],
      (dir) => {
        seedMultiCheckpoint(dir);
        rootBefore = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      },
      (dir) => {
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8'),
          rootBefore,
          'next must not write the root checkpoint'
        );
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
  });

  test('R7: the pause block reads the RESOLVED checkpoint, not the root', async () => {
    // `next` may itself write a TRIAGE pause (the COMPLETED → TRIAGE route).
    // The pause block therefore RE-READS the resolved checkpoint after the use
    // case ran. Reading the root instead would report "no pause" for a pause
    // that is sitting in `tasks/999.json`.
    const result = await runCliInSandbox(
      ['next', '--json'],
      (dir) => {
        seedRoot(dir);
        seedTask(dir, 999, { pausedAtGate: 'TRIAGE', pausedAtTimestamp: EARLY });
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.pause.gate, 'TRIAGE');
    assert.strictEqual(parsed.actionable, false);
  });
});

/**
 * T-A3 — `transition` acts on the authoritative checkpoint (stage AND mode).
 */
describe('transition acts on the authoritative checkpoint (#250)', () => {
  test('T-A3: the task checkpoint advances and the root is untouched', async () => {
    let rootBefore = '';

    const result = await runCliInSandbox(
      ['transition', 'APPROVAL'],
      (dir) => {
        seedRoot(dir);
        seedTask(dir, 999, { currentStage: 'PLAN' });
        rootBefore = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      },
      (dir) => {
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8'),
          rootBefore,
          'the root checkpoint must be byte-identical'
        );
      }
    );

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      !result.stderr.includes("Cannot transition from 'INITIALIZED'"),
      `transition must not act on the root stage:\n${result.stderr}`
    );
  });

  test('T-A3: the task checkpoint really advanced to APPROVAL', async () => {
    const result = await runCliInSandbox(
      ['transition', 'APPROVAL'],
      (dir) => {
        seedRoot(dir);
        seedTask(dir, 999, { currentStage: 'PLAN' });
      },
      (dir) => {
        const task = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        assert.strictEqual(task.currentStage, 'APPROVAL');
        assert.strictEqual(task.pausedAtGate, 'APPROVAL');
        const root = readJson(path.join(dir, '.agyloop', 'state.json'));
        assert.strictEqual(root.currentStage, 'INITIALIZED', 'the root must not advance');
      }
    );

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  });

  test('T-A3: the task checkpoint’s MODE is used, not the root’s', async () => {
    const result = await runCliInSandbox(
      ['transition', 'APPROVAL'],
      (dir) => {
        seedRoot(dir, { mode: 'standard' });
        seedTask(dir, 999, { currentStage: 'PLAN', mode: 'yolo' });
      }
    );

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      !result.stderr.includes("in mode 'standard'"),
      `the mode must come from the task checkpoint:\n${result.stderr}`
    );
  });
});

/**
 * T-B4 — `reset` reports honestly.
 */
describe('reset is honest about what it cleared (#250)', () => {
  test('T-B4: an existing task checkpoint is cleared and named', async () => {
    const result = await runCliInSandbox(
      ['reset', '--issue', '999'],
      seedMultiCheckpoint,
      (dir) => {
        assert.ok(
          !fs.existsSync(path.join(dir, '.agyloop', 'tasks', '999.json')),
          'the task checkpoint must be gone'
        );
        const root = readJson(path.join(dir, '.agyloop', 'state.json'));
        assert.strictEqual(root.currentStage, 'INITIALIZED', 'the root must be untouched');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('#999'), result.stdout);
    assert.ok(result.stdout.includes('999.json'), result.stdout);
    assert.ok(result.stdout.includes('✓'), result.stdout);
  });

  test('T-B4: a missing task checkpoint fails and claims nothing', async () => {
    const result = await runCliInSandbox(
      ['reset', '--issue', '999'],
      (dir) => {
        seedRoot(dir);
      },
      (dir) => {
        assert.ok(
          !fs.existsSync(path.join(dir, '.agyloop', 'tasks', '999.json')),
          'nothing may be created'
        );
        const root = readJson(path.join(dir, '.agyloop', 'state.json'));
        assert.strictEqual(root.currentStage, 'INITIALIZED');
      }
    );

    assert.strictEqual(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(!result.stdout.includes('✓'), `no success line may be printed:\n${result.stdout}`);
    assert.ok(/No checkpoint found/i.test(result.stderr), result.stderr);
    assert.ok(result.stderr.includes('999.json'), result.stderr);
  });

  test('T-B4: reset --all keeps purging the root and every task', async () => {
    const result = await runCliInSandbox(
      ['reset', '--all'],
      seedMultiCheckpoint,
      (dir) => {
        assert.ok(!fs.existsSync(path.join(dir, '.agyloop', 'state.json')));
        assert.ok(!fs.existsSync(path.join(dir, '.agyloop', 'tasks', '999.json')));
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('purged'), result.stdout);
  });
});

/**
 * T-B5 — the four resolutions of one token collapse to ONE: fail.
 */
describe('a garbage --issue token is rejected by every command (#250)', () => {
  const COMMANDS: ReadonlyArray<readonly string[]> = [
    ['status'],
    ['resume'],
    ['halt', '--reason', 'quota'],
    ['reset'],
    ['next'],
    ['transition', 'APPROVAL'],
    ['implement', '--dry-run', '--no-worktree'],
    ['branch-info']
  ];

  for (const command of COMMANDS) {
    test(`T-B5: \`${command.join(' ')} --issue 999abc\` exits 1 and touches nothing`, async () => {
      const label = command.join(' ');

      const result = await runCliInSandbox(
        [...command, '--issue', '999abc'],
        seedMultiCheckpoint,
        (dir) => {
          assert.ok(
            !fs.existsSync(path.join(dir, '.agyloop', 'tasks', '999abc.json')),
            'a garbage token must never create a checkpoint file'
          );
          const root = readJson(path.join(dir, '.agyloop', 'state.json'));
          assert.strictEqual(root.currentStage, 'INITIALIZED', 'the root must be untouched');
          assert.strictEqual(root.pausedAtGate, undefined, 'the root must not be paused');
          const task = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
          assert.strictEqual(task.currentStage, 'REVIEW', 'the task checkpoint must be untouched');
          assert.strictEqual(task.pausedAtGate, undefined, 'the task checkpoint must not be paused');
        }
      );

      assert.strictEqual(result.code, 1, `${label}: ${result.stdout}\n${result.stderr}`);
      assert.ok(
        result.stderr.includes('999abc'),
        `${label}: the stderr must name the offending token:\n${result.stderr}`
      );
      assert.ok(
        result.stderr.includes('Invalid --issue'),
        `${label}: the stderr must carry the canonical rejection:\n${result.stderr}`
      );
    });
  }

  test('T-B5: a VALID token still addresses tasks/999.json', async () => {
    const result = await runCliInSandbox(
      ['status', '--issue', '999'],
      seedMultiCheckpoint,
      (dir) => {
        const root = readJson(path.join(dir, '.agyloop', 'state.json'));
        assert.strictEqual(root.currentStage, 'INITIALIZED');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(
      checkpointLine(result.stdout).endsWith(path.join('.agyloop', 'tasks', '999.json')),
      `unexpected checkpoint: ${checkpointLine(result.stdout)}`
    );
  });
});

/**
 * Issue #282 — truthful worktree reporting.
 *
 * A LIVE descriptor keeps its path (guard against over-suppression); a STALE
 * one is reported as stale in both JSON and human output, and the read-only
 * commands never repair it.
 */
describe('worktree truth in read-only reporting (#282)', () => {
  let liveWorktreePath = '';

  function seedLiveWorktree(dir: string): void {
    liveWorktreePath = path.join(dir, '.worktrees', '77');
    fs.mkdirSync(liveWorktreePath, { recursive: true });
    seedRoot(dir);
    seedTask(dir, 77, {
      currentStage: 'IMPLEMENT',
      worktree: {
        taskId: '77',
        worktreePath: liveWorktreePath,
        branch: 'task/77-live',
        baseBranch: 'feature/task-base',
        createdAt: EARLY
      }
    });
  }

  test('T-P8a: next --json with a live worktree keeps worktreePath', async () => {
    const result = await runCliInSandbox(['next', '--issue', '77', '--json'], seedLiveWorktree);

    assert.strictEqual(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.worktreePath, liveWorktreePath);
    assert.strictEqual(parsed.worktreeStale, false);
    assert.strictEqual(parsed.staleWorktreePath, null);
    assert.strictEqual(result.stderr.includes('stale'), false, result.stderr);
  });

  test('T-P7: branch-info reports a stale descriptor as stale without writing (AC-9)', async () => {
    let taskBefore = '';
    let stalePath = '';

    const seed = (dir: string): void => {
      stalePath = path.join(dir, '.worktrees', '42');
      seedRoot(dir);
      seedTask(dir, 42, {
        currentStage: 'IMPLEMENT',
        worktree: {
          taskId: '42',
          worktreePath: stalePath,
          branch: 'task/42-stale',
          baseBranch: 'feature/task-base',
          createdAt: EARLY
        }
      });
      taskBefore = fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '42.json'), 'utf8');
    };

    const text = await runCliInSandbox(['branch-info', '--issue', '42'], seed);
    assert.strictEqual(text.code, 0, text.stderr);
    assert.ok(/MISSING|stale/i.test(text.stdout), text.stdout);
    assert.ok(
      text.stdout.includes('worktree remove 42 --prune-stale'),
      `the remediation must be executable: ${text.stdout}`
    );

    const json = await runCliInSandbox(
      ['branch-info', '--issue', '42', '--json'],
      seed,
      (dir) => {
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '42.json'), 'utf8'),
          taskBefore,
          'branch-info must not repair or rewrite the checkpoint'
        );
      }
    );
    assert.strictEqual(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.strictEqual(parsed.worktreePath, null);
    assert.strictEqual(parsed.worktreeStale, true);
    assert.ok(parsed.staleWorktreePath.endsWith(path.join('.worktrees', '42')));
  });

  test('T-P8: next reports a stale descriptor truthfully without writing (AC-9)', async () => {
    let taskBefore = '';

    const result = await runCliInSandbox(
      ['next', '--issue', '42', '--json'],
      (dir) => {
        seedRoot(dir);
        seedTask(dir, 42, {
          currentStage: 'IMPLEMENT',
          worktree: {
            taskId: '42',
            worktreePath: path.join(dir, '.worktrees', '42'),
            branch: 'task/42-stale',
            baseBranch: 'feature/task-base',
            createdAt: EARLY
          }
        });
        taskBefore = fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '42.json'), 'utf8');
      },
      (dir) => {
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '42.json'), 'utf8'),
          taskBefore,
          'next must not rewrite a stale descriptor'
        );
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.worktreePath, null);
    assert.strictEqual(parsed.worktreeStale, true);
    assert.ok(parsed.staleWorktreePath.endsWith(path.join('.worktrees', '42')));
    assert.ok(/stale/i.test(result.stderr), `expected a remediation warning, got: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('--prune-stale'),
      `the remediation must name the supported repair: ${result.stderr}`
    );
    // A dead path must not reach a subagent as if it were a usable Cwd.
    assert.strictEqual(
      String(parsed.humanSummary).includes(parsed.staleWorktreePath),
      false,
      `humanSummary must not embed the dead path: ${parsed.humanSummary}`
    );
    assert.strictEqual(
      JSON.stringify(parsed.invocationPayload ?? {}).includes(parsed.staleWorktreePath),
      false,
      'invocationPayload must not embed the dead path'
    );
  });
});
