/**
 * agyloop - `worktree prune --dry-run` predicts what it removes and `list`
 * labels a prunable registration (issue #339, item 5, absorbing #340 / AC-2.2)
 *
 * T5.2  a real dead registration (directory deleted behind git's back) is
 *       listed with status `prunable`, and the header no longer claims every
 *       row is "Active".
 * T5.3  the dry run predicts exactly the count the real run removes (= 1), and
 *       mutates nothing (porcelain byte-identical).
 *
 * Real git sandboxes: the defect only exists when git itself reports the
 * `prunable` marker, so a mocked porcelain would test the mock.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function gitRun(dir: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

/**
 * A repository whose `.worktrees/task-2` registration is `prunable`: the
 * directory is gone while git still lists the entry — the exact audit shape.
 */
function makePrunableSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-worktree-prunable-'));
  gitRun(dir, ['init', '-q']);
  gitRun(dir, ['config', 'user.email', 'smoke@test']);
  gitRun(dir, ['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  gitRun(dir, ['add', '-A']);
  gitRun(dir, ['commit', '-qm', 'chore: seed']);
  gitRun(dir, ['worktree', 'add', '-q', '-b', 'task/2', '.worktrees/task-2']);
  fs.rmSync(path.join(dir, '.worktrees', 'task-2'), { recursive: true, force: true });

  const porcelain = gitRun(dir, ['worktree', 'list', '--porcelain']);
  assert.match(porcelain, /^prunable/m, 'precondition: git must call the registration prunable');
  return dir;
}


describe('item 5: `worktree list` labels a prunable registration (AC-2.2)', () => {
  test('T5.2: the dead registration is listed as prunable, not active', async () => {
    const dir = makePrunableSandbox();
    try {
      const run = await runCliInSandboxCanonical(['worktree', 'list'], { dir: dir, stripAnsi: true });

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /=== CodeLoop: Isolated Git Worktrees ===/, run.stdout);
      assert.ok(
        !/Active Isolated/.test(run.stdout),
        `the header must not call every row active:\n${run.stdout}`
      );
      assert.match(run.stdout, /Status/, `a Status column must exist:\n${run.stdout}`);

      const row = run.stdout.split('\n').find((line: string) => line.includes('task-2'));
      assert.ok(row, `the dead registration must be listed:\n${run.stdout}`);
      assert.match(row!, /\bprunable\b/, `the row must be labelled prunable: ${row}`);
      assert.ok(!/\bactive\b/.test(row!), `a prunable row must not say active: ${row}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('item 5: prune predicts what it removes (AC-2.2)', () => {
  test('T5.3: dry-run count === real count === 1, and the dry run mutates nothing', async () => {
    const dir = makePrunableSandbox();
    try {
      const porcelainBefore = gitRun(dir, ['worktree', 'list', '--porcelain']);

      const dry = await runCliInSandboxCanonical(['worktree', 'prune', '--dry-run'], { dir: dir, stripAnsi: true });
      assert.strictEqual(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /\[dry-run\]/i, dry.stdout);
      const dryMatch = /Would remove (\d+)/.exec(dry.stdout);
      assert.ok(dryMatch, `the dry run must predict a count:\n${dry.stdout}`);
      const dryCount = Number(dryMatch![1]);

      // The dry run must not prune, remove or rewrite anything.
      const porcelainAfterDry = gitRun(dir, ['worktree', 'list', '--porcelain']);
      assert.strictEqual(
        porcelainAfterDry,
        porcelainBefore,
        'the porcelain listing must be byte-identical after a dry run'
      );
      assert.strictEqual(
        fs.existsSync(path.join(dir, '.worktrees', 'task-2')),
        false,
        'the dry run must not resurrect anything'
      );

      const real = await runCliInSandboxCanonical(['worktree', 'prune'], { dir: dir, stripAnsi: true });
      assert.strictEqual(real.code, 0, real.stderr);
      const realMatch = /Cleaned (\d+)/.exec(real.stdout);
      assert.ok(realMatch, `the real run must report a count:\n${real.stdout}`);
      const realCount = Number(realMatch![1]);

      assert.strictEqual(dryCount, 1, `the dry run must predict 1, got ${dryCount}`);
      assert.strictEqual(realCount, 1, `the real run must remove 1, got ${realCount}`);
      assert.strictEqual(
        dryCount,
        realCount,
        `the prediction (${dryCount}) must equal the real removal (${realCount})`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
