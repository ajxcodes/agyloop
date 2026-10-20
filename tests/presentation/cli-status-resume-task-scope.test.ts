/**
 * agyloop - `status` and `resume` must name — and act on — the checkpoint that holds the work (#226 D5/D6)
 *
 * A task run's checkpoint is `.agyloop/tasks/<issue>.json`. The root
 * `.agyloop/state.json` is the singleton for ad-hoc runs. `status` and `resume`
 * used to call `stateRepo.load()` unconditionally, which with no `--issue` and no
 * worktree hint in the cwd resolves to the ROOT file. So on a workspace whose only
 * checkpoint was `tasks/999.json`:
 *
 *   - `status` advertised `Checkpoint: …/.agyloop/state.json` and synthesised a
 *     `[INITIALIZED]` header that contradicted the task matrix below it;
 *   - a bare `codeloop resume` reported "nothing to resume" and wrote nothing,
 *     while `tasks/999.json` sat paused at `COMMIT` with no reachable exit.
 *
 * Both now go through the ONE shared resolver (`resolve-task-checkpoint.ts`), and
 * `resume` uses the resolved repository for the WRITE as well as the read — reading
 * the right file and saving to the root would be the same bug in a new shape. The
 * `!fs.existsSync(<tempDir>/.agyloop/state.json)` assertions below are the ones
 * that prove the write went to the task file and not the root.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const EARLY = '2026-10-14T09:00:00.000Z';
const LATE = '2026-10-14T11:00:00.000Z';
/** Far enough in the past that `totalHumanWaitMs` is unambiguously > 0. */
const LONG_AGO = '2026-10-14T06:00:00.000Z';

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** A task checkpoint exactly as `RunLifecycleUseCase` persists it. */
function taskSnapshot(options: {
  readonly issue: number;
  readonly stage: string;
  readonly updatedAt: string;
  readonly pausedAtGate?: string;
  readonly pausedAtTimestamp?: string;
}): Record<string, unknown> {
  return {
    version: '1.0.0',
    currentStage: options.stage,
    mode: 'standard',
    issue: options.issue,
    baseBranch: 'phase/6-codeloop',
    createdAt: EARLY,
    updatedAt: options.updatedAt,
    history: [{ stage: options.stage, timestamp: options.updatedAt }],
    ...(options.pausedAtGate
      ? { pausedAtGate: options.pausedAtGate, pausedAtTimestamp: options.pausedAtTimestamp ?? LONG_AGO }
      : {})
  };
}

function seedTask(dir: string, options: {
  readonly issue: number;
  readonly stage: string;
  readonly updatedAt: string;
  readonly pausedAtGate?: string;
  readonly pausedAtTimestamp?: string;
}): string {
  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${options.issue}.json`);
  fs.writeFileSync(taskPath, JSON.stringify(taskSnapshot(options)));
  return taskPath;
}

function seedRoot(dir: string, options: {
  readonly stage: string;
  readonly updatedAt: string;
  readonly issue?: number | null;
  readonly pausedAtGate?: string;
}): string {
  const stateDir = path.join(dir, '.agyloop');
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: '1.0.0',
      currentStage: options.stage,
      mode: 'standard',
      issue: options.issue ?? null,
      createdAt: EARLY,
      updatedAt: options.updatedAt,
      history: [{ stage: options.stage, timestamp: options.updatedAt }],
      ...(options.pausedAtGate ? { pausedAtGate: options.pausedAtGate, pausedAtTimestamp: LONG_AGO } : {})
    })
  );
  return statePath;
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The value printed on the `Checkpoint` line of `codeloop status`. */
function checkpointLine(stdout: string): string {
  const line = stdout.split('\n').find((l) => l.startsWith('Checkpoint'));
  return line === undefined ? '' : line.slice('Checkpoint'.length).trim();
}

/**
 * Runs `runCli` in a throwaway cwd with both console streams captured, restoring
 * everything (cwd, TTY flags, console) in `finally`. Recipe copied verbatim from
 * `tests/presentation/cli-gate-pause-visibility.test.ts`; `inspect` runs while the
 * sandbox still exists so on-disk assertions belong in there.
 *
 * `cwdSubdir` moves the cwd INSIDE the sandbox (the sandbox root stays the
 * workspace root for `inspect`): a directory whose path looks like a task
 * worktree (`.worktrees/<n>`) makes `FileStateRepository` infer the issue from
 * the cwd, which is how the CLI's own checkpoint becomes `tasks/<n>.json`.
 */
async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void,
  inspect?: (dir: string) => void,
  cwdSubdir?: string
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-task-scope-'));
  let stdout = '';
  let stderr = '';

  try {
    if (seed) {
      seed(tempDir);
    }
    process.chdir(cwdSubdir === undefined ? tempDir : path.join(tempDir, cwdSubdir));
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    const code = await Promise.race([
      runCli(args),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`HANG: runCli(${JSON.stringify(args)}) never settled.`)),
          20000
        );
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      })
    ]);

    if (inspect) {
      inspect(tempDir);
    }

    return { code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('codeloop status resolves the authoritative checkpoint (#226 D5)', () => {
  test('advertises the task checkpoint, not the root (headline AC)', async () => {
    let rootStatePath = '';

    const result = await runCliInSandbox(
      ['status'],
      (dir) => {
        seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
      },
      (dir) => {
        rootStatePath = path.join(dir, '.agyloop', 'state.json');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(
      checkpointLine(result.stdout).endsWith(path.join('.agyloop', 'tasks', '999.json')),
      `expected the task checkpoint path, got: ${checkpointLine(result.stdout)}`
    );
    assert.ok(
      !result.stdout.includes(rootStatePath),
      `status must not advertise the root checkpoint, got:\n${result.stdout}`
    );
  });

  test('no longer synthesises a header that contradicts the task matrix', async () => {
    const result = await runCliInSandbox(['status'], (dir) => {
      seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
    });

    const stageLine = result.stdout.split('\n').find((l) => l.startsWith('Current Stage')) ?? '';
    assert.ok(stageLine.includes('[COMMIT]'), `header must read [COMMIT], got: ${stageLine}`);
    assert.ok(!result.stdout.includes('[INITIALIZED]'), result.stdout);
    assert.ok(result.stdout.includes('Active Issue  : #999'), result.stdout);
  });

  test('status and the Active Tasks matrix agree', async () => {
    const result = await runCliInSandbox(['status'], (dir) => {
      seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
    });

    const matrixRow = result.stdout.split('\n').find((l) => l.trim().startsWith('#999')) ?? '';
    assert.ok(matrixRow.includes('[COMMIT]'), `matrix row disagrees with the header: ${matrixRow}`);
  });

  test('the pause block is read from the checkpoint the header names', async () => {
    // This is the D5/D6 coupling: `readPersistedGatePause` used to re-load the
    // UNSCOPED repository, so the pause block could describe a different file than
    // the header did.
    const result = await runCliInSandbox(['status'], (dir) => {
      seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
    });

    assert.ok(result.stdout.includes('Paused At Gate: COMMIT'), result.stdout);
  });

  test('a root-only repository still reports the root checkpoint (no regression)', async () => {
    const result = await runCliInSandbox(['status'], (dir) => {
      seedRoot(dir, { stage: 'IMPLEMENT', updatedAt: LATE, issue: 99, pausedAtGate: 'CIRCUIT_BREAKER' });
    });

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join('.agyloop', 'state.json')), result.stdout);
    assert.ok(
      !result.stdout.includes('authoritative for issue'),
      'a root checkpoint must not be labelled as a task checkpoint'
    );
  });

  test('a COMPLETED task does not outrank an in-flight one', async () => {
    const result = await runCliInSandbox(['status'], (dir) => {
      seedTask(dir, { issue: 999, stage: 'COMPLETED', updatedAt: LATE });
      seedTask(dir, { issue: 1000, stage: 'IMPLEMENT', updatedAt: EARLY });
    });

    assert.ok(
      checkpointLine(result.stdout).endsWith(path.join('.agyloop', 'tasks', '1000.json')),
      result.stdout
    );
  });

  test('two in-flight tasks resolve to the newest, deterministically', async () => {
    const result = await runCliInSandbox(['status'], (dir) => {
      seedTask(dir, { issue: 999, stage: 'IMPLEMENT', updatedAt: EARLY });
      seedTask(dir, { issue: 1000, stage: 'REVIEW', updatedAt: LATE });
    });

    assert.ok(
      checkpointLine(result.stdout).endsWith(path.join('.agyloop', 'tasks', '1000.json')),
      result.stdout
    );
  });
});

describe('codeloop resume resolves the authoritative checkpoint (#226 D6)', () => {
  test('a bare resume clears the task checkpoint and never creates the root file (headline AC)', async () => {
    const result = await runCliInSandbox(
      ['resume'],
      (dir) => {
        seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
      },
      (dir) => {
        const persisted = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));

        assert.strictEqual(persisted.pausedAtGate, null, 'the persisted shape must have no pause');
        assert.strictEqual(persisted.pausedAtTimestamp, null);
        assert.strictEqual(persisted.currentStage, 'COMMIT', 'resume never advances the stage');
        assert.ok(
          !fs.existsSync(path.join(dir, '.agyloop', 'state.json')),
          'the cleared pause must NOT have been written back to the root file'
        );
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(!/nothing to resume/i.test(result.stdout), `resume must not report nothing to do:\n${result.stdout}`);
  });

  test('a bare resume banks the elapsed human wait', async () => {
    const result = await runCliInSandbox(
      ['resume'],
      (dir) => {
        seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
      },
      (dir) => {
        const persisted = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        assert.ok(persisted.totalHumanWaitMs > 0, `expected a banked wait, got ${persisted.totalHumanWaitMs}`);
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
  });

  test('the report names the task it inspected', async () => {
    const result = await runCliInSandbox(['resume'], (dir) => {
      seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
    });

    assert.ok(/Task\s+: #999/.test(result.stdout), result.stdout);
  });

  test('`resume --issue 999` still works (no regression)', async () => {
    const result = await runCliInSandbox(
      ['resume', '--issue', '999'],
      (dir) => {
        seedRoot(dir, { stage: 'IMPLEMENT', updatedAt: LATE, pausedAtGate: 'CIRCUIT_BREAKER' });
        seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
      },
      (dir) => {
        const task = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        const root = readJson(path.join(dir, '.agyloop', 'state.json'));

        assert.strictEqual(task.pausedAtGate, null);
        assert.strictEqual(
          root.pausedAtGate,
          'CIRCUIT_BREAKER',
          'an explicit --issue must leave an unrelated checkpoint untouched'
        );
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
  });

  test('`resume --dry-run` writes nothing', async () => {
    const result = await runCliInSandbox(
      ['resume', '--dry-run'],
      (dir) => {
        seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
      },
      (dir) => {
        const persisted = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        assert.strictEqual(persisted.pausedAtGate, 'COMMIT', 'a dry run must leave the pause in place');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('[dry-run]'), result.stdout);
  });

  test('a no-op resume names the OTHER task that is actually paused', async () => {
    // #999 is the newest in-flight checkpoint and holds no pause; #1000, older,
    // is the one waiting on a human. Without the note the run reads as
    // "nothing to resume" and the operator never learns #1000 exists.
    const result = await runCliInSandbox(['resume'], (dir) => {
      seedTask(dir, { issue: 999, stage: 'IMPLEMENT', updatedAt: LATE });
      seedTask(dir, { issue: 1000, stage: 'COMMIT', updatedAt: EARLY, pausedAtGate: 'COMMIT' });
    });

    assert.ok(/nothing to resume/i.test(result.stdout), result.stdout);
    assert.ok(result.stdout.includes('codeloop resume --issue 1000'), result.stdout);
  });

  test('a completed task never outranks the paused one', async () => {
    const result = await runCliInSandbox(
      ['resume'],
      (dir) => {
        seedTask(dir, { issue: 999, stage: 'COMPLETED', updatedAt: LATE });
        seedTask(dir, { issue: 1000, stage: 'COMMIT', updatedAt: EARLY, pausedAtGate: 'COMMIT' });
      },
      (dir) => {
        const task999 = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        const task1000 = readJson(path.join(dir, '.agyloop', 'tasks', '1000.json'));

        assert.strictEqual(task1000.pausedAtGate, null, 'the paused task is the one that must be cleared');
        assert.ok(!task999.pausedAtGate, 'a COMPLETED task must not have been chosen or rewritten');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
  });

  test('a root-only paused repository is cleared by a bare resume (no regression)', async () => {
    const result = await runCliInSandbox(
      ['resume'],
      (dir) => {
        seedRoot(dir, { stage: 'IMPLEMENT', updatedAt: LATE, issue: 99, pausedAtGate: 'CIRCUIT_BREAKER' });
      },
      (dir) => {
        const persisted = readJson(path.join(dir, '.agyloop', 'state.json'));
        assert.strictEqual(persisted.pausedAtGate, null);
        assert.strictEqual(persisted.currentStage, 'IMPLEMENT');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
  });
});

/**
 * #226 regression: a checkpoint file that exists but does not parse throws
 * (`StateStorageError`) instead of returning null — saves use a plain
 * `writeFileSync`, so a crash mid-write produces exactly this. One such file
 * must not take down `status`, and never take down `resume`: the recovery
 * command an operator reaches for when things are already broken.
 */
describe('one corrupt checkpoint file does not defeat status or resume (#226 regression)', () => {
  /** Seeds a truncated (crash-mid-write) task file: JSON prefix, no usable snapshot. */
  function seedCorruptTask(dir: string, issue: number): string {
    const tasksDir = path.join(dir, '.agyloop', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const taskPath = path.join(tasksDir, `${issue}.json`);
    fs.writeFileSync(taskPath, '{"currentStage":');
    return taskPath;
  }

  test('status still resolves the good task next to a corrupt one', async () => {
    const result = await runCliInSandbox(['status'], (dir) => {
      seedCorruptTask(dir, 888);
      seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
    });

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(
      checkpointLine(result.stdout).endsWith(path.join('.agyloop', 'tasks', '999.json')),
      `expected the good task checkpoint, got: ${checkpointLine(result.stdout)}`
    );
    assert.ok(result.stdout.includes('Active Issue  : #999'), result.stdout);
  });

  test('a bare resume still exits 0 and clears the good task', async () => {
    const result = await runCliInSandbox(
      ['resume'],
      (dir) => {
        seedCorruptTask(dir, 888);
        seedTask(dir, { issue: 999, stage: 'COMMIT', updatedAt: LATE, pausedAtGate: 'COMMIT' });
      },
      (dir) => {
        const cleared = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        assert.strictEqual(cleared.pausedAtGate, null, 'the good task must still be resumed');
        assert.ok(
          !fs.existsSync(path.join(dir, '.agyloop', 'state.json')),
          'resume must not write the root file for a task checkpoint'
        );
        const corrupt = fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '888.json'), 'utf8');
        assert.strictEqual(corrupt, '{"currentStage":', 'the corrupt neighbour must be left untouched');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(!/nothing to resume/i.test(result.stdout), result.stdout);
    assert.ok(/Task\s+: #999/.test(result.stdout), result.stdout);
  });

  test('a root checkpoint that exists but does not parse is reported, not lied about', async () => {
    // Deliberate contract for `resume`'s re-load: catch-and-report. A crasher is
    // the worst behaviour for a recovery command, but the file EXISTS — reporting
    // "No pipeline checkpoint found" would be a false statement about reality,
    // and nothing may be persisted for a checkpoint that cannot be read.
    const result = await runCliInSandbox(
      ['resume'],
      (dir) => {
        fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.agyloop', 'state.json'), '{"currentStage":');
      },
      (dir) => {
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8'),
          '{"currentStage":',
          'resume must not persist anything when it cannot read the checkpoint'
        );
      }
    );

    assert.strictEqual(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      result.stderr.includes(path.join('.agyloop', 'state.json')),
      `the report must name the unreadable file, got: ${result.stderr}`
    );
    assert.ok(
      !/no pipeline checkpoint found/i.test(result.stdout + result.stderr),
      `must not claim the checkpoint is absent:\n${result.stdout}\n${result.stderr}`
    );
  });
});

/**
 * #250 (AC B3): ONE token, ONE checkpoint — every command must agree.
 *
 * `status` and `resume` were the only two commands that went through the shared
 * resolver (#226). `next`, `transition`, `branch-info`, `halt`, `reset` and
 * `implement` each answered "which checkpoint?" for themselves, so a workspace
 * whose work lived in `tasks/999.json` was reported by `status` and MUTATED by
 * the rest — in the root.
 *
 * The mandated fixture: a root checkpoint at INITIALIZED plus a task checkpoint
 * at REVIEW that is NEWER (so it wins the scan).
 */
describe('every command resolves one token to one checkpoint (#250)', () => {
  /** The mandated multi-checkpoint fixture. */
  function seedScopeFixture(dir: string): void {
    seedRoot(dir, { stage: 'INITIALIZED', updatedAt: EARLY });
    seedTask(dir, { issue: 999, stage: 'REVIEW', updatedAt: LATE });
  }

  /**
   * `runCliInSandbox` with `AGY_SUBAGENT` cleared: the state-mutating commands
   * are refused by the Zero Direct Root Mutation guard when that variable is
   * set, and these tests are about scope, not about the guard.
   */
  async function runScoped(
    args: readonly string[],
    seed?: (dir: string) => void,
    inspect?: (dir: string) => void,
    cwdSubdir?: string
  ): Promise<CaptureResult> {
    const prevSubagent = process.env.AGY_SUBAGENT;
    delete process.env.AGY_SUBAGENT;
    try {
      return await runCliInSandbox(args, seed, inspect, cwdSubdir);
    } finally {
      if (prevSubagent === undefined) {
        delete process.env.AGY_SUBAGENT;
      } else {
        process.env.AGY_SUBAGENT = prevSubagent;
      }
    }
  }

  test('status advertises the task checkpoint', async () => {
    const result = await runScoped(['status'], seedScopeFixture);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(
      checkpointLine(result.stdout).endsWith(path.join('.agyloop', 'tasks', '999.json')),
      `unexpected checkpoint: ${checkpointLine(result.stdout)}`
    );
  });

  test('next reports the task checkpoint’s stage', async () => {
    const result = await runScoped(['next', '--json'], seedScopeFixture);

    assert.strictEqual(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.currentStage, 'REVIEW');
  });

  test('transition mutates the task checkpoint, not the root', async () => {
    const result = await runScoped(
      ['transition', 'COMMIT'],
      seedScopeFixture,
      (dir) => {
        const root = readJson(path.join(dir, '.agyloop', 'state.json'));
        assert.strictEqual(root.currentStage, 'INITIALIZED', 'the root must not advance');
        const task = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        assert.strictEqual(task.currentStage, 'COMMIT', 'the task checkpoint must advance');
      }
    );

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  });

  test('branch-info reports the task checkpoint’s branch', async () => {
    const result = await runScoped(['branch-info', '--json'], (dir) => {
      seedScopeFixture(dir);
      const taskPath = path.join(dir, '.agyloop', 'tasks', '999.json');
      const task = readJson(taskPath);
      task.worktree = {
        taskId: '999',
        worktreePath: path.join(dir, '.worktrees', '999'),
        branch: 'task/999-from-checkpoint',
        baseBranch: 'feature/task-base',
        createdAt: EARLY
      };
      fs.writeFileSync(taskPath, JSON.stringify(task));
    });

    assert.strictEqual(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.strictEqual(parsed.taskBranch, 'task/999-from-checkpoint');
    assert.strictEqual(parsed.baseBranch, 'phase/6-codeloop');
  });

  test('halt --issue 999 pauses the task checkpoint and leaves the root alone', async () => {
    let rootBefore = '';

    const result = await runScoped(
      ['halt', '--reason', 'quota', '--issue', '999'],
      (dir) => {
        seedScopeFixture(dir);
        rootBefore = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      },
      (dir) => {
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8'),
          rootBefore,
          'the root checkpoint must be byte-identical'
        );
        const task = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        assert.strictEqual(task.pausedAtGate, 'CIRCUIT_BREAKER');
        assert.strictEqual(task.issue, 999);
      }
    );

    assert.strictEqual(result.code, 2, `${result.stdout}\n${result.stderr}`);
  });

  test('reset --issue 999 deletes the task checkpoint and leaves the root alone', async () => {
    let rootBefore = '';

    const result = await runScoped(
      ['reset', '--issue', '999'],
      (dir) => {
        seedScopeFixture(dir);
        rootBefore = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      },
      (dir) => {
        assert.ok(
          !fs.existsSync(path.join(dir, '.agyloop', 'tasks', '999.json')),
          'the task checkpoint must be gone'
        );
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8'),
          rootBefore,
          'the root checkpoint must be byte-identical'
        );
      }
    );

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  });

  test('resume --issue 999 clears the task checkpoint’s pause and leaves the root alone', async () => {
    let rootBefore = '';

    const result = await runScoped(
      ['resume', '--issue', '999'],
      (dir) => {
        seedScopeFixture(dir);
        const taskPath = path.join(dir, '.agyloop', 'tasks', '999.json');
        const task = readJson(taskPath);
        task.pausedAtGate = 'COMMIT';
        task.pausedAtTimestamp = LONG_AGO;
        fs.writeFileSync(taskPath, JSON.stringify(task));
        rootBefore = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      },
      (dir) => {
        assert.strictEqual(
          fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8'),
          rootBefore,
          'the root checkpoint must be byte-identical'
        );
        const task = readJson(path.join(dir, '.agyloop', 'tasks', '999.json'));
        assert.strictEqual(task.pausedAtGate, null, 'the task pause must be cleared');
      }
    );

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  });

  test('implement --issue 999 finds the task checkpoint', async () => {
    const result = await runScoped(
      ['implement', '--issue', '999', '--no-worktree'],
      seedScopeFixture
    );

    assert.ok(
      !/Cannot start implementation: No pipeline state found\./.test(result.stdout + result.stderr),
      `implement must find the task checkpoint:\n${result.stdout}\n${result.stderr}`
    );
  });

  test('reset without --issue names the checkpoint it actually cleared', async () => {
    // Inside a task worktree the CLI's OWN repository is bound to
    // `tasks/<n>.json` — the issue is inferred from the cwd — so the old
    // hardcoded ".agyloop/state.json cleared" named a file that was never
    // touched (issue #250, review N2). The truth is `ResetPipelineResult.path`.
    const worktreeRel = path.join('.worktrees', '250');
    const checkpointRel = path.join(worktreeRel, '.agyloop', 'tasks', '250.json');

    const result = await runScoped(
      ['reset'],
      (dir) => {
        const checkpoint = path.join(dir, checkpointRel);
        fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
        fs.writeFileSync(
          checkpoint,
          JSON.stringify(taskSnapshot({ issue: 250, stage: 'COMMIT', updatedAt: LATE }))
        );
      },
      (dir) => {
        assert.ok(
          !fs.existsSync(path.join(dir, checkpointRel)),
          'the checkpoint the command claims to clear must actually be gone'
        );
      },
      worktreeRel
    );

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      result.stdout.includes(path.join('.agyloop', 'tasks', '250.json')),
      `the report must name the file it cleared:\n${result.stdout}`
    );
    assert.ok(
      !result.stdout.includes(path.join('.agyloop', 'state.json')),
      `the report must not claim a file it never touched:\n${result.stdout}`
    );
  });
});