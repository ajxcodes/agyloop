/**
 * agyloop - ONE colour policy for the whole process (issue #339, items 8/9,
 * absorbing #341)
 *
 * T9.1  piped `status`, `next` and `worktree list` contain ZERO ESC bytes.
 * T9.2  the unit matrix on `formatStageBadge`/`paint` with injected stream/env,
 *       plus an in-process TTY-attached render that still colours — and goes
 *       plain under NO_COLOR / TERM=dumb / a pipe.
 * T9.3  subprocess `NO_COLOR=1 status` and `TERM=dumb status` emit zero ESC.
 * T9.4  `status` piped into a closed consumer still exits 0 with no EPIPE or
 *       stack trace (the #315 contract is not regressed).
 *
 * The architecture tripwire (only `color-policy.ts` may contain a literal
 * escape) lives in `tests/architecture/color-policy.test.ts` (T9.5); the
 * migrated release/commit renderers are covered by their own suites (T9.6).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'codeloop.js');
const { runCli, formatStageBadge } = require('../../dist/presentation/cli');
const {
  shouldColorize,
  paint,
  STAGE_COLOR_CODES
} = require('../../dist/presentation/color-policy');

const SEEDED_AT = '2026-10-01T00:00:00.000Z';

function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-color-policy-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: seed'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  return dir;
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    currentStage: 'PLAN',
    mode: 'standard',
    issue: null,
    baseBranch: 'main',
    planDir: null,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    history: [{ stage: 'PLAN', timestamp: SEEDED_AT }],
    pausedAtGate: null,
    pausedAtTimestamp: null,
    totalHumanWaitMs: 0,
    ...overrides
  };
}

function seedRoot(dir: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agyloop', 'state.json'), JSON.stringify(snapshot(overrides)));
}

/** A checkpoint long enough that a closed consumer breaks mid-report. */
function seedLongHistory(dir: string, entries: number): void {
  const history = Array.from({ length: entries }, (_, index) => ({
    stage: index % 2 === 0 ? 'REVIEW' : 'QUALITY_GATE',
    timestamp: SEEDED_AT
  }));
  seedRoot(dir, { currentStage: 'REVIEW', history });
}

function spawnCli(
  dir: string,
  args: readonly string[],
  extraEnv: Record<string, string | undefined> = {}
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, AGY_SUBAGENT: '', HOME: path.join(dir, '.home'), ...extraEnv }
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function countEsc(text: string): number {
  return (text.match(/\x1b/g) ?? []).length;
}

async function runCliIn(
  dir: string,
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(dir);
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('T9.1: a piped human report carries no ESC byte (AC-3.2/3.3)', () => {
  test('status, next and worktree list are escape-free when piped', () => {
    const dir = makeSandbox();
    try {
      seedRoot(dir, { currentStage: 'COMPLETED' });

      const status = spawnCli(dir, ['status']);
      assert.strictEqual(status.status, 0, status.stderr);
      assert.ok(status.stdout.includes('Current Stage'), `status must render a report:\n${status.stdout}`);
      assert.strictEqual(countEsc(status.stdout), 0, 'ESC in piped status');

      const next = spawnCli(dir, ['next']);
      assert.strictEqual(next.status, 0, next.stderr);
      assert.ok(next.stdout.length > 0, 'next must render something');
      assert.strictEqual(countEsc(next.stdout), 0, 'ESC in piped next');

      const list = spawnCli(dir, ['worktree', 'list']);
      assert.strictEqual(list.status, 0, list.stderr);
      assert.match(list.stdout, /Isolated Git Worktrees/, list.stdout);
      assert.strictEqual(countEsc(list.stdout), 0, 'ESC in piped worktree list');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T9.3: NO_COLOR and TERM=dumb are honoured (AC-3.1/3.2)', () => {
  test('NO_COLOR=1 status and TERM=dumb status emit zero ESC bytes', () => {
    const dir = makeSandbox();
    try {
      seedRoot(dir, { currentStage: 'COMPLETED' });

      const noColor = spawnCli(dir, ['status'], { NO_COLOR: '1' });
      assert.strictEqual(noColor.status, 0, noColor.stderr);
      assert.strictEqual(countEsc(noColor.stdout), 0, 'ESC under NO_COLOR=1');

      const dumb = spawnCli(dir, ['status'], { TERM: 'dumb' });
      assert.strictEqual(dumb.status, 0, dumb.stderr);
      assert.strictEqual(countEsc(dumb.stdout), 0, 'ESC under TERM=dumb');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T9.2: one colour policy decides every render (AC-3.1/3.3)', () => {
  test('the unit matrix on formatStageBadge and paint with injected stream/env', () => {
    const tty = { isTTY: true };
    const pipe = { isTTY: false };

    // TTY + clean env → coloured.
    assert.notStrictEqual(
      formatStageBadge('COMPLETED', { stream: tty, env: { TERM: 'xterm' } }),
      '[COMPLETED]'
    );
    assert.ok(/\x1b/.test(formatStageBadge('COMPLETED', { stream: tty, env: { TERM: 'xterm' } })));

    // Piped → plain.
    assert.strictEqual(
      formatStageBadge('COMPLETED', { stream: pipe, env: { TERM: 'xterm' } }),
      '[COMPLETED]'
    );

    // NO_COLOR present with ANY value (including empty) → plain.
    assert.strictEqual(
      formatStageBadge('PLAN', { stream: tty, env: { NO_COLOR: '' } }),
      '[PLAN]'
    );
    assert.strictEqual(
      formatStageBadge('PLAN', { stream: tty, env: { NO_COLOR: '0' } }),
      '[PLAN]'
    );

    // TERM=dumb → plain.
    assert.strictEqual(
      formatStageBadge('PLAN', { stream: tty, env: { TERM: 'dumb' } }),
      '[PLAN]'
    );

    // Colour disabled → not even a reset byte.
    assert.strictEqual(
      formatStageBadge('COMPLETED', { stream: pipe, env: { TERM: 'xterm' } }),
      '[COMPLETED]'
    );

    // An unknown stage stays uncoloured even on a TTY.
    assert.strictEqual(
      formatStageBadge('NOT_A_STAGE', { stream: tty, env: { TERM: 'xterm' } }),
      '[NOT_A_STAGE]'
    );

    // paint/shouldColorize obey the same policy.
    assert.ok(/\x1b\[32m/.test(paint('32', 'x', tty, { TERM: 'xterm' })));
    assert.strictEqual(paint('32', 'x', pipe, { TERM: 'xterm' }), 'x');
    assert.strictEqual(paint('32', 'x', tty, { NO_COLOR: '1' }), 'x');
    assert.strictEqual(shouldColorize(tty, { TERM: 'xterm' }), true);
    assert.strictEqual(shouldColorize(pipe, { TERM: 'xterm' }), false);
    assert.strictEqual(shouldColorize(tty, { NO_COLOR: '' }), false);
    assert.strictEqual(shouldColorize(tty, { TERM: 'dumb' }), false);

    // The palette covers every stage badge the CLI can render.
    for (const stage of ['INITIALIZED', 'DISCOVERY', 'PLAN', 'APPROVAL', 'IMPLEMENT', 'QUALITY_GATE', 'REVIEW', 'COMMIT', 'COMPLETED', 'TRIAGE']) {
      assert.ok(STAGE_COLOR_CODES[stage], `missing colour code for ${stage}`);
    }
  });

  test('an in-process TTY-attached render colours; NO_COLOR, TERM=dumb and a pipe go plain', async () => {
    const dir = makeSandbox();
    const originalTTY = process.stdout.isTTY;
    const originalTerm = process.env.TERM;
    const originalNoColor = process.env.NO_COLOR;
    try {
      seedRoot(dir, { currentStage: 'PLAN' });
      process.env.TERM = 'xterm-256color';
      delete process.env.NO_COLOR;

      // TTY-attached → coloured (the control that keeps the plain assertions
      // above from passing vacuously).
      process.stdout.isTTY = true;
      const ttyRun = await runCliIn(dir, ['status']);
      assert.strictEqual(ttyRun.code, 0, ttyRun.stderr);
      assert.ok(countEsc(ttyRun.stdout) > 0, `a TTY render must colour:\n${ttyRun.stdout}`);

      // NO_COLOR present, ANY value, on a TTY → plain.
      process.env.NO_COLOR = '1';
      const noColorRun = await runCliIn(dir, ['status']);
      assert.strictEqual(countEsc(noColorRun.stdout), 0, 'ESC under NO_COLOR on a TTY');
      delete process.env.NO_COLOR;

      // TERM=dumb on a TTY → plain.
      process.env.TERM = 'dumb';
      const dumbRun = await runCliIn(dir, ['status']);
      assert.strictEqual(countEsc(dumbRun.stdout), 0, 'ESC under TERM=dumb on a TTY');
      process.env.TERM = 'xterm-256color';

      // Piped → plain, even with a clean env.
      process.stdout.isTTY = false;
      const pipeRun = await runCliIn(dir, ['status']);
      assert.strictEqual(countEsc(pipeRun.stdout), 0, 'ESC on a pipe');
      assert.ok(pipeRun.stdout.includes('Current Stage'), pipeRun.stdout);
    } finally {
      process.stdout.isTTY = originalTTY;
      if (originalTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = originalTerm;
      }
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T9.4: the #315 EPIPE contract survives the colour change (AC-3.2)', () => {
  test('status piped into a closed consumer exits 0 with no EPIPE', async () => {
    const dir = makeSandbox();
    try {
      seedLongHistory(dir, 2_000);
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(process.execPath, [BIN, 'status'], {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, AGY_SUBAGENT: '', HOME: path.join(dir, '.home') }
          });
          let stdout = '';
          let stderr = '';
          let closed = false;
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            if (!closed) {
              closed = true;
              child.stdout.destroy();
            }
          });
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on('close', (code: number | null) => resolve({ code, stdout, stderr }));
        }
      );

      assert.strictEqual(result.code, 0, `a pager must not fail the report:\n${result.stderr}`);
      assert.ok(!/EPIPE/.test(result.stderr), `no EPIPE may reach stderr:\n${result.stderr}`);
      assert.ok(
        !/Unhandled 'error' event/.test(result.stderr),
        `no unhandled stream error:\n${result.stderr}`
      );
      assert.ok(!/at .*\(.*:\d+:\d+\)/.test(result.stderr), `no stack trace:\n${result.stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
