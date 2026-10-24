/**
 * agyloop - `codeloop triage` disposition output Tests (issue #269, Defect 1)
 *
 * The TRIAGE gate re-opens on every read while the pull request is open, so
 * the operator must be told (a) whether a disposition was recorded and (b)
 * WHAT ends the loop.
 *
 * P1 - the output names the recorded disposition
 * P2 - the output states the exit condition
 * P3 - with no feedback readable, the output says the disposition was NOT recorded
 *
 * Harness: a fake `gh` on PATH (no network, no real PR) that answers the two
 * API calls the tool makes, plus a scratch git repository whose `origin` remote
 * names the `owner/repo` the fake answers for.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const {
  EXIT_CODE_SUCCESS,
  NOTE_TRIAGE_GATE_EXIT_CONDITION,
  NOTE_TRIAGE_DISPOSITION_NOT_RECORDED,
  LABEL_TRIAGE_DISPOSITION
} = require('../../dist/domain');

const ISSUE = 900;
const PR = 7;

const ACTIONABLE_COMMENT = {
  id: 101,
  user: { login: 'reviewer' },
  body: 'Please fix the nil dereference in resolve-subagent.ts',
  created_at: '2026-10-21T11:00:00Z'
};

const SUMMARY_COMMENT = {
  id: 102,
  user: { login: 'github-actions[bot]' },
  body: '## Critique AI Review Run Summary\n\nNo findings.',
  created_at: '2026-10-21T11:30:00Z'
};

/**
 * The fake `gh`. It answers:
 *   gh pr list --search <n> ...                    -> the OPEN PR
 *   gh api repos/owner/repo/issues/<n>/comments    -> the comments in $FAKE_GH_COMMENTS
 *   gh api repos/owner/repo/pulls/<n>/reviews      -> []
 *   gh api repos/owner/repo/pulls/<n>/comments     -> []
 */
const FAKE_GH = `#!/bin/sh
set -u
args="$*"
case "$args" in
  *"pr list"*)
    cat <<'JSON'
[{"number":7,"title":"Task #900","body":"Delivers #900","state":"OPEN","baseRefName":"main","headRefName":"task/900","url":"https://example.invalid/pr/7","mergedAt":null,"labels":[]}]
JSON
    ;;
  *"/issues/7/comments"*) cat "\${FAKE_GH_COMMENTS:?}" ;;
  *) echo "[]" ;;
esac
`;

interface Sandbox {
  readonly dir: string;
  readonly binDir: string;
}

function makeSandbox(comments: unknown[] | null): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-triage-disposition-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });

  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], {
    cwd: dir,
    stdio: 'ignore'
  });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });

  // The fake `gh` is only installed when the case needs one.
  if (comments !== null) {
    fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, 'utf8');
    fs.chmodSync(path.join(binDir, 'gh'), 0o755);
    fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify(comments), 'utf8');
  }

  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(tasksDir, `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'TRIAGE',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'TRIAGE', timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null
      },
      null,
      2
    ),
    'utf8'
  );

  return { dir, binDir };
}

async function runTriage(
  sandbox: Sandbox,
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGY_SUBAGENT: process.env.AGY_SUBAGENT,
    FAKE_GH_COMMENTS: process.env.FAKE_GH_COMMENTS
  };
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';

  try {
    process.chdir(sandbox.dir);
    process.env.PATH = `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.HOME = path.join(sandbox.dir, '.home');
    // The triage ROUTING action is a subagent-only operation by design.
    process.env.AGY_SUBAGENT = '1';
    process.env.FAKE_GH_COMMENTS = path.join(sandbox.dir, 'comments.json');

    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('codeloop triage disposition output (issue #269)', () => {
  test('P1/P2: the output names the recorded disposition and the exit condition', async () => {
    const sandbox = makeSandbox([ACTIONABLE_COMMENT, SUMMARY_COMMENT]);
    try {
      const run = await runTriage(sandbox, ['triage', 'completed', '--issue', String(ISSUE)]);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);
      assert.ok(
        output.includes(`${LABEL_TRIAGE_DISPOSITION} : recorded`),
        `the disposition line must be present, got:\n${output}`
      );
      assert.ok(
        output.includes(`PR #${PR}`),
        `the disposition line must name the PR, got:\n${output}`
      );
      assert.ok(
        output.includes('action=COMPLETED'),
        `the disposition line must name the action, got:\n${output}`
      );
      assert.ok(
        output.includes('1 feedback item(s)'),
        `the disposition line must name the actionable item count (the automated summary is not feedback), got:\n${output}`
      );

      assert.ok(
        output.includes(NOTE_TRIAGE_GATE_EXIT_CONDITION),
        `the exit condition must be stated, got:\n${output}`
      );
      assert.ok(
        output.includes('merged/closed'),
        `the exit condition must name the PR being merged/closed, got:\n${output}`
      );

      // The checkpoint carries the disposition.
      const checkpoint = JSON.parse(
        fs.readFileSync(path.join(sandbox.dir, '.agyloop', 'tasks', `${ISSUE}.json`), 'utf8')
      );
      assert.ok(checkpoint.triageDisposition, 'the checkpoint must carry the disposition');
      assert.strictEqual(checkpoint.triageDisposition.prNumber, PR);
      assert.strictEqual(checkpoint.triageDisposition.action, 'completed');
      assert.deepStrictEqual([...checkpoint.triageDisposition.feedbackKeys], ['id:101']);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P3: with no feedback readable the output says the disposition was NOT recorded', async () => {
    // No fake `gh` at all: the PR (and therefore the feedback) cannot be read.
    const sandbox = makeSandbox(null);
    try {
      const run = await runTriage(sandbox, ['triage', 'completed', '--issue', String(ISSUE)]);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);
      assert.ok(
        output.includes(`${LABEL_TRIAGE_DISPOSITION} : `),
        `the disposition line must be present, got:\n${output}`
      );
      assert.ok(
        output.includes(NOTE_TRIAGE_DISPOSITION_NOT_RECORDED),
        `the output must say the disposition was not recorded, got:\n${output}`
      );

      const checkpoint = JSON.parse(
        fs.readFileSync(path.join(sandbox.dir, '.agyloop', 'tasks', `${ISSUE}.json`), 'utf8')
      );
      assert.strictEqual(
        checkpoint.triageDisposition,
        null,
        'no disposition may be recorded when no feedback could be read'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
