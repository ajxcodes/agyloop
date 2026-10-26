/**
 * agyloop - Full-suite cwd regression (issue #298, AC5)
 *
 * WCS1 — the FULL suite must pass when the process cwd is
 * `<tmp>/.worktrees/266` while fixtures seed a DIFFERENT issue (241).
 *
 * Before the fix, three tests failed with
 * "Cannot save state for issue 241 from inside worktree for issue 266":
 * the gate's own cwd was hostile to the suite it ran, so every gate
 * dispatched inside `.worktrees/<n>` (n != 241) reported FAILED for a reason
 * unrelated to the diff.
 *
 * The child env carries a recursion marker so this test does not spawn itself
 * forever.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CHILD_FLAG = 'AGYLOOP_WORKTREE_CWD_SUITE_CHILD';
const MISMATCH_ISSUE = 266;
const SEEDED_ISSUE = 241;
const MIN_EXPECTED_TESTS = 1000;
const TIMEOUT_MS = 300000;
const MAX_BUFFER = 64 * 1024 * 1024;

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function seedMismatchedCheckpoint(worktreeDir: string): void {
  const now = new Date().toISOString();
  const stateFile = path.join(worktreeDir, '.agyloop', 'tasks', `${SEEDED_ISSUE}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'REVIEW',
        mode: 'standard',
        issue: SEEDED_ISSUE,
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'REVIEW', timestamp: now }]
      },
      null,
      2
    ),
    'utf8'
  );
}

test(
  'WCS1: the full suite passes from .worktrees/266 while a different issue is seeded',
  { timeout: TIMEOUT_MS },
  () => {
    if (process.env[CHILD_FLAG] === '1') {
      return;
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-worktree-cwd-'));
    const worktreeDir = path.join(tempRoot, '.worktrees', String(MISMATCH_ISSUE));
    fs.mkdirSync(worktreeDir, { recursive: true });
    seedMismatchedCheckpoint(worktreeDir);

    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      [CHILD_FLAG]: '1',
      // A test-run signal the guard accepts. NODE_TEST_CONTEXT is removed
      // because a nested `node --test` that inherits it treats every file as a
      // nested runner child and silently skips the suite.
      NODE_ENV: 'test'
    };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.AGYLOOP_ALLOW_WORKTREE_ISSUE_MISMATCH;

    try {
      const result = spawnSync(
        process.execPath,
        ['--test', ...collectTestFiles(path.join(PROJECT_ROOT, 'tests'))],
        {
          cwd: worktreeDir,
          env: childEnv as NodeJS.ProcessEnv,
          encoding: 'utf8',
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER
        }
      );

      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

      assert.strictEqual(
        result.status,
        0,
        `the suite must pass from ${worktreeDir}; output tail:\n${output.slice(-4000)}`
      );
      assert.ok(
        !output.includes('Cannot save state'),
        'the cross-worktree guard must not fire in a test run'
      );

      const countMatch = /ℹ tests (\d+)/.exec(output);
      assert.ok(countMatch, 'the child must report a test count');
      const reportedTests = countMatch === null ? 0 : Number(countMatch[1]);
      assert.ok(
        reportedTests > MIN_EXPECTED_TESTS,
        `expected more than ${MIN_EXPECTED_TESTS} tests, got ${reportedTests}`
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
);
