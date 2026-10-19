/**
 * agyloop - `codeloop transition --dry-run` is a real no-write contract (#226 D4)
 *
 * `TransitionStageUseCase` gates its checkpoint write AND its worktree
 * provisioning on `params.dryRun` (`transition-stage.ts:131`, `:190`), but the CLI
 * boundary never forwarded the flag — `codeloop transition <STAGE> --dry-run`
 * printed `✓ Transitioned to [X]` and wrote `.agyloop/state.json` anyway. The
 * `dryRun` branch was dead code on that path.
 *
 * These tests are deliberately split into two independent assertions so neither
 * can be made green by the other:
 *
 *   1. the FILESYSTEM contract (no checkpoint written / byte-identical);
 *   2. the FORWARDING contract (the `[dry-run] ` prefix), which goes red if the
 *      `dryRun:` line in `cli.ts` is reverted even if some future use case
 *      happened to stop writing.
 *
 * A negative control (`transition` without `--dry-run` still writes) keeps the
 * suite from passing against a use case that never writes anything.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const SEEDED_AT = '2026-10-14T12:00:00.000Z';

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** Seeds a checkpoint at INITIALIZED, which is where a fresh workspace starts. */
function seedInitialState(dir: string): void {
  const stateDir = path.join(dir, '.agyloop');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'INITIALIZED',
      mode: 'standard',
      issue: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      history: [{ stage: 'INITIALIZED', timestamp: SEEDED_AT }]
    })
  );
}

/** Seeds a `mode: plan` checkpoint at PLAN, from which IMPLEMENT is illegal. */
function seedPlanModeState(dir: string): void {
  const stateDir = path.join(dir, '.agyloop');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'PLAN',
      mode: 'plan',
      issue: null,
      createdAt: SEEDED_AT,
      updatedAt: SEEDED_AT,
      history: [{ stage: 'PLAN', timestamp: SEEDED_AT }]
    })
  );
}

/**
 * Runs `runCli` in a throwaway cwd with both console streams captured, restoring
 * everything (cwd, TTY flags, console) in `finally`.
 *
 * Recipe copied verbatim from `tests/presentation/cli-gate-pause-visibility.test.ts`:
 * `NODE_TEST_CONTEXT` is set by the runner, which is what makes the `/tmp` write
 * guard in `file-state-repository.ts:164-175` permit this sandbox.
 */
async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void,
  inspect?: (dir: string) => void
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-transition-dry-'));
  let stdout = '';
  let stderr = '';

  try {
    if (seed) {
      seed(tempDir);
    }
    process.chdir(tempDir);
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
      // Hang guard: a hung suite is worse than a red one.
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
      // Runs while the sandbox still exists, so on-disk assertions belong here
      // rather than after `finally` deletes the tree.
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

describe('codeloop transition --dry-run', () => {
  test('writes no checkpoint at all (headline AC)', async () => {
    let stateExists = true;
    let tasksExist = true;

    const result = await runCliInSandbox(
      ['transition', 'DISCOVERY', '--dry-run'],
      undefined,
      (dir) => {
        stateExists = fs.existsSync(path.join(dir, '.agyloop', 'state.json'));
        tasksExist = fs.existsSync(path.join(dir, '.agyloop', 'tasks'));
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(!stateExists, 'a dry run must not create .agyloop/state.json');
    assert.ok(!tasksExist, 'a dry run must not create .agyloop/tasks');
    assert.ok(result.stdout.includes('[dry-run]'), result.stdout);
    assert.ok(/Transitioned to .*DISCOVERY/.test(result.stdout), result.stdout);
  });

  test('forwards the flag (explicit regression, headline AC)', async () => {
    // Ties the presentation change to the behaviour change: reverting the single
    // `dryRun: options.dryRun` line in cli.ts reddens BOTH this and the test above.
    const result = await runCliInSandbox(['transition', 'DISCOVERY', '--dry-run']);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('[dry-run] Transitioned to'), result.stdout);
    assert.ok(!result.stdout.includes('✓ Transitioned to'), result.stdout);
  });

  test('without --dry-run the checkpoint is still written (negative control)', async () => {
    const result = await runCliInSandbox(
      ['transition', 'DISCOVERY'],
      undefined,
      (dir) => {
        const statePath = path.join(dir, '.agyloop', 'state.json');
        assert.ok(fs.existsSync(statePath), 'a real transition must persist its checkpoint');
        assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).currentStage, 'DISCOVERY');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes('✓ Transitioned to'), result.stdout);
    assert.ok(!result.stdout.includes('[dry-run]'), result.stdout);
  });

  test('leaves an existing checkpoint byte-identical', async () => {
    let before = '';
    let after: string | null = null;

    const result = await runCliInSandbox(
      ['transition', 'DISCOVERY', '--dry-run'],
      (dir) => {
        seedInitialState(dir);
        before = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      },
      (dir) => {
        after = fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8');
      }
    );

    assert.strictEqual(result.code, 0, result.stderr);
    assert.strictEqual(after, before, 'a dry run must not rewrite the checkpoint');
  });

  test('an illegal transition still fails non-zero and writes nothing', async () => {
    let stage = '';
    let worktreesExist = true;

    const result = await runCliInSandbox(
      ['transition', 'IMPLEMENT'],
      seedPlanModeState,
      (dir) => {
        stage = JSON.parse(fs.readFileSync(path.join(dir, '.agyloop', 'state.json'), 'utf8')).currentStage;
        worktreesExist = fs.existsSync(path.join(dir, '.worktrees'));
      }
    );

    assert.strictEqual(result.code, 1);
    assert.ok(/Invalid lifecycle transition/.test(result.stderr), result.stderr);
    assert.strictEqual(stage, 'PLAN', 'a rejected transition must not advance the checkpoint');
    assert.ok(!worktreesExist, 'no worktree may be provisioned');
  });
});