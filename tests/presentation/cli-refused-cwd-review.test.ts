/**
 * agyloop - AC16 (#309.3): a REVIEW checkpoint in a REFUSED cwd (issue #349)
 *
 * The degrade path was pinned only at unit level (a fake `StateRepository`
 * whose `save()` throws). This fixture uses the REAL `FileStateRepository` and
 * the real CLI: a REVIEW checkpoint in a refused cwd must still yield the
 * directive, exit 0, and WARN that the dispatch counter could not be recorded.
 *
 * The refusal is deterministic because the child process environment is
 * constructed explicitly: no `NODE_ENV`, no `NODE_TEST_CONTEXT`, and the cwd is
 * a `mkdtemp` sandbox under whatever `os.tmpdir()` is — the same value handed
 * to the child as TMPDIR/TMP/TEMP, so parent and child cannot disagree about
 * the temp root. Nothing depends on `HOME`.
 *
 * F1 - guard liveness: the real repository REFUSES that cwd (what makes F2 meaningful)
 * F2 - the CLI exits 0, prints the directive, names the channel, warns on stderr (AC5)
 * F3 - control: the same fixture with the test signal present SAVES the counter
 * F4 - the warning names the exact checkpoint path
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST,
  StateStorageError,
  formatDispatchCounterUnrecorded,
  ENV_NODE_ENV,
  ENV_NODE_TEST_CONTEXT
} = require('../../dist/domain');
const { FileStateRepository } = require('../../dist/infrastructure');

const ISSUE = 349;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'codeloop.js');

function checkpointPath(sandbox: string): string {
  return path.join(sandbox, '.agyloop', 'tasks', `${ISSUE}.json`);
}

function seedReviewCheckpoint(sandbox: string): void {
  const tasksDir = path.join(sandbox, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    checkpointPath(sandbox),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'REVIEW',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'REVIEW', timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null,
        reviewDispatchCount: 0
      },
      null,
      2
    ),
    'utf8'
  );
}

function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-349-refused-cwd-'));
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  seedReviewCheckpoint(dir);
  return dir;
}

function readCheckpoint(sandbox: string): any {
  return JSON.parse(fs.readFileSync(checkpointPath(sandbox), 'utf8'));
}

/**
 * The child environment: PATH, HOME inside the sandbox, and the SAME temp root
 * the parent used. Test-run signals are absent unless explicitly restored.
 */
function childEnv(sandbox: string, extra: any = {}): any {
  const tmpRoot = os.tmpdir();
  return {
    PATH: process.env.PATH,
    HOME: path.join(sandbox, '.home'),
    TMPDIR: tmpRoot,
    TMP: tmpRoot,
    TEMP: tmpRoot,
    ...extra
  };
}

function runNext(sandbox: string, extraEnv: any = {}) {
  return spawnSync(process.execPath, [BIN, 'next', '--issue', String(ISSUE)], {
    cwd: sandbox,
    encoding: 'utf8',
    env: childEnv(sandbox, extraEnv)
  });
}

describe('REVIEW checkpoint in a refused cwd (issue #349 / AC16)', () => {
  test('F1: the real FileStateRepository refuses the write (guard liveness)', () => {
    const sandbox = makeSandbox();
    const previousNodeEnv: string | undefined = process.env[ENV_NODE_ENV];
    const previousTestContext: string | undefined = process.env[ENV_NODE_TEST_CONTEXT];
    try {
      delete process.env[ENV_NODE_ENV];
      delete process.env[ENV_NODE_TEST_CONTEXT];

      const repo = new FileStateRepository({ workspaceDir: sandbox, issue: ISSUE });
      const snapshot = readCheckpoint(sandbox);

      assert.throws(
        () => repo.save(snapshot),
        (err: any) => {
          assert.ok(err instanceof StateStorageError, `expected a StateStorageError, got: ${err}`);
          assert.strictEqual(err.message, MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST);
          return true;
        }
      );

      // The refusal really wrote nothing.
      assert.deepStrictEqual(readCheckpoint(sandbox), snapshot);
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env[ENV_NODE_ENV];
      } else {
        process.env[ENV_NODE_ENV] = previousNodeEnv;
      }
      if (previousTestContext === undefined) {
        delete process.env[ENV_NODE_TEST_CONTEXT];
      } else {
        process.env[ENV_NODE_TEST_CONTEXT] = previousTestContext;
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('F2: the CLI exits 0 with the directive and warns on stderr (AC5)', () => {
    const sandbox = makeSandbox();
    try {
      const result = runNext(sandbox);
      const output = `${result.stdout}\n${result.stderr}`;

      assert.strictEqual(result.status, 0, `exit 0 expected, got:\n${output}`);
      assert.ok(result.stdout.includes('Next Action'), output);
      assert.ok(result.stdout.includes('Invoke AI Reviewer Subagent'), output);
      assert.ok(result.stdout.includes(`codeloop review --issue ${ISSUE} --verdict-file`), output);
      assert.ok(
        result.stderr.includes('could not record the review dispatch counter'),
        `the refusal must be visible on stderr, got:\n${result.stderr}`
      );
      assert.ok(result.stderr.includes(checkpointPath(sandbox)), result.stderr);

      // The counter was NOT persisted: the checkpoint is untouched.
      assert.strictEqual(readCheckpoint(sandbox).reviewDispatchCount, 0);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('F3: control - the test signal restores the write (the refusal is the guard)', () => {
    const sandbox = makeSandbox();
    try {
      const result = runNext(sandbox, { [ENV_NODE_TEST_CONTEXT]: '1' });
      const output = `${result.stdout}\n${result.stderr}`;

      assert.strictEqual(result.status, 0, `exit 0 expected, got:\n${output}`);
      assert.ok(
        !result.stderr.includes('could not record the review dispatch counter'),
        `no warning is expected under a test signal, got:\n${result.stderr}`
      );
      assert.strictEqual(readCheckpoint(sandbox).reviewDispatchCount, 1);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('F4: the warning names the exact checkpoint path', () => {
    const sandbox = makeSandbox();
    try {
      const result = runNext(sandbox);
      const repo = new FileStateRepository({ workspaceDir: sandbox, issue: ISSUE });
      const expected = formatDispatchCounterUnrecorded('review', repo.getStateFilePath());

      assert.ok(result.stderr.includes(expected), `expected ${JSON.stringify(expected)} in:\n${result.stderr}`);
      assert.ok(expected.includes(`${ISSUE}.json`), expected);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
