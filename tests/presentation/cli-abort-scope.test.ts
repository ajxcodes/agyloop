/**
 * agyloop - `codeloop abort` quarantine SCOPE End-to-End Tests (issue #266)
 *
 * The Emergency Abort Protocol used to quarantine EVERY worktree the repository
 * registered (`includeExternal: true`, no task filter). An operator aborting one
 * wedged run silently relocated every OTHER task's in-flight work into a stash
 * and left the worktree directory empty (the live #250 incident lost 21 files).
 *
 * These tests drive the real CLI against a real git repository and pin the
 * operator-facing contract:
 *
 *   - only the checkpoint's own worktree is touched;
 *   - siblings, external worktrees and the caller's own cwd are byte-identical;
 *   - the summary names the stash ref / quarantine branch, so the work can be
 *     recovered from printed output alone;
 *   - `--no-quarantine` / `--keep-worktrees` opt out of the relocation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation');

const NOW = '2026-10-24T00:00:00.000Z';

interface Sandbox {
  /** Parent of the repository — an external worktree lives here. */
  readonly base: string;
  /** The repository root. */
  readonly dir: string;
}

function makeSandbox(): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-abort-scope-'));
  const dir = path.join(base, 'repo');
  fs.mkdirSync(dir, { recursive: true });

  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });

  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  return { base, dir };
}

function cleanup(sandbox: Sandbox): void {
  fs.rmSync(sandbox.base, { recursive: true, force: true });
}

/** Adds a REAL git worktree at `.worktrees/<id>` on `task/<id>-probe`. */
function addWorktree(dir: string, id: number): string {
  const relative = path.join('.worktrees', String(id));
  execFileSync('git', ['worktree', 'add', '-q', '-b', `task/${id}-probe`, relative], {
    cwd: dir,
    stdio: 'ignore'
  });
  return path.join(dir, relative);
}

/** Tracked-clean + untracked work: both a staged file and an untracked one. */
function makeDirty(worktreePath: string, id: number): void {
  fs.writeFileSync(path.join(worktreePath, `feature-${id}.txt`), `work in progress ${id}\n`, 'utf8');
  fs.writeFileSync(path.join(worktreePath, `other-${id}.txt`), `another ${id}\n`, 'utf8');
  execFileSync('git', ['add', `feature-${id}.txt`], { cwd: worktreePath, stdio: 'ignore' });
}

/** Writes `.agyloop/tasks/<id>.json` with a worktree descriptor. */
function seedTask(dir: string, id: number, worktreePath: string, stage = 'IMPLEMENT'): void {
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'tasks', `${id}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: stage,
        mode: 'standard',
        issue: id,
        baseBranch: 'main',
        worktree: {
          taskId: String(id),
          worktreePath,
          branch: `task/${id}-probe`,
          baseBranch: 'main',
          isIsolated: true
        },
        createdAt: NOW,
        updatedAt: NOW,
        history: [{ stage, timestamp: NOW }]
      },
      null,
      2
    ),
    'utf8'
  );
}

/** Writes the repository-root `.agyloop/state.json` (no worktree recorded). */
function seedRootCheckpoint(dir: string): void {
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'state.json'),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'IMPLEMENT',
        mode: 'standard',
        issue: null,
        baseBranch: 'main',
        worktree: null,
        createdAt: NOW,
        updatedAt: NOW,
        history: [{ stage: 'IMPLEMENT', timestamp: NOW }]
      },
      null,
      2
    ),
    'utf8'
  );
}

function git(dir: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], { cwd: dir, encoding: 'utf8' });
}

async function runCliIn(
  dir: string,
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalSubagent = process.env.AGY_SUBAGENT;
  let stdout = '';
  let stderr = '';

  try {
    process.chdir(dir);
    // `abort` is a state-mutating command: the Zero Direct Root Mutation guard
    // refuses it when the caller claims to be a subagent.
    delete process.env.AGY_SUBAGENT;
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
    if (originalSubagent === undefined) {
      delete process.env.AGY_SUBAGENT;
    } else {
      process.env.AGY_SUBAGENT = originalSubagent;
    }
  }
}

describe('codeloop abort quarantine scope (#266)', () => {
  test('E2E-1 abort A quarantines only A and reports a reference that restores it (AC-1, AC-2, AC-4, AC-7)', async () => {
    const sandbox = makeSandbox();
    const worktreeA = addWorktree(sandbox.dir, 100);
    const worktreeB = addWorktree(sandbox.dir, 200);
    seedTask(sandbox.dir, 100, worktreeA);
    seedTask(sandbox.dir, 200, worktreeB);
    makeDirty(worktreeA, 100);
    makeDirty(worktreeB, 200);

    const bStatusBefore = git(worktreeB, ['status', '--porcelain']);
    const bHeadBefore = git(worktreeB, ['rev-parse', 'HEAD']);
    const bBranchBefore = git(worktreeB, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const bFileBefore = fs.readFileSync(path.join(worktreeB, 'feature-200.txt'), 'utf8');

    try {
      const run = await runCliIn(sandbox.dir, ['abort', '--issue', '100']);
      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

      // (1)-(3) the sibling task is untouched, byte for byte.
      assert.strictEqual(git(worktreeB, ['status', '--porcelain']), bStatusBefore);
      assert.strictEqual(git(worktreeB, ['rev-parse', 'HEAD']), bHeadBefore);
      assert.strictEqual(git(worktreeB, ['rev-parse', '--abbrev-ref', 'HEAD']), bBranchBefore);
      assert.strictEqual(
        fs.readFileSync(path.join(worktreeB, 'feature-200.txt'), 'utf8'),
        bFileBefore
      );
      assert.strictEqual(fs.existsSync(worktreeB), true);

      // (4) the summary names the recovery reference and the command.
      assert.ok(run.stdout.includes('Worktrees quarantined    : 1'), run.stdout);
      assert.ok(run.stdout.includes(worktreeA), run.stdout);
      assert.strictEqual(run.stdout.includes(worktreeB), false, run.stdout);
      const stashRef = (run.stdout.match(/stash@\{\d+\}/) || [''])[0];
      assert.ok(stashRef, `the stash ref must be printed:\n${run.stdout}`);
      assert.ok(run.stdout.includes('stash pop'), `the recovery line must be printed:\n${run.stdout}`);

      // A's work left the tree...
      assert.strictEqual(git(worktreeA, ['status', '--porcelain']).trim(), '');

      // (5) ...and the printed ref restores it.
      execFileSync('git', ['stash', 'pop', stashRef], { cwd: worktreeA, stdio: 'ignore' });
      assert.strictEqual(fs.existsSync(path.join(worktreeA, 'feature-100.txt')), true);
      assert.strictEqual(
        fs.readFileSync(path.join(worktreeA, 'feature-100.txt'), 'utf8'),
        'work in progress 100\n'
      );
    } finally {
      cleanup(sandbox);
    }
  });

  test('E2E-2 --no-quarantine and --keep-worktrees both leave A dirty (AC-5)', async () => {
    const sandbox = makeSandbox();

    try {
      const flags: ReadonlyArray<readonly [string, number]> = [
        ['--no-quarantine', 600],
        ['--keep-worktrees', 601]
      ];
      for (const [flag, id] of flags) {
        const worktreeA = addWorktree(sandbox.dir, id);
        seedTask(sandbox.dir, id, worktreeA);
        makeDirty(worktreeA, id);
        const before = git(worktreeA, ['status', '--porcelain']);

        const run = await runCliIn(sandbox.dir, ['abort', '--issue', String(id), flag]);

        assert.strictEqual(run.code, 0, `${flag}: ${run.stdout}\n${run.stderr}`);
        assert.strictEqual(git(worktreeA, ['status', '--porcelain']), before, flag);
        assert.strictEqual(git(worktreeA, ['stash', 'list']), '', `${flag}: no stash may be created`);
        assert.ok(
          run.stdout.includes('quarantine disabled by --no-quarantine'),
          `${flag}: the skip must be reported:\n${run.stdout}`
        );
      }
    } finally {
      cleanup(sandbox);
    }
  });

  test('E2E-3 an external registered dirty worktree is never quarantined (AC-3)', async () => {
    const sandbox = makeSandbox();
    const worktreeA = addWorktree(sandbox.dir, 500);
    seedTask(sandbox.dir, 500, worktreeA);
    makeDirty(worktreeA, 500);

    const externalPath = path.join(sandbox.base, 'external-wt');
    execFileSync(
      'git',
      ['worktree', 'add', '-q', '-b', 'task/900-ext', externalPath],
      { cwd: sandbox.dir, stdio: 'ignore' }
    );
    fs.writeFileSync(path.join(externalPath, 'ext.txt'), 'external work\n', 'utf8');

    const externalStatusBefore = git(externalPath, ['status', '--porcelain']);
    const externalHeadBefore = git(externalPath, ['rev-parse', 'HEAD']);

    try {
      const run = await runCliIn(sandbox.dir, ['abort', '--issue', '500']);
      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

      assert.strictEqual(git(externalPath, ['status', '--porcelain']), externalStatusBefore);
      assert.strictEqual(git(externalPath, ['rev-parse', 'HEAD']), externalHeadBefore);
      assert.strictEqual(fs.readFileSync(path.join(externalPath, 'ext.txt'), 'utf8'), 'external work\n');
      assert.strictEqual(run.stdout.includes(externalPath), false, run.stdout);
    } finally {
      cleanup(sandbox);
    }
  });

  test('E2E-4 abort run from inside the task worktree leaves it and every sibling untouched (AC-8, AC-2)', async () => {
    const sandbox = makeSandbox();
    const worktreeA = addWorktree(sandbox.dir, 300);
    const worktreeB = addWorktree(sandbox.dir, 400);
    seedTask(sandbox.dir, 300, worktreeA);
    seedTask(sandbox.dir, 400, worktreeB);
    makeDirty(worktreeA, 300);
    makeDirty(worktreeB, 400);
    // The normal tool layout: the task worktree sees the root checkpoint dir.
    fs.symlinkSync(path.join(sandbox.dir, '.agyloop'), path.join(worktreeA, '.agyloop'), 'dir');

    const bStatusBefore = git(worktreeB, ['status', '--porcelain']);

    try {
      const run = await runCliIn(worktreeA, ['abort', '--issue', '300']);
      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

      assert.strictEqual(fs.existsSync(path.join(worktreeA, 'feature-300.txt')), true);
      assert.notStrictEqual(git(worktreeA, ['status', '--porcelain']).trim(), '');
      assert.strictEqual(git(worktreeB, ['status', '--porcelain']), bStatusBefore);
      assert.strictEqual(git(worktreeA, ['stash', 'list']), '');
      assert.ok(
        run.stdout.includes('current working directory'),
        `the skip must be explained:\n${run.stdout}`
      );
      assert.ok(run.stdout.includes('Worktrees quarantined    : 0'), run.stdout);
    } finally {
      cleanup(sandbox);
    }
  });

  test('E2E-5 the summary prints a recovery line for branch-mode quarantine (AC-4)', async () => {
    const sandbox = makeSandbox();
    const worktreeA = addWorktree(sandbox.dir, 100);
    seedTask(sandbox.dir, 100, worktreeA);
    makeDirty(worktreeA, 100);

    try {
      const run = await runCliIn(sandbox.dir, ['abort', '--issue', '100', '--quarantine']);
      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

      assert.ok(run.stdout.includes('branch: quarantine/task-100-'), run.stdout);
      assert.ok(run.stdout.includes(`git -C ${worktreeA} checkout`), run.stdout);
      assert.ok(
        git(worktreeA, ['log', '-1', '--format=%s']).trim().startsWith('quarantine:'),
        'the work must be committed on the quarantine branch'
      );
      assert.strictEqual(git(worktreeA, ['status', '--porcelain']).trim(), '');
    } finally {
      cleanup(sandbox);
    }
  });

  test('E2E-6 bare abort on a root checkpoint quarantines nothing (AC-1)', async () => {
    const sandbox = makeSandbox();
    const worktreeA = addWorktree(sandbox.dir, 100);
    makeDirty(worktreeA, 100);
    seedRootCheckpoint(sandbox.dir);

    const statusBefore = git(worktreeA, ['status', '--porcelain']);

    try {
      const run = await runCliIn(sandbox.dir, ['abort']);
      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

      assert.strictEqual(git(worktreeA, ['status', '--porcelain']), statusBefore);
      assert.strictEqual(git(worktreeA, ['stash', 'list']), '');
      assert.ok(run.stdout.includes('records no worktree'), run.stdout);
    } finally {
      cleanup(sandbox);
    }
  });
});
