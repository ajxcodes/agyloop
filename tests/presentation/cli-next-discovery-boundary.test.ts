/**
 * agyloop - `next` reports a DISCOVERY boundary violation (issue #389, AC3a/c)
 *
 * End-to-end through the CLI: a real git sandbox at DISCOVERY, a real `next`
 * dispatch (which captures the baseline), an ignored `dist/polluted.js` write,
 * and a second read. The check is that the ROOT BUILD change is named in
 * `--json` and in the human-readable directive instead of being invisible to
 * `git status`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 389;

const BLANK_REPORT = [
  '# [Discovery] - probe',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:**',
  '- **Expected Behavior:**',
  '- **Affected Components / Paths:**',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:**',
  '- **Identified Failure Mode:**',
  '- **Relevant Code References:**'
].join('\n');

const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function runIn(dir: string, args: readonly string[]): Promise<any> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(dir);
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function git(dir: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function seedSandbox(): { dir: string; planDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-boundary-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test']);
  git(dir, ['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\nbuild/\nartifacts/\n.agyloop/\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'chore: base']);

  const planDir = path.join(dir, 'artifacts', 'plans', `${ISSUE}-task`);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, '[Discovery] - Task.md'), BLANK_REPORT, 'utf8');

  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'DISCOVERY',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        planDir,
        worktree: null,
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'DISCOVERY', timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0
      },
      null,
      2
    ),
    'utf8'
  );

  return { dir, planDir };
}

describe('`next` reports a root dist rebuild (issue #389)', { skip: !GIT_AVAILABLE }, () => {
  test('C1: --json names the dist finding and stays actionable', async () => {
    const { dir } = seedSandbox();

    const dispatch = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
    assert.strictEqual(dispatch.code, 0, dispatch.stderr);
    const dispatched = JSON.parse(dispatch.stdout);
    assert.strictEqual(dispatched.actionType, 'subagent');
    assert.strictEqual(dispatched.stageFindings, undefined, 'a dispatched read has no finding yet');

    // The uncontained host mutation the guardrail exists to prevent: gitignored,
    // so `git status --porcelain` stays empty.
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'polluted.js'), '// rebuilt\n', 'utf8');
    assert.strictEqual(
      execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(),
      ''
    );

    const after = await runIn(dir, ['next', '--issue', String(ISSUE), '--json']);
    assert.strictEqual(after.code, 0, after.stderr);
    const result = JSON.parse(after.stdout);

    assert.strictEqual(result.actionType, 'subagent');
    assert.strictEqual(result.actionable, true);
    assert.ok(Array.isArray(result.stageFindings), JSON.stringify(result.stageFindings));
    assert.strictEqual(result.stageFindings[0].rule, 'write-outside-scope');
    assert.strictEqual(result.stageFindings[0].path, 'dist/');
    assert.ok(result.description.includes('dist/'), result.description);
    assert.ok(result.humanSummary.includes('root build'), result.humanSummary);
  });

  test('C2: text mode prints the finding', async () => {
    const { dir } = seedSandbox();

    const dispatch = await runIn(dir, ['next', '--issue', String(ISSUE)]);
    assert.strictEqual(dispatch.code, 0, dispatch.stderr);

    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'polluted.js'), '// rebuilt\n', 'utf8');

    const after = await runIn(dir, ['next', '--issue', String(ISSUE)]);
    assert.strictEqual(after.code, 0, after.stderr);
    assert.ok(after.stdout.includes('Findings      : 1'), after.stdout);
    assert.ok(after.stdout.includes('dist/'), after.stdout);
  });
});
