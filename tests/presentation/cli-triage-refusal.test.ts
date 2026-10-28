/**
 * agyloop - CLI TRIAGE refusal tests (issue #336)
 *
 * On build a3f1740, `codeloop triage dismiss` with no `-m` printed
 * `✓ State Updated : Pipeline transitioned to COMPLETED` and recorded a
 * disposition although the stub `gh` log held only GETs. These cases pin the
 * opposite: a refusal is a NON-write, a non-zero exit and a truthful report.
 *
 * R1/R2 - a bare dismiss is refused: exit 1, no POST, checkpoint untouched
 * R3/R4 - the dry run predicts the same refusal instead of promising a dismissal
 * R5    - `completed` still advances and still records (the refusal is scoped)
 * R6    - a dismissal whose only write FAILED records nothing and stays at TRIAGE
 *
 * Harness: a fake `gh` on PATH that logs every mutating invocation to
 * `$FAKE_GH_LOG`; a scratch git repository whose `origin` names the repo.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS, DISMISS_OUTCOME_REFUSED } = require('../../dist/domain');

const ISSUE = 336;
const PR = 9001;

const ACTIONABLE_COMMENT = {
  id: 111111,
  user: { login: 'reviewer' },
  body: '[error] Fix the nil dereference in triage.ts',
  created_at: '2026-10-28T05:00:00Z'
};

/**
 * The fake `gh`.
 *
 * GET routes answer from fixtures; every MUTATION (`query=mutation...` or
 * `--method POST`) appends its argv to `$FAKE_GH_LOG` so the test can prove
 * whether the tool tried to write. `$FAKE_GH_FAIL_POST=1` makes the write fail.
 */
const FAKE_GH = `#!/bin/sh
set -u
args="$*"
case "$args" in
  *"query=mutation"*|*"--method POST"*)
    echo "$args" >> "\${FAKE_GH_LOG:?}"
    if [ "\${FAKE_GH_FAIL_POST:-0}" = "1" ]; then
      echo "gh: secondary rate limit" >&2
      exit 1
    fi
    echo '{"data":{}}'
    exit 0
    ;;
  *"pr list"*)
    cat <<'JSON'
[{"number":9001,"title":"Task #336","body":"Delivers #336","state":"OPEN","baseRefName":"main","headRefName":"task/336","url":"https://example.invalid/pr/9001","mergedAt":null,"labels":[]}]
JSON
    ;;
  *"/issues/9001/comments"*) cat "\${FAKE_GH_COMMENTS:?}" ;;
  *"api graphql"*)
    echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
    ;;
  *) echo "[]" ;;
esac
`;

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-triage-refusal-'));
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

  fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, 'utf8');
  fs.chmodSync(path.join(binDir, 'gh'), 0o755);
  fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([ACTIONABLE_COMMENT]), 'utf8');
  // Pre-created and empty: a GET-only run must leave it empty.
  fs.writeFileSync(path.join(dir, 'gh.log'), '', 'utf8');

  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  const checkpointPath = path.join(tasksDir, `${ISSUE}.json`);
  fs.writeFileSync(
    checkpointPath,
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
  fs.writeFileSync(path.join(dir, 'checkpoint.before.json'), fs.readFileSync(checkpointPath));

  return { dir, binDir, checkpointPath };
}

async function runTriage(
  sandbox: ReturnType<typeof makeSandbox>,
  args: readonly string[],
  env: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGY_SUBAGENT: process.env.AGY_SUBAGENT,
    FAKE_GH_COMMENTS: process.env.FAKE_GH_COMMENTS,
    FAKE_GH_LOG: process.env.FAKE_GH_LOG,
    FAKE_GH_FAIL_POST: process.env.FAKE_GH_FAIL_POST
  };
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';

  try {
    process.chdir(sandbox.dir);
    process.env.PATH = `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.HOME = path.join(sandbox.dir, '.home');
    process.env.AGY_SUBAGENT = '1';
    process.env.FAKE_GH_COMMENTS = path.join(sandbox.dir, 'comments.json');
    process.env.FAKE_GH_LOG = path.join(sandbox.dir, 'gh.log');
    delete process.env.FAKE_GH_FAIL_POST;
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }

    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    const code = await runCli([...args]);
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

function ghLog(sandbox: ReturnType<typeof makeSandbox>): string {
  return fs.readFileSync(path.join(sandbox.dir, 'gh.log'), 'utf8');
}

function checkpoint(sandbox: ReturnType<typeof makeSandbox>): any {
  return JSON.parse(fs.readFileSync(sandbox.checkpointPath, 'utf8'));
}

describe('codeloop triage dismissal refusal (issue #336)', () => {
  test('R1 (AC-1): a bare dismiss exits 1, posts nothing and writes no checkpoint', async () => {
    const sandbox = makeSandbox();
    const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');
    try {
      const run = await runTriage(sandbox, ['triage', 'dismiss', '--issue', String(ISSUE)]);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.code, 1, `a refusal must exit 1:\n${output}`);
      assert.ok(
        output.includes(DISMISS_OUTCOME_REFUSED),
        `the report must say DISMISS (REFUSED):\n${output}`
      );
      assert.ok(output.includes('-m "<notes>"'), `the report must name -m "<notes>":\n${output}`);
      assert.ok(!output.includes('✓ State Updated'), `no transition may be claimed:\n${output}`);
      assert.ok(
        !output.includes('✓ Triage Action : DISMISS'),
        `no success line may be printed:\n${output}`
      );
      assert.strictEqual(ghLog(sandbox), '', 'no reply/resolve POST may be attempted');

      assert.strictEqual(
        fs.readFileSync(sandbox.checkpointPath, 'utf8'),
        before,
        'the checkpoint must be byte-identical'
      );
      const after = checkpoint(sandbox);
      assert.strictEqual(after.currentStage, 'TRIAGE');
      assert.ok(!after.triageDisposition, 'a refused dismissal must record no disposition');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('R2 (AC-1): the refusal --json document reports failure and no write', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await runTriage(sandbox, [
        'triage',
        'dismiss',
        '--issue',
        String(ISSUE),
        '--json'
      ]);
      const payload = JSON.parse(run.stdout);

      assert.strictEqual(run.code, 1);
      assert.strictEqual(payload.success, false);
      assert.strictEqual(payload.refused?.cause, 'missing-notes');
      assert.strictEqual(payload.disposition, null);
      assert.strictEqual(payload.dispositionRecorded, false);
      assert.strictEqual(payload.stateUpdated, false);
      assert.strictEqual(payload.targetStage, 'TRIAGE');
      assert.strictEqual(ghLog(sandbox), '', 'no POST may be attempted');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('R3 (AC-3): a dry run without notes predicts the refusal', async () => {
    const sandbox = makeSandbox();
    const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');
    try {
      const run = await runTriage(sandbox, [
        'triage',
        'dismiss',
        '--issue',
        String(ISSUE),
        '--dry-run'
      ]);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.notStrictEqual(run.code, 0, `the prediction must exit non-zero:\n${output}`);
      assert.ok(output.includes('[dry-run]'), `the prediction must be marked [dry-run]:\n${output}`);
      assert.ok(output.includes(DISMISS_OUTCOME_REFUSED), output);
      assert.ok(output.includes('-m "<notes>"'), output);
      assert.ok(
        !output.includes('Would attempt a dismissal'),
        `a refused prediction must not promise an attempt:\n${output}`
      );
      assert.strictEqual(ghLog(sandbox), '', 'a dry run never posts');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('R4 (AC-3): the dry-run --json document carries the refusal', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await runTriage(sandbox, [
        'triage',
        'dismiss',
        '--issue',
        String(ISSUE),
        '--dry-run',
        '--json'
      ]);
      const payload = JSON.parse(run.stdout);

      assert.notStrictEqual(run.code, 0);
      assert.strictEqual(payload.dryRun, true);
      assert.strictEqual(payload.success, false);
      assert.strictEqual(payload.wouldDismiss, false);
      assert.strictEqual(payload.refused?.cause, 'missing-notes');
      assert.strictEqual(payload.disposition, null);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('R5 (AC-2/AC-3 control): triage completed still advances and records', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await runTriage(sandbox, ['triage', 'completed', '--issue', String(ISSUE)]);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, output);
      const after = checkpoint(sandbox);
      assert.strictEqual(after.currentStage, 'COMPLETED');
      assert.strictEqual(after.triageDisposition?.action, 'completed');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('R6 (AC-2): a failed dismissal write records nothing and stays at TRIAGE', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await runTriage(
        sandbox,
        ['triage', 'dismiss', '-m', 'answered', '--issue', String(ISSUE)],
        { FAKE_GH_FAIL_POST: '1' }
      );
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.code, 1, `a wholly failed dismissal must exit 1:\n${output}`);
      assert.ok(ghLog(sandbox).length > 0, 'the attempted write must be logged');
      const after = checkpoint(sandbox);
      assert.strictEqual(after.currentStage, 'TRIAGE');
      assert.ok(!after.triageDisposition, 'a failed dismissal must record no disposition');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
