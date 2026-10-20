/**
 * agyloop - An unreadable NAMED checkpoint must never take down the commands
 * that report on, or clean up after, a broken state (issue #250, review B1/N1).
 *
 * The resolver deliberately lets an unreadable NAMED checkpoint throw
 * (`resolve-task-checkpoint.ts`): an operator who named an issue asked about
 * THAT file, and a corrupt file must surface rather than be papered over with a
 * synthesised snapshot. That is the right contract for a command that must READ
 * the snapshot — but two commands must not be governed by it:
 *
 *   - `abort` is the EMERGENCY TEARDOWN. A corrupt `tasks/<n>.json` is
 *     precisely the state an operator aborts FROM (the resolver's own note
 *     records that saves use a plain `writeFileSync`, so a crash mid-write
 *     leaves a truncated file). Before #250 the checkpoint was read only in the
 *     use case's LAST step — inside a try/catch, AFTER the teardown — so a
 *     corrupt file could never stop the teardown. Resolving the scope before
 *     the use case reintroduced that failure mode: the command printed its
 *     "Initiating Emergency Abort Protocol…" banner and then died with a raw
 *     `Fatal: StateStorageError` stack, before terminating a single process.
 *
 *   - `triage` must REPORT an unreadable checkpoint as a triage failure
 *     (`✗ Triage failed: …`), not throw it out of `runCli` as a raw stack.
 *     That is exactly what the base branch did, because the load happened
 *     inside the use case, i.e. inside the CLI's try/catch.
 *
 *   - `sync` must REPORT an unreadable checkpoint as a sync failure
 *     (`✗ Sync failed: …`), not throw it out of `runCli` as a raw stack. The
 *     base branch did the same, because the load happened inside
 *     `SyncUseCase.execute`, whose own try/catch turned it into a
 *     `Sync failed: …` result the CLI rendered.
 *
 * All three regressions are asserted here against the real CLI entry point.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/**
 * Seeds a truncated (crash-mid-write) task checkpoint: a JSON prefix that no
 * longer parses. `FileStateRepository.load()` turns this into a
 * `StateStorageError` ("Failed to parse state checkpoint at …").
 */
function seedCorruptTask(dir: string, issue: number): string {
  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const taskPath = path.join(tasksDir, `${issue}.json`);
  fs.writeFileSync(taskPath, '{"currentStage":');
  return taskPath;
}

/**
 * Runs `runCli` in a throwaway cwd with both console streams captured,
 * restoring everything (cwd, TTY flags, console, AGY_SUBAGENT) in `finally`.
 * Recipe copied verbatim from `tests/presentation/cli-status-resume-task-scope.test.ts`.
 */
async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const prevSubagent = process.env.AGY_SUBAGENT;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-corrupt-checkpoint-'));
  let stdout = '';
  let stderr = '';

  try {
    if (seed) {
      seed(tempDir);
    }
    process.chdir(tempDir);
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    // `abort` is a state-mutating command: the Zero Direct Root Mutation guard
    // refuses it when the caller claims to be a subagent.
    delete process.env.AGY_SUBAGENT;
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

    return { code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
    if (prevSubagent === undefined) {
      delete process.env.AGY_SUBAGENT;
    } else {
      process.env.AGY_SUBAGENT = prevSubagent;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('abort completes the teardown even when the named checkpoint is corrupt (#250 B1)', () => {
  test('`abort --issue 999` exits 0 and reports the teardown', async () => {
    const result = await runCliInSandbox(['abort', '--issue', '999'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      result.stdout.includes('Emergency Abort completed'),
      `the teardown must have run:\n${result.stdout}\n${result.stderr}`
    );
  });

  test('the teardown summary is complete (processes, locks, worktrees, containers)', async () => {
    const result = await runCliInSandbox(['abort', '--issue', '999'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    for (const line of [
      'Processes terminated',
      'Stale git locks cleared',
      'Worktrees quarantined',
      'Containers terminated',
      'Summary audit checkpoint'
    ]) {
      assert.ok(
        result.stdout.includes(line),
        `the teardown summary must report "${line}":\n${result.stdout}`
      );
    }
  });

  test('the unreadable checkpoint is reported, not swallowed', async () => {
    const result = await runCliInSandbox(['abort', '--issue', '999'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    assert.ok(
      result.stderr.includes('Could not read the checkpoint'),
      `the operator must be told why the audit checkpoint was skipped:\n${result.stderr}`
    );
    assert.ok(
      result.stderr.includes(path.join('.agyloop', 'tasks', '999.json')),
      `the report must name the unreadable file:\n${result.stderr}`
    );
  });

  test('no raw error class escapes the command', async () => {
    // A raw `Fatal: StateStorageError: …` (printed by `main()` when `runCli`
    // throws) would carry the error CLASS NAME. The reported message does not.
    const result = await runCliInSandbox(['abort', '--issue', '999'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    assert.ok(
      !/StateStorageError/.test(result.stdout + result.stderr),
      `no raw error class may escape:\n${result.stdout}\n${result.stderr}`
    );
    assert.ok(
      !/^\s+at\s+\S+/m.test(result.stdout + result.stderr),
      `no raw stack may escape:\n${result.stdout}\n${result.stderr}`
    );
  });

  test('a corrupt checkpoint does not stop a bare `abort` either', async () => {
    // Without `--issue` the scope is resolved by the scan, which already
    // tolerates unreadable candidates — the teardown must be unaffected.
    const result = await runCliInSandbox(['abort'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes('Emergency Abort completed'), result.stdout);
  });
});

describe('triage reports an unreadable named checkpoint instead of a raw stack (#250 N1)', () => {
  test('`triage --issue 999` exits 1 with a rendered failure', async () => {
    const result = await runCliInSandbox(['triage', '--issue', '999'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    assert.strictEqual(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      result.stderr.includes('✗ Triage failed:'),
      `the failure must be rendered:\n${result.stdout}\n${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('Failed to parse state checkpoint at'),
      `the failure must name the unreadable file:\n${result.stdout}\n${result.stderr}`
    );
  });

  test('no raw error class or stack escapes the command', async () => {
    const result = await runCliInSandbox(['triage', '--issue', '999'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    assert.ok(
      !/StateStorageError/.test(result.stdout + result.stderr),
      `no raw error class may escape:\n${result.stdout}\n${result.stderr}`
    );
    assert.ok(
      !/^\s+at\s+\S+/m.test(result.stdout + result.stderr),
      `no raw stack may escape:\n${result.stdout}\n${result.stderr}`
    );
  });
});

describe('sync reports an unreadable named checkpoint instead of a raw stack (#250 N2)', () => {
  /**
   * Runs the command and captures BOTH outcomes: a rendered failure (exit 1)
   * and a THROWN error.
   *
   * The thrown outcome IS the regression: before the fix the `sync` case
   * resolved its scope OUTSIDE any try/catch, so the `StateStorageError`
   * escaped `runCli` and `main()` printed `Fatal: StateStorageError: …` plus a
   * stack. Capturing the throw keeps the failure message legible instead of
   * letting it abort the whole test file.
   */
  async function runCliCapturingThrow(
    args: readonly string[],
    seed?: (dir: string) => void
  ): Promise<{ code: number | null; stdout: string; stderr: string; thrown: unknown }> {
    try {
      const result = await runCliInSandbox(args, seed);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr, thrown: null };
    } catch (thrown) {
      return { code: null, stdout: '', stderr: '', thrown };
    }
  }

  test('`sync --issue 999` exits 1 with a rendered failure', async () => {
    const result = await runCliCapturingThrow(['sync', '--issue', '999'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    assert.strictEqual(
      result.thrown,
      null,
      `the command must not throw out of runCli:\n${String(result.thrown)}`
    );
    assert.strictEqual(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      result.stderr.includes('✗ Sync failed:'),
      `the failure must be rendered:\n${result.stdout}\n${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('Failed to parse state checkpoint at'),
      `the failure must name the unreadable file:\n${result.stdout}\n${result.stderr}`
    );
  });

  test('no raw error class or stack escapes the command', async () => {
    const result = await runCliCapturingThrow(['sync', '--issue', '999'], (dir) => {
      seedCorruptTask(dir, 999);
    });

    assert.strictEqual(
      result.thrown,
      null,
      `the command must not throw out of runCli:\n${String(result.thrown)}`
    );
    assert.ok(
      !/StateStorageError/.test(result.stdout + result.stderr),
      `no raw error class may escape:\n${result.stdout}\n${result.stderr}`
    );
    assert.ok(
      !/^\s+at\s+\S+/m.test(result.stdout + result.stderr),
      `no raw stack may escape:\n${result.stdout}\n${result.stderr}`
    );
  });
});
