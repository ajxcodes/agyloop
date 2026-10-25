/**
 * agyloop - `codeloop next` with a missing worktree descriptor (issue #266,
 * absorbs #287 B).
 *
 * A checkpoint at IMPLEMENT whose `worktree` is null (the state left behind by
 * a `codeloop worktree remove` during IMPLEMENT) used to raise the Zero Direct
 * Root Mutation invariant and escape as a raw `Fatal:` + stack trace with exit
 * 1. It must instead return a rendered, actionable directive.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation');

const NOW = '2026-10-24T00:00:00.000Z';
const ISSUE = 803;

interface Sandbox {
  readonly base: string;
  readonly dir: string;
}

function makeSandbox(): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-missing-wt-'));
  const dir = path.join(base, 'repo');
  fs.mkdirSync(dir, { recursive: true });

  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });

  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'IMPLEMENT',
        mode: 'standard',
        issue: ISSUE,
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

  return { base, dir };
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

describe('codeloop next with a missing worktree (#266, absorbs #287)', () => {
  test('F1 `next --issue N --json` exits 0 with a directive (AC-10, AC-12)', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await runCliIn(sandbox.dir, ['next', '--issue', String(ISSUE), '--json']);

      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
      const parsed = JSON.parse(run.stdout);
      assert.strictEqual(parsed.actionType, 'human_gate');
      assert.strictEqual(parsed.worktreePath, null);
      assert.strictEqual(parsed.actionable, true);
      assert.strictEqual(parsed.title, 'Worktree Required');
      assert.ok(
        parsed.humanSummary.includes('codeloop implement'),
        `the directive must name the re-provision command:\n${parsed.humanSummary}`
      );
      assert.ok(
        parsed.humanSummary.includes(`--issue ${ISSUE}`),
        `the directive must name the issue:\n${parsed.humanSummary}`
      );
    } finally {
      fs.rmSync(sandbox.base, { recursive: true, force: true });
    }
  });

  test('F2 no `Fatal:` and no stack trace escapes (AC-10)', async () => {
    const sandbox = makeSandbox();
    try {
      for (const args of [
        ['next', '--issue', String(ISSUE), '--json'],
        ['next', '--issue', String(ISSUE)]
      ]) {
        const run = await runCliIn(sandbox.dir, args);
        const combined = run.stdout + run.stderr;
        assert.strictEqual(/Fatal:/.test(combined), false, `${args.join(' ')}:\n${combined}`);
        assert.strictEqual(
          /^\s+at\s+\S+/m.test(combined),
          false,
          `${args.join(' ')} leaked a stack trace:\n${combined}`
        );
      }
    } finally {
      fs.rmSync(sandbox.base, { recursive: true, force: true });
    }
  });

  test('F3 the human renderer names the title and the command (AC-10)', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await runCliIn(sandbox.dir, ['next', '--issue', String(ISSUE)]);

      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stdout.includes('Next Action   : Worktree Required'), run.stdout);
      assert.ok(
        run.stdout.includes(`codeloop implement --issue ${ISSUE}`),
        `the command must be printed:\n${run.stdout}`
      );
    } finally {
      fs.rmSync(sandbox.base, { recursive: true, force: true });
    }
  });
});
