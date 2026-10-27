/**
 * agyloop - CLI prompt guard tests (issue #218 / AC6)
 *
 * Zero-Hang Invariant: `codeloop` must never open a confirmation prompt that a
 * human cannot answer. With a silent-but-open stdin pipe (CI, cron, `npm test`)
 * `rl.question` never fires, so the promise never settles and the process hangs
 * forever. These tests pin the composition-root gate (`promptsAllowed`) that makes
 * every prompt-issuing call site refuse to prompt in a non-interactive session.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli, computePromptsAllowed } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/**
 * Seeds a pipeline checkpoint sitting exactly at the COMMIT gate, with a worktree
 * descriptor so the commit gate is genuinely reachable (otherwise the commit use
 * case fails on `validateWorktree` before it ever reaches a prompt).
 */
function seedStateAtCommit(dir: string, includeWorktree = true): void {
  const stateDir = path.join(dir, '.agyloop');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'COMMIT',
      mode: 'standard',
      issue: 99,
      createdAt: now,
      updatedAt: now,
      history: [{ stage: 'COMMIT', timestamp: now }],
      ...(includeWorktree
        ? { worktree: { taskId: 99, worktreePath: dir, branch: 'task/99', baseBranch: 'main' } }
        : {})
    })
  );
}

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `runCli` inside a throwaway cwd with the TTY flags forced, capturing all
 * console output. Rejects with an explicit HANG error instead of blocking forever
 * if a prompt is ever opened without an answerable stream.
 */
async function runCliInSandbox(
  args: readonly string[],
  opts: {
    readonly stdinIsTTY: boolean;
    readonly stdoutIsTTY: boolean;
    readonly seed?: (dir: string) => void;
    readonly timeoutMs?: number;
  }
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinIsTTY = (process.stdin as any).isTTY;
  const originalStdoutIsTTY = (process.stdout as any).isTTY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-prompt-guard-'));
  let stdout = '';
  let stderr = '';

  try {
    if (opts.seed) {
      opts.seed(tempDir);
    }
    process.chdir(tempDir);
    (process.stdin as any).isTTY = opts.stdinIsTTY;
    (process.stdout as any).isTTY = opts.stdoutIsTTY;
    console.log = (...args: unknown[]) => {
      stdout += args.map(String).join(' ') + '\n';
    };
    console.error = (...args: unknown[]) => {
      stderr += args.map(String).join(' ') + '\n';
    };

    const timeoutMs = opts.timeoutMs ?? 20000;
    const code = await Promise.race([
      runCli(args),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`HANG: runCli(${JSON.stringify(args)}) never settled — a prompt was opened without an answerable stream.`)),
          timeoutMs
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
    (process.stdin as any).isTTY = originalStdinIsTTY;
    (process.stdout as any).isTTY = originalStdoutIsTTY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('computePromptsAllowed (composition-root gate)', () => {
  test('returns true only for an interactive human session', () => {
    assert.strictEqual(computePromptsAllowed({ json: false }, true, true), true);
  });

  test('returns false when stdin is not a TTY', () => {
    assert.strictEqual(computePromptsAllowed({ json: false }, false, true), false);
  });

  test('returns false when stdout is not a TTY', () => {
    assert.strictEqual(computePromptsAllowed({ json: false }, true, false), false);
  });

  test('returns false when neither stream is a TTY', () => {
    assert.strictEqual(computePromptsAllowed({ json: false }, false, false), false);
  });

  test('returns false in --json mode even on a TTY', () => {
    assert.strictEqual(computePromptsAllowed({ json: true }, true, true), false);
  });
});

describe('runCli prompt guards', () => {
  test('default lifecycle does not prompt at the COMMIT gate when stdin is not a TTY', async () => {
    // Pre-fix this call hardcoded `interactiveCommit: true`, entered the commit gate
    // and opened a readline interface on a silent stdin pipe, which never settles.
    const result = await runCliInSandbox([], {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      seed: (dir) => seedStateAtCommit(dir)
    });

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Paused at'), result.stdout);
    assert.ok(result.stdout.includes('gate.'), result.stdout);
    assert.ok(!result.stdout.includes('Pipeline at stage'), result.stdout);
    assert.strictEqual(result.stderr, '', 'the commit use case must never be entered');
  });

  test('commit --yes proceeds past the non-interactive guard without prompting', async () => {
    const result = await runCliInSandbox(['commit', '--yes'], {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      // No worktree in the fixture: the commit use case now legalises the root
      // workspace (#301/#307) and fails deterministically at `git status`,
      // which is enough to prove the guard was passed.
      seed: (dir) => seedStateAtCommit(dir, false)
    });

    // Execution got past the prompt guard and into the commit use case, which
    // then fails deterministically because the sandbox is not a git repo.
    assert.ok(
      !result.stderr.includes('Non-interactive terminal detected'),
      result.stderr
    );
    assert.ok(
      !result.stderr.includes('Worktree path is missing in state'),
      `a null worktree must be a legal root-scoped run: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes("Commit execution error during 'git status'"),
      `expected the honest staging failure, got: ${result.stderr}`
    );
  });

  test('commit --json is REFUSED by the capability gate, never silently ignored', async () => {
    // Issue #248 (decision 3): `commit --json` used to mean "never prompt" while
    // printing human text. The non-interactive path is `-y/--yes`; the flag is
    // now a hard, non-zero refusal.
    const result = await runCliInSandbox(['commit', '--json'], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      seed: (dir) => seedStateAtCommit(dir)
    });

    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes("'--json' is not supported by 'commit'"), result.stderr);
    assert.ok(!result.stdout.includes('Proposed Conventional Commit'), result.stdout);
    assert.ok(!result.stderr.includes('Non-interactive terminal detected'), result.stderr);
  });

  test('commit -y --json is refused too (the flag is not a non-interactive shortcut)', async () => {
    const result = await runCliInSandbox(['commit', '-y', '--json'], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      seed: (dir) => seedStateAtCommit(dir)
    });

    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes("'--json' is not supported by 'commit'"), result.stderr);
  });

  test('commit without -y on a non-TTY keeps the exact non-interactive message', async () => {
    const result = await runCliInSandbox(['commit'], {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      seed: (dir) => seedStateAtCommit(dir)
    });

    assert.strictEqual(result.code, 1);
    assert.ok(
      result.stderr.includes('[agyloop] Non-interactive terminal detected. Re-run with -y/--yes to confirm, or run interactively.'),
      result.stderr
    );
  });

  test('init --json never prompts even on a TTY', async () => {
    const result = await runCliInSandbox(['init', '--json'], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      seed: (dir) => {
        fs.mkdirSync(path.join(dir, '.codeloop'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, '.codeloop', 'config.json'),
          JSON.stringify({ runner: 'auto' })
        );
      }
    });

    assert.strictEqual(result.code, 0);
    assert.ok(!result.stdout.includes('Overwrite?'), result.stdout);

    // `--json` output must stay machine-readable (single JSON document).
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.skipped, true, 'existing config must be left untouched');
  });
});
