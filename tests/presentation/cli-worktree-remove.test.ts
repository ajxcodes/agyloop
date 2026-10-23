/**
 * agyloop - CLI `worktree remove` End-to-End Tests (issue #282, absorbs #273)
 *
 * `worktree remove` is the only destructive command in the operator surface.
 * These tests run it against a REAL git repository and pin the operator-facing
 * contract:
 *
 *   - an absolute external path, a `..` escape, a multi-segment target and a
 *     symlink escape all exit non-zero and leave the target intact;
 *   - a missing or unregistered target exits non-zero and prints no `✓`;
 *   - a registered isolated worktree is still removed, and ONLY that task's
 *     checkpoint descriptor is cleared, so `branch-info` / `next --json` stop
 *     advertising the removed path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation');
const { NOTE_WORKTREE_REMOVED, NOTE_WORKTREE_CHECKPOINT_CLEARED } = require('../../dist/domain');

const NOW = '2026-10-23T09:00:00.000Z';

interface Sandbox {
  /** Parent of the repository — `../victim` must escape the repo. */
  readonly base: string;
  /** The repository root (the CLI's cwd). */
  readonly dir: string;
}

function makeSandbox(): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-wt-remove-'));
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

/** Writes `.agyloop/tasks/<id>.json` with a worktree descriptor. */
function seedTask(dir: string, id: number, worktreePath: string): void {
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'tasks', `${id}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'COMPLETED',
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
        history: [{ stage: 'COMPLETED', timestamp: NOW }]
      },
      null,
      2
    ),
    'utf8'
  );
}

/**
 * Writes the ROOT `.agyloop/state.json` with a worktree descriptor.
 *
 * A build older than the #250 task-checkpoint split could leave the SAME
 * descriptor here and in `.agyloop/tasks/<id>.json`; the removal must clear
 * both (review iteration 2).
 */
function seedRootState(dir: string, id: number, worktreePath: string): void {
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'state.json'),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'COMPLETED',
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
        history: [{ stage: 'COMPLETED', timestamp: NOW }]
      },
      null,
      2
    ),
    'utf8'
  );
}

function readCheckpoint(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function gitWorktreeList(dir: string): string {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: dir,
    encoding: 'utf8'
  });
}

describe('codeloop worktree remove (#282)', () => {
  test('T-P1 refuses an absolute external target and leaves it intact (AC-1)', async () => {
    const sandbox = makeSandbox();
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-victim-cli-'));
    const decoyTarget = path.join(sandbox.dir, 'node-modules-target');
    fs.mkdirSync(decoyTarget, { recursive: true });
    fs.writeFileSync(path.join(victim, 'data'), 'keep', 'utf8');
    fs.symlinkSync(decoyTarget, path.join(victim, 'node_modules'), 'dir');

    try {
      const run = await runCliIn(sandbox.dir, ['worktree', 'remove', victim]);

      assert.strictEqual(run.code, 1, `${run.stdout}\n${run.stderr}`);
      assert.strictEqual(run.stdout.includes('✓'), false, `no success line:\n${run.stdout}`);
      assert.strictEqual(run.stdout.includes(NOTE_WORKTREE_REMOVED), false, run.stdout);
      assert.ok(run.stderr.includes('✗'), `expected a ✗ refusal:\n${run.stderr}`);
      assert.strictEqual(fs.readFileSync(path.join(victim, 'data'), 'utf8'), 'keep');
      assert.strictEqual(fs.lstatSync(path.join(victim, 'node_modules')).isSymbolicLink(), true);
    } finally {
      fs.rmSync(victim, { recursive: true, force: true });
      cleanup(sandbox);
    }
  });

  test('T-P2 refuses a .. escape and a multi-segment target (AC-2)', async () => {
    const sandbox = makeSandbox();
    const victim = path.join(sandbox.base, 'victim-rel');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'data'), 'keep', 'utf8');

    try {
      for (const target of ['../victim-rel', 'a/b']) {
        const run = await runCliIn(sandbox.dir, ['worktree', 'remove', target]);
        assert.strictEqual(run.code, 1, `${target}: ${run.stdout}\n${run.stderr}`);
        assert.strictEqual(run.stdout.includes('✓'), false, `${target}: ${run.stdout}`);
      }

      assert.strictEqual(fs.readFileSync(path.join(victim, 'data'), 'utf8'), 'keep');
    } finally {
      cleanup(sandbox);
    }
  });

  test('T-P3 refuses a .worktrees symlink escape (AC-3)', async () => {
    const sandbox = makeSandbox();
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-victim-link-cli-'));
    fs.writeFileSync(path.join(victim, 'data'), 'keep', 'utf8');

    const worktreesDir = path.join(sandbox.dir, '.worktrees');
    fs.mkdirSync(worktreesDir, { recursive: true });
    const linkPath = path.join(worktreesDir, '666');
    fs.symlinkSync(victim, linkPath, 'dir');

    try {
      const run = await runCliIn(sandbox.dir, ['worktree', 'remove', '666']);

      assert.strictEqual(run.code, 1, `${run.stdout}\n${run.stderr}`);
      assert.strictEqual(run.stdout.includes('✓'), false, run.stdout);
      assert.strictEqual(fs.readFileSync(path.join(victim, 'data'), 'utf8'), 'keep');
      assert.strictEqual(fs.lstatSync(linkPath).isSymbolicLink(), true);
    } finally {
      fs.rmSync(victim, { recursive: true, force: true });
      cleanup(sandbox);
    }
  });

  test('T-P4 a missing id exits non-zero with a clear message (AC-4)', async () => {
    const sandbox = makeSandbox();

    try {
      const run = await runCliIn(sandbox.dir, ['worktree', 'remove', '999']);

      assert.strictEqual(run.code, 1, `${run.stdout}\n${run.stderr}`);
      assert.strictEqual(run.stdout.includes('✓'), false, `no success line:\n${run.stdout}`);
      assert.strictEqual(run.stdout.includes(NOTE_WORKTREE_REMOVED), false, run.stdout);
      assert.ok(
        /not exist|not a registered/i.test(run.stderr),
        `expected a missing-target refusal:\n${run.stderr}`
      );
      assert.ok(run.stderr.includes('999'), run.stderr);
    } finally {
      cleanup(sandbox);
    }
  });

  test('T-P5 refuses an unregistered directory inside .worktrees (AC-5)', async () => {
    const sandbox = makeSandbox();
    const unregistered = path.join(sandbox.dir, '.worktrees', '777');
    fs.mkdirSync(unregistered, { recursive: true });
    fs.writeFileSync(path.join(unregistered, 'sentinel'), 'keep', 'utf8');
    const listBefore = gitWorktreeList(sandbox.dir);

    try {
      const run = await runCliIn(sandbox.dir, ['worktree', 'remove', '777']);

      assert.strictEqual(run.code, 1, `${run.stdout}\n${run.stderr}`);
      assert.strictEqual(run.stdout.includes('✓'), false, run.stdout);
      assert.strictEqual(fs.readFileSync(path.join(unregistered, 'sentinel'), 'utf8'), 'keep');
      assert.strictEqual(gitWorktreeList(sandbox.dir), listBefore);
    } finally {
      cleanup(sandbox);
    }
  });

  test('T-P6 removes a registered worktree and clears only its descriptor (AC-6, AC-7, AC-8)', async () => {
    const sandbox = makeSandbox();
    const worktreePath = addWorktree(sandbox.dir, 555);
    seedTask(sandbox.dir, 555, worktreePath);
    // Sibling task: its descriptor must survive byte-for-byte.
    seedTask(sandbox.dir, 556, path.join(sandbox.dir, '.worktrees', '556'));
    const siblingPath = path.join(sandbox.dir, '.agyloop', 'tasks', '556.json');
    const siblingBefore = fs.readFileSync(siblingPath, 'utf8');

    try {
      const run = await runCliIn(sandbox.dir, ['worktree', 'remove', '555']);

      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stdout.includes('✓'), run.stdout);
      assert.ok(run.stdout.includes(NOTE_WORKTREE_CHECKPOINT_CLEARED), run.stdout);
      assert.strictEqual(fs.existsSync(worktreePath), false, 'the worktree directory must be gone');

      const task = JSON.parse(
        fs.readFileSync(path.join(sandbox.dir, '.agyloop', 'tasks', '555.json'), 'utf8')
      );
      assert.strictEqual(task.worktree, null, 'the removed task descriptor must be cleared');
      assert.strictEqual(
        fs.readFileSync(siblingPath, 'utf8'),
        siblingBefore,
        'the sibling checkpoint must be untouched'
      );

      const branchInfo = await runCliIn(sandbox.dir, ['branch-info', '--issue', '555']);
      assert.strictEqual(branchInfo.code, 0, branchInfo.stderr);
      assert.strictEqual(
        branchInfo.stdout.includes(path.join('.worktrees', '555')),
        false,
        `branch-info must not advertise the removed worktree:\n${branchInfo.stdout}`
      );

      const next = await runCliIn(sandbox.dir, ['next', '--issue', '555', '--json']);
      assert.strictEqual(next.code, 0, next.stderr);
      assert.strictEqual(JSON.parse(next.stdout).worktreePath, null);

      assert.strictEqual(
        gitWorktreeList(sandbox.dir).includes(path.join('.worktrees', '555')),
        false,
        'git must no longer register the removed worktree'
      );
    } finally {
      cleanup(sandbox);
    }
  });

  test('T-P9 clears the root state.json AND the task checkpoint when both name the path (AC-6, AC-8)', async () => {
    const sandbox = makeSandbox();
    const worktreePath = addWorktree(sandbox.dir, 555);
    seedRootState(sandbox.dir, 555, worktreePath);
    seedTask(sandbox.dir, 555, worktreePath);

    try {
      const run = await runCliIn(sandbox.dir, ['worktree', 'remove', '555']);

      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stdout.includes('✓'), run.stdout);
      assert.ok(run.stdout.includes('state.json'), run.stdout);
      assert.ok(run.stdout.includes(path.join('tasks', '555.json')), run.stdout);

      assert.strictEqual(
        readCheckpoint(path.join(sandbox.dir, '.agyloop', 'state.json')).worktree,
        null,
        'the root checkpoint must be cleared'
      );
      assert.strictEqual(
        readCheckpoint(path.join(sandbox.dir, '.agyloop', 'tasks', '555.json')).worktree,
        null,
        'the task checkpoint must be cleared too'
      );

      const branchInfo = await runCliIn(sandbox.dir, ['branch-info', '--issue', '555']);
      assert.strictEqual(branchInfo.code, 0, branchInfo.stderr);
      assert.strictEqual(
        branchInfo.stdout.includes(path.join('.worktrees', '555')),
        false,
        `branch-info must not advertise the removed worktree:\n${branchInfo.stdout}`
      );
      assert.strictEqual(/MISSING|stale/i.test(branchInfo.stdout), false, branchInfo.stdout);
    } finally {
      cleanup(sandbox);
    }
  });

  test('T-P10 the stale remediation printed by branch-info actually repairs the checkpoint (AC-9)', async () => {
    const sandbox = makeSandbox();
    const stalePath = path.join(sandbox.dir, '.worktrees', '42');
    seedTask(sandbox.dir, 42, stalePath);

    try {
      const before = await runCliIn(sandbox.dir, ['branch-info', '--issue', '42']);
      assert.strictEqual(before.code, 0, before.stderr);
      assert.ok(/MISSING|stale/i.test(before.stdout), before.stdout);
      assert.ok(
        before.stdout.includes('worktree remove 42 --prune-stale'),
        `the remediation must name the supported repair:\n${before.stdout}`
      );

      // The plain command must still refuse a missing directory (AC-2)...
      const plain = await runCliIn(sandbox.dir, ['worktree', 'remove', '42']);
      assert.strictEqual(plain.code, 1, plain.stdout);

      // ...and the printed remediation must succeed.
      const repair = await runCliIn(sandbox.dir, ['worktree', 'remove', '42', '--prune-stale']);
      assert.strictEqual(repair.code, 0, `${repair.stdout}\n${repair.stderr}`);
      assert.ok(repair.stdout.includes('✓'), repair.stdout);
      assert.strictEqual(
        readCheckpoint(path.join(sandbox.dir, '.agyloop', 'tasks', '42.json')).worktree,
        null,
        'the stale descriptor must be cleared'
      );

      const after = await runCliIn(sandbox.dir, ['branch-info', '--issue', '42']);
      assert.strictEqual(after.code, 0, after.stderr);
      assert.strictEqual(after.stdout.includes(stalePath), false, after.stdout);
      assert.strictEqual(/MISSING|stale descriptor/i.test(after.stdout), false, after.stdout);
    } finally {
      cleanup(sandbox);
    }
  });

  test('T-P11 --prune-stale refuses a live worktree directory (AC-2, AC-9)', async () => {
    const sandbox = makeSandbox();
    const worktreePath = addWorktree(sandbox.dir, 555);
    seedTask(sandbox.dir, 555, worktreePath);

    try {
      const run = await runCliIn(sandbox.dir, ['worktree', 'remove', '555', '--prune-stale']);

      assert.strictEqual(run.code, 1, `${run.stdout}\n${run.stderr}`);
      assert.strictEqual(run.stdout.includes('✓'), false, run.stdout);
      assert.strictEqual(fs.existsSync(worktreePath), true, 'the live worktree must survive');
      assert.notStrictEqual(
        readCheckpoint(path.join(sandbox.dir, '.agyloop', 'tasks', '555.json')).worktree,
        null,
        'a live descriptor must not be cleared'
      );
    } finally {
      cleanup(sandbox);
    }
  });
});
