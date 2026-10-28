/**
 * agyloop - `sync` fails CLOSED when an issue cannot be read (#328)
 *
 * The defect this file pins: `gh issue view` failed (HTTP 502), the gateway
 * mapped the failure to `state: 'UNKNOWN'`, `sync` guarded on
 * `state !== 'CLOSED'`, and the issue was CLOSED and publicly COMMENTED ON
 * while the run printed `✓ Successfully synced` and exited 0.
 *
 * The harness installs a FAKE `gh` first on `PATH` in an isolated sandbox. It
 * records the argv it receives; nothing reaches GitHub.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const POSIX_ONLY = process.platform === 'win32' ? { skip: 'POSIX-only test' } : {};

const ROOT = path.resolve(__dirname, '..', '..');

const OPEN_ISSUE_PAYLOAD = JSON.stringify({
  number: 306,
  title: 't',
  body: '',
  state: 'OPEN',
  labels: [],
  comments: []
});

interface Sandbox {
  readonly dir: string;
  readonly repo: string;
  readonly binDir: string;
  readonly home: string;
  readonly logPath: string;
}

/**
 * Builds a throwaway repo on `phase/test` with a bare `origin`, plus a fake
 * `gh` that answers merged PRs and (per `mode`) refuses or serves the issue.
 */
function makeSandbox(mode: 'fail' | 'open'): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-sync-failclosed-'));
  const repo = path.join(dir, 'repo');
  const binDir = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const logPath = path.join(dir, 'gh.log');

  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const git = (args: string[], cwd = repo): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  };

  git(['init', '-q']);
  git(['checkout', '-q', '-b', 'phase/test']);
  git(['config', 'user.email', 'smoke@test']);
  git(['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'probe\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'chore: probe']);
  git(['init', '-q', '--bare', path.join(dir, 'origin.git')], dir);
  git(['remote', 'add', 'origin', path.join(dir, 'origin.git')]);
  git(['push', '-qu', 'origin', 'phase/test']);

  const issueAnswer =
    mode === 'fail'
      ? "echo 'HTTP 502: Bad Gateway' >&2; exit 1 ;;"
      : `printf '%s' '${OPEN_ISSUE_PAYLOAD}' ;;`;

  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "$GH_CALL_LOG"`,
      'case "$*" in',
      '  "pr list"*) printf \'%s\' \'[{"number":901,"title":"x","body":"Closes #306"}]\' ;;',
      '  "pr view"*) printf \'%s\\n\' \'src/feature.ts\' ;;',
      `  *"issue view"*) ${issueAnswer}`,
      '  *) exit 0 ;;',
      'esac',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(ghPath, 0o755);

  return { dir, repo, binDir, home, logPath };
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ghCalls: string[];
}

function runSync(sandbox: Sandbox, args: string[]): RunResult {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'codeloop.js'), 'sync', ...args], {
    cwd: sandbox.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: sandbox.home,
      GH_CALL_LOG: sandbox.logPath,
      AGY_SUBAGENT: ''
    }
  });

  const ghCalls = fs.existsSync(sandbox.logPath)
    ? fs.readFileSync(sandbox.logPath, 'utf8').split('\n').filter(Boolean)
    : [];

  return {
    status: res.status === null ? -1 : res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    ghCalls
  };
}

function cleanup(sandbox: Sandbox): void {
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
}

describe('sync fails closed on an unreadable issue (#328)', () => {
  /**
   * AC-328.1/2/3/4: the regression. On the baseline this closed and commented
   * on #306 and exited 0.
   */
  test('an unreadable issue is neither closed nor commented and exits non-zero', POSIX_ONLY, () => {
    const sandbox = makeSandbox('fail');
    try {
      const result = runSync(sandbox, []);

      assert.notStrictEqual(result.status, 0, `sync must fail: ${result.stdout}\n${result.stderr}`);
      assert.ok(
        !(result.stdout + result.stderr).includes('Successfully synced'),
        `the run must not claim success: ${result.stdout}\n${result.stderr}`
      );
      assert.ok(
        !result.ghCalls.some((call) => call.startsWith('issue close')),
        `an unreadable issue must never be closed: ${result.ghCalls.join('\n')}`
      );
      assert.ok(
        !result.ghCalls.some((call) => call.startsWith('issue comment')),
        `an unreadable issue must never be commented on: ${result.ghCalls.join('\n')}`
      );
      assert.ok(
        result.stdout.includes('Skipped #306: unreadable'),
        `the log must name the unreadable issue: ${result.stdout}`
      );
      assert.ok(result.stderr.includes('#306'), `a warning must name #306: ${result.stderr}`);
    } finally {
      cleanup(sandbox);
    }
  });

  /** AC-328.5: the negative control — the working case must still work. */
  test('a readable open issue is closed and commented exactly once', POSIX_ONLY, () => {
    const sandbox = makeSandbox('open');
    try {
      const result = runSync(sandbox, []);

      assert.strictEqual(result.status, 0, `sync must succeed: ${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.includes('Successfully synced'), result.stdout);
      const closes = result.ghCalls.filter((call) => /^issue close 306\b/.test(call));
      const comments = result.ghCalls.filter((call) => /^issue comment 306\b/.test(call));
      assert.strictEqual(closes.length, 1, `expected one issue close: ${result.ghCalls.join('\n')}`);
      assert.strictEqual(comments.length, 1, `expected one issue comment: ${result.ghCalls.join('\n')}`);
      assert.ok(comments[0].includes('Closes #306'), comments[0]);
      assert.ok(comments[0].includes('`phase/test`'), comments[0]);
    } finally {
      cleanup(sandbox);
    }
  });

  /** AC-328.6: a dry run forecasts the write and performs none. */
  test('dry run lists the write it would perform', POSIX_ONLY, () => {
    const sandbox = makeSandbox('open');
    try {
      const result = runSync(sandbox, ['--dry-run']);

      assert.strictEqual(result.status, 0, `a readable forecast must exit 0: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('Would close issue #306'),
        `the dry run must list the write: ${result.stdout}`
      );
      assert.ok(
        result.ghCalls.some((call) => call.startsWith('pr list')),
        'the dry run must still read the merged PRs'
      );
      assert.ok(
        !result.ghCalls.some((call) => call.startsWith('issue close')),
        `dry run closed an issue: ${result.ghCalls.join('\n')}`
      );
      assert.ok(
        !result.ghCalls.some((call) => call.startsWith('issue comment')),
        `dry run commented on an issue: ${result.ghCalls.join('\n')}`
      );
    } finally {
      cleanup(sandbox);
    }
  });
});
