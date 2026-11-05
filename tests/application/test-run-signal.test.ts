/**
 * TRS1-TRS3 (issue #412): the DOCUMENTED test-run signal must actually run
 * tests.
 *
 * The old advertised signal was `NODE_TEST_CONTEXT`, which is Node's own
 * nested-run marker: `node --test` prints a recursive-run warning, skips every
 * file, prints no summary, and exits 0. This suite pins the replacement.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  WORKTREE_GUARD_SIGNAL,
  ENV_ALLOW_WORKTREE_ISSUE_MISMATCH,
  ENV_NODE_TEST_CONTEXT,
  ENV_NODE_ENV,
  ENV_NODE_VALUE_TEST
} = require('../../dist/domain');

const PROBE = path.resolve(__dirname, '..', 'fixtures', 'test-run-signal-probe.mjs');

function runProbe(env: Record<string, string>): {
  status: number | null;
  output: string;
  tests: number | null;
} {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv[ENV_NODE_TEST_CONTEXT];
  delete childEnv[ENV_NODE_ENV];
  delete childEnv[ENV_ALLOW_WORKTREE_ISSUE_MISMATCH];
  Object.assign(childEnv, env);
  childEnv.NO_COLOR = '1';
  childEnv.FORCE_COLOR = '0';
  const result = spawnSync(process.execPath, ['--test', PROBE], {
    encoding: 'utf8',
    env: childEnv
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = /^\s*(?:ℹ|#) tests (\d+)\s*$/m.exec(output);
  return { status: result.status, output, tests: match ? Number(match[1]) : null };
}

describe('TRS: the documented test-run signal (issue #412)', () => {
  test('TRS1: the documented signal is tool-owned, not Node\'s marker', () => {
    assert.strictEqual(WORKTREE_GUARD_SIGNAL, ENV_ALLOW_WORKTREE_ISSUE_MISMATCH);
    assert.notStrictEqual(WORKTREE_GUARD_SIGNAL, ENV_NODE_TEST_CONTEXT);
  });

  test('TRS2: the documented signal executes the probe', () => {
    const run = runProbe({ [WORKTREE_GUARD_SIGNAL]: '1' });
    assert.strictEqual(run.status, 0, run.output);
    assert.ok(run.tests !== null && run.tests > 0, `expected tests > 0, got:\n${run.output}`);
  });

  test('TRS3: the legacy test-mode alias still executes the probe', () => {
    const run = runProbe({ [ENV_NODE_ENV]: ENV_NODE_VALUE_TEST });
    assert.strictEqual(run.status, 0, run.output);
    assert.ok(run.tests !== null && run.tests > 0, `expected tests > 0, got:\n${run.output}`);
  });
});
