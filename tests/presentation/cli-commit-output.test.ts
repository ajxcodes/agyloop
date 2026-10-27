/**
 * agyloop - `commit` reports what it did (issue #284: #240 Defect 1/2/3, AC2)
 *
 * The commit gate is the last thing an operator reads before publishing, and
 * every defect here is a message that is WRONG about work that was done:
 *   - it created the PR and still printed the manual `gh pr create` script;
 *   - the file count omitted untracked files the commit actually contained;
 *   - it never said that `Closes #N` cannot auto-close on a collector-base PR;
 *   - and a completed run's summary still read `PENDING`.
 *
 * Full CLI, real git repo, bare `origin`, fake `gh`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ISSUE = 289;
const PR_URL = 'https://example.test/pull/9';

interface Sandbox {
  readonly dir: string;
  readonly binDir: string;
  readonly ghLog: string;
  readonly summaryPath: string;
}

function makeSandbox(baseBranch: string): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-commit-output-'));
  const git = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  git(['init', '-q']);
  git(['config', 'user.email', 'smoke@test']);
  git(['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.agyloop/\nartifacts/\n.bin/\n.plan-tmp/\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'chore: seed']);
  git(['checkout', '-qb', `task/${ISSUE}`]);

  const origin = `${dir}.origin.git`;
  git(['init', '-q', '--bare', origin]);
  git(['remote', 'add', 'origin', origin]);

  const planDir = path.join(dir, 'artifacts', 'plans', `${ISSUE}-smoke`);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, 'implementation_plan.md'),
    '# [Implementation] - Smoke\n\n- [ ] Step 1: probe\n',
    'utf8'
  );
  const summaryPath = path.join(planDir, 'CodeLoop Summary.md');
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', 'summary-log.md'), summaryPath);

  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'new.test.ts'), 'probe\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\ny\n', 'utf8');

  const binDir = path.join(dir, '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  // Outside the repo: a log written INSIDE it would be staged by `git add -A`
  // and then make the PR wrapper's stash dance fail.
  const ghLog = `${dir}.gh-calls.log`;
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$GH_CALL_LOG"',
      'case "$*" in',
      '  *"pr list"*) echo \'[]\' ;;',
      '  *"pr create"*) echo "https://example.test/pull/9" ;;',
      '  *"pr view"*) echo "https://example.test/pull/9" ;;',
      '  *) echo \'\' ;;',
      'esac',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.chmodSync(ghPath, 0o755);

  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(tasksDir, `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'COMMIT',
        mode: 'standard',
        issue: ISSUE,
        baseBranch,
        planDir: `artifacts/plans/${ISSUE}-smoke`,
        createdAt: new Date(now - 1_800_000).toISOString(),
        updatedAt: new Date(now).toISOString(),
        history: [{ stage: 'COMMIT', timestamp: new Date(now - 84_000).toISOString() }],
        worktree: {
          taskId: ISSUE,
          worktreePath: dir,
          branch: `task/${ISSUE}`,
          baseBranch,
          isIsolated: false
        },
        pausedAtGate: 'COMMIT',
        pausedAtTimestamp: new Date(now - 84_000).toISOString(),
        totalHumanWaitMs: 0
      },
      null,
      2
    ),
    'utf8'
  );

  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  return { dir, binDir, ghLog, summaryPath };
}

function runCommit(sandbox: Sandbox, extraArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'bin', 'codeloop.js'),
      'commit',
      '--issue',
      String(ISSUE),
      '-y',
      '--keep-worktree',
      ...extraArgs
    ],
    {
      cwd: sandbox.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH}`,
        HOME: path.join(sandbox.dir, '.home'),
        GH_CALL_LOG: sandbox.ghLog,
        AGY_SUBAGENT: ''
      }
    }
  );
}

describe('commit output accuracy (issue #284)', () => {
  test('--create-pr reports the created URL and never prints the manual script', () => {
    const sandbox = makeSandbox('phase/6-smoke');
    try {
      const run = runCommit(sandbox, ['--create-pr']);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.status, 0, `commit must succeed, got:\n${output}`);
      assert.ok(
        output.includes(`✓ PR created: ${PR_URL}`),
        `the created PR's URL must be reported, got:\n${output}`
      );
      assert.ok(
        !output.includes('Next Step (Create PR)'),
        `the script for completed work must NOT be printed, got:\n${output}`
      );

      const ghCalls = fs
        .readFileSync(sandbox.ghLog, 'utf8')
        .split('\n')
        .filter((line: string) => line.includes('pr create'));
      assert.strictEqual(ghCalls.length, 1, `exactly one PR creation expected, got: ${JSON.stringify(ghCalls)}`);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });

  test('the collector-base caveat names the branch, the keyword and `codeloop sync`', () => {
    const sandbox = makeSandbox('phase/6-smoke');
    try {
      const run = runCommit(sandbox, ['--create-pr']);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.ok(
        output.includes(
          "⚠ Closing keyword caveat: this PR targets the collector branch 'phase/6-smoke'."
        ),
        `the caveat must name the collector branch, got:\n${output}`
      );
      assert.ok(
        output.includes(
          `\`Closes #${ISSUE}\` will not auto-close the issue on merge. Run \`codeloop sync\` after the merge to close it.`
        ),
        `the caveat must name the keyword and the compensator, got:\n${output}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });

  test('no caveat is printed for a default-branch base', () => {
    const sandbox = makeSandbox('main');
    try {
      const run = runCommit(sandbox, ['--create-pr']);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);
      assert.ok(
        !output.includes('Closing keyword caveat'),
        `a main-base PR must not warn, got:\n${output}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });

  test('the uncompressed file list includes the untracked file the commit really contains', () => {
    const sandbox = makeSandbox('phase/6-smoke');
    try {
      const run = runCommit(sandbox, ['--create-pr']);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);

      assert.ok(
        output.includes('Files to commit (2):'),
        `the count must include the untracked file, got:\n${output}`
      );
      assert.ok(
        output.includes('tests/new.test.ts (untracked)'),
        `the untracked file must be marked, got:\n${output}`
      );

      // Count parity: the commit really contains the file it listed.
      const stat = execFileSync('git', ['show', '--stat', 'HEAD'], {
        cwd: sandbox.dir,
        encoding: 'utf8'
      });
      assert.ok(
        stat.includes('tests/new.test.ts'),
        `the listed file must be in the commit, got:\n${stat}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });

  test('the completed summary carries the measured commit-gate wait, no PENDING, and the real subject once', () => {
    const sandbox = makeSandbox('phase/6-smoke');
    try {
      const run = runCommit(sandbox, ['--create-pr']);
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);

      const summary = fs.readFileSync(sandbox.summaryPath, 'utf8');
      assert.ok(!summary.includes('PENDING'), `no PENDING may survive a completed run, got:\n${summary}`);

      const row = summary.split('\n').find((line: string) => line.startsWith('| 6. Commit Gate |'));
      assert.ok(row, `the Commit Gate row must exist, got:\n${summary}`);
      assert.match(
        row as string,
        /^\| 6\. Commit Gate \| Human Gate \| - \| COMPLETED \| \d+m \d+s \|$/,
        `the row must be terminal with a measured duration, got: ${row}`
      );
      // The seeded pause is 84 s; process overhead adds a little. What matters
      // is that the row is the MEASURED wait, not the old `263m 50s` class.
      const measured = /(\d+)m (\d+)s/.exec(row as string);
      assert.ok(measured, `the duration must be readable, got: ${row}`);
      const measuredMs = Number(measured![1]) * 60_000 + Number(measured![2]) * 1000;
      assert.ok(
        measuredMs >= 84_000 && measuredMs < 100_000,
        `the duration must match the seeded 84s pause, got ${measuredMs}ms (${row})`
      );

      const commitMessageLines = summary
        .split('\n')
        .filter((line: string) => line.includes('- **Commit Message:**'));
      assert.strictEqual(
        commitMessageLines.length,
        1,
        `the real subject must appear exactly once, got:\n${summary}`
      );
      assert.ok(
        commitMessageLines[0].includes(`(#${ISSUE})`),
        `the recorded subject must be the real one, got: ${commitMessageLines[0]}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });
});
