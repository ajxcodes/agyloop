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
 * Issue #315 (AC-20) rewrote the duration test to walk the PRODUCTION
 * REVIEW→COMMIT sequence: the checkpoint is seeded at REVIEW, the verdict is
 * recorded through `codeloop review`, and the assertion reads the pause the
 * tool actually wrote — no seeded `pausedAtGate: 'COMMIT'` precondition, which
 * was a state production never created.
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

function makeSandbox(baseBranch: string, options: { gitignore?: boolean } = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-commit-output-'));
  const git = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  git(['init', '-q']);
  git(['config', 'user.email', 'smoke@test']);
  git(['config', 'user.name', 'smoke']);
  if (options.gitignore !== false) {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.agyloop/\nartifacts/\n.bin/\n.plan-tmp/\n', 'utf8');
  }
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
  // Issue #315 (AC-20): the checkpoint is seeded at REVIEW — the stage a real
  // run is in when the reviewer's verdict is recorded — and NOT with a
  // `pausedAtGate: 'COMMIT'` precondition. The COMMIT pause is produced by
  // walking the production sequence (`runReviewToCommit`).
  fs.writeFileSync(
    path.join(tasksDir, `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'REVIEW',
        mode: 'standard',
        issue: ISSUE,
        baseBranch,
        planDir: `artifacts/plans/${ISSUE}-smoke`,
        createdAt: new Date(now - 1_800_000).toISOString(),
        updatedAt: new Date(now).toISOString(),
        history: [{ stage: 'REVIEW', timestamp: new Date(now - 3_000).toISOString() }],
        worktree: {
          taskId: ISSUE,
          worktreePath: dir,
          branch: `task/${ISSUE}`,
          baseBranch,
          isIsolated: false
        },
        pausedAtGate: null,
        pausedAtTimestamp: null,
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

/**
 * Issue #351: the pipeline's OWN recommended invocation. The issue comes from
 * the checkpoint, not from `--issue` — exactly the #350 run that printed no
 * caveat.
 */
function runCommitWithoutIssue(sandbox: Sandbox, extraArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'bin', 'codeloop.js'),
      'commit',
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

const APPROVED_VERDICT = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

/**
 * A CLEAN Tier 1 report. `--critique-report` is supplied so the review is
 * hermetic: the critique CLI is never resolved or executed, and the verdict
 * cannot be escalated.
 */
const CLEAN_CRITIQUE = {
  summary: 'Clean automated review',
  confidenceLevel: 'High',
  confidenceExplanation: 'diff verified',
  comments: []
};

/**
 * Walks the PRODUCTION review→commit sequence (issue #315, AC-20): records an
 * APPROVED reviewer verdict through `codeloop review`, which must leave the
 * checkpoint at COMMIT **with a recorded pause** — no seeded precondition.
 */
function runReviewToCommit(sandbox: Sandbox) {
  const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-commit-review-input-'));
  try {
    const verdictPath = path.join(inputDir, 'verdict.md');
    const critiquePath = path.join(inputDir, 'critique.json');
    fs.writeFileSync(verdictPath, APPROVED_VERDICT, 'utf8');
    fs.writeFileSync(critiquePath, JSON.stringify(CLEAN_CRITIQUE), 'utf8');
    return spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'bin', 'codeloop.js'),
        'review',
        '--issue',
        String(ISSUE),
        '--verdict-file',
        verdictPath,
        '--critique-report',
        critiquePath
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
  } finally {
    fs.rmSync(inputDir, { recursive: true, force: true });
  }
}

function readCheckpoint(sandbox: Sandbox): any {
  return JSON.parse(
    fs.readFileSync(path.join(sandbox.dir, '.agyloop', 'tasks', `${ISSUE}.json`), 'utf8')
  );
}


/** Moves the fake `gh` outside the repo so it is never an untracked change. */
function externaliseBin(sandbox: Sandbox): { sandbox: Sandbox; binDir: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-commit-bin-'));
  fs.copyFileSync(path.join(sandbox.binDir, 'gh'), path.join(binDir, 'gh'));
  fs.chmodSync(path.join(binDir, 'gh'), 0o755);
  fs.rmSync(path.join(sandbox.dir, '.bin'), { recursive: true, force: true });
  return { sandbox: { ...sandbox, binDir }, binDir };
}

describe('commit output accuracy (issue #284)', () => {
  test('--create-pr reports the created URL and never prints the manual script', () => {
    const sandbox = makeSandbox('phase/6-smoke');
    try {
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);
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

  test('commit without --create-pr prints one gh command and warns the run is not delivered (issue #315, AC-25)', () => {
    const sandbox = makeSandbox('main');
    try {
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);

      const run = runCommit(sandbox);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);

      const ghLines = run.stdout
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.startsWith('gh pr create'));
      assert.strictEqual(
        ghLines.length,
        1,
        `exactly one copy-pasteable command expected, got:\n${output}`
      );
      assert.ok(!ghLines[0].includes('git stash'), ghLines[0]);
      assert.ok(!ghLines[0].includes('if !'), ghLines[0]);

      // The warning is the point: a pushed branch is not a delivered run.
      assert.match(output, /pushed but NOT delivered/i);

      const ghCalls = fs
        .readFileSync(sandbox.ghLog, 'utf8')
        .split('\n')
        .filter((line: string) => line.includes('pr create'));
      assert.strictEqual(ghCalls.length, 0, `no PR may be created without the flag: ${ghCalls.join('\n')}`);

      const persisted = readCheckpoint(sandbox);
      assert.strictEqual(persisted.currentStage, 'COMPLETED');
      assert.deepStrictEqual(persisted.pullRequest, {
        number: null,
        url: null,
        status: 'missing'
      });
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });

  test('the collector-base caveat names the branch, the keyword and `codeloop sync`', () => {
    const sandbox = makeSandbox('phase/6-smoke');
    try {
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);
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

  test('the collector-base caveat fires with NO --issue flag (issue #351)', () => {
    const sandbox = makeSandbox('phase/6-smoke');
    try {
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);

      // THE #350 INVOCATION: no `--issue`, no `--create-pr`-less shortcut. The
      // issue comes from the checkpoint, which is the pipeline's own
      // recommended path — and it used to suppress the caveat entirely.
      const run = runCommitWithoutIssue(sandbox, ['--create-pr']);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);

      assert.ok(
        output.includes(
          "⚠ Closing keyword caveat: this PR targets the collector branch 'phase/6-smoke'."
        ),
        `the caveat must fire without --issue, got:\n${output}`
      );
      assert.ok(
        output.includes(
          `\`Closes #${ISSUE}\` will not auto-close the issue on merge. Run \`codeloop sync\` after the merge to close it.`
        ),
        `the caveat must name the keyword and the compensator, got:\n${output}`
      );

      // The caveat is about the REAL body: the PR the tool created carries the
      // same `Closes #N` it warns about.
      const ghCalls = fs
        .readFileSync(sandbox.ghLog, 'utf8')
        .split('\n')
        .filter((line: string) => line.includes('pr create'));
      assert.strictEqual(ghCalls.length, 1, `exactly one PR creation expected, got: ${JSON.stringify(ghCalls)}`);
      assert.ok(
        ghCalls[0].includes(`Closes #${ISSUE}`),
        `the caveat's issue and the body's keyword must be the same operand, got: ${ghCalls[0]}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });

  test('no caveat is printed for a default-branch base', () => {
    const sandbox = makeSandbox('main');
    try {
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);
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
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);
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

  test('the completed summary carries the measured commit-gate wait, no PENDING, and the real subject once', async () => {
    const sandbox = makeSandbox('phase/6-smoke');
    try {
      // The PRODUCTION sequence: REVIEW --(APPROVED)--> COMMIT (paused).
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);

      const atCommit = readCheckpoint(sandbox);
      assert.strictEqual(atCommit.currentStage, 'COMMIT');
      assert.strictEqual(
        atCommit.pausedAtGate,
        'COMMIT',
        'the standard REVIEW→COMMIT path must record the confirmation pause'
      );
      assert.ok(atCommit.pausedAtTimestamp, 'the pause must be timestamped');
      const pausedAtMs = Date.parse(atCommit.pausedAtTimestamp);
      assert.ok(Number.isFinite(pausedAtMs), atCommit.pausedAtTimestamp);
      assert.strictEqual(atCommit.totalHumanWaitMs, 0, 'the wait is banked at the gate exit');

      // A measurable wait: the gate row is rounded to whole seconds.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const deltaMs = Date.now() - pausedAtMs;

      const run = runCommit(sandbox, ['--create-pr']);
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);

      const summary = fs.readFileSync(sandbox.summaryPath, 'utf8');
      assert.ok(!summary.includes('PENDING'), `no PENDING may survive a completed run, got:\n${summary}`);

      const row = summary.split('\n').find((line: string) => line.startsWith('| 6. Commit Gate |'));
      assert.ok(row, `the Commit Gate row must exist, got:\n${summary}`);
      assert.match(
        row as string,
        /^\| 6\. Commit Gate \| Human Gate \| - \| COMPLETED \| (?:\d+m )?\d+s \|$/,
        `the row must be terminal with a measured duration, got: ${row}`
      );
      // The row is the MEASURED confirmation wait, not a constant and not `0s`.
      const measured = /(?:(\d+)m )?(\d+)s/.exec(row as string);
      assert.ok(measured, `the duration must be readable, got: ${row}`);
      const measuredMs = Number(measured![1] ?? 0) * 60_000 + Number(measured![2]) * 1000;
      assert.ok(measuredMs > 0, `the commit gate wait must be non-zero, got ${measuredMs}ms (${row})`);
      // Rounding to the nearest second tolerates <1s of drift either way.
      assert.ok(
        measuredMs >= deltaMs - 1_000 && measuredMs <= deltaMs + 2_000,
        `the duration must match the real confirmation delta (${deltaMs}ms), got ${measuredMs}ms (${row})`
      );

      const persisted = readCheckpoint(sandbox);
      assert.strictEqual(persisted.currentStage, 'COMPLETED');
      assert.ok(
        persisted.totalHumanWaitMs > 0,
        `totalHumanWaitMs must include the confirmation wait, got ${persisted.totalHumanWaitMs}`
      );
      assert.ok(
        persisted.totalHumanWaitMs >= measuredMs - 1_000,
        `totalHumanWaitMs (${persisted.totalHumanWaitMs}) must bank the row's ${measuredMs}ms`
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

/**
 * Issue #301 (absorbing #319) — the printed list equals the committed list.
 *
 * A workspace WITHOUT a `.gitignore` makes `.agyloop`/`artifacts` untracked.
 * The draft and the commit share ONE exclusion list, so those paths are never
 * listed and never committed; a tree containing nothing else fails honestly.
 */
describe('commit exclusions and root-scoped execution (#301)', () => {
  const gitOut = (dir: string, args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  test('N-31 / AC-9: the printed list equals the committed paths without a .gitignore', () => {
    const external = externaliseBin(makeSandbox('main', { gitignore: false }));
    const sandbox = external.sandbox;
    try {
      // Leave exactly ONE real change: the bookkeeping trees stay untracked.
      execFileSync('git', ['checkout', '--', 'README.md'], {
        cwd: sandbox.dir,
        stdio: 'ignore'
      });
      fs.rmSync(path.join(sandbox.dir, 'tests', 'new.test.ts'), { force: true });
      fs.writeFileSync(path.join(sandbox.dir, 'feature.txt'), 'feature\n', 'utf8');

      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);

      const run = runCommit(sandbox, ['--create-pr']);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);

      assert.ok(output.includes('Files to commit (1):'), output);
      assert.ok(output.includes('- feature.txt'), output);
      assert.ok(
        !output.includes('- .agyloop') && !output.includes('- artifacts'),
        `excluded paths must never be listed:\n${output}`
      );
      assert.ok(output.includes('excluded from the commit: .agyloop, node_modules, artifacts'), output);

      const committed = gitOut(sandbox.dir, ['show', '--name-only', '--pretty=format:', 'HEAD'])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort();
      assert.deepStrictEqual(committed, ['feature.txt']);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
      fs.rmSync(external.binDir, { recursive: true, force: true });
    }
  });

  test('N-32 / AC-9: a tree with only bookkeeping paths fails honestly and moves no HEAD', () => {
    const external = externaliseBin(makeSandbox('main', { gitignore: false }));
    const sandbox = external.sandbox;
    try {
      // Remove every real change; `.agyloop` and `artifacts` are untracked.
      execFileSync('git', ['checkout', '--', 'README.md'], {
        cwd: sandbox.dir,
        stdio: 'ignore'
      });
      fs.rmSync(path.join(sandbox.dir, 'tests', 'new.test.ts'), { force: true });
      // Walk the production path to COMMIT first; the checkpoint must sit at
      // the gate (paused) before `commit` can run at all.
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);
      const before = gitOut(sandbox.dir, ['rev-parse', 'HEAD']).trim();

      const run = runCommit(sandbox);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.status, 1, output);
      assert.match(output, /only paths agyloop excludes/);
      assert.ok(output.includes('.agyloop'), output);
      assert.strictEqual(gitOut(sandbox.dir, ['rev-parse', 'HEAD']).trim(), before, 'HEAD must not move');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
      fs.rmSync(external.binDir, { recursive: true, force: true });
    }
  });

  test('N-33 / AC-8 + AC-10: a descriptor-less COMMIT commits from the workspace root', () => {
    const sandbox = makeSandbox('main');
    try {
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);
      // Issue #307: `worktree: null` is a legal root-scoped run.
      const statePath = path.join(sandbox.dir, '.agyloop', 'tasks', `${ISSUE}.json`);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.worktree = null;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
      const before = gitOut(sandbox.dir, ['rev-parse', 'HEAD']).trim();

      const run = runCommit(sandbox);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.status, 0, output);
      assert.ok(output.includes('Committed in:'), output);
      assert.ok(output.includes('workspace root'), output);
      assert.notStrictEqual(gitOut(sandbox.dir, ['rev-parse', 'HEAD']).trim(), before, 'HEAD must advance');

      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.strictEqual(persisted.currentStage, 'COMPLETED');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #382 (D1, was #360) — the commit gate's warning follows the FINAL
 * message.
 *
 * The plan's analysis flag survived an operator override, so `--message-file`
 * with a non-breaking message still printed `⚠️ BREAKING CHANGE detected!`
 * directly under the non-breaking subject it had just printed. All three runs
 * are `--dry-run`: nothing is committed.
 */
describe('the breaking-change warning reflects the final message (#382)', () => {
  const SUBJECT = `docs: probe subject (#${ISSUE})`;

  test('CLI-COMMIT-1: plan flag, non-breaking override, then a breaking override', () => {
    const sandbox = makeSandbox('main');
    try {
      const review = runReviewToCommit(sandbox);
      assert.strictEqual(review.status, 0, `${review.stdout}\n${review.stderr}`);

      // A tracked line whose ADDED content carries the token: the plan really
      // is breaking, so (a) must warn.
      fs.appendFileSync(
        path.join(sandbox.dir, 'README.md'),
        'BREAKING CHANGE: probe footer\n',
        'utf8'
      );
      const before = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sandbox.dir,
        encoding: 'utf8'
      }).trim();

      const defaultRun = runCommit(sandbox, ['--dry-run']);
      const defaultOut = `${defaultRun.stdout}\n${defaultRun.stderr}`;
      assert.strictEqual(defaultRun.status, 0, defaultOut);
      assert.ok(defaultOut.includes('BREAKING CHANGE detected'), defaultOut);

      const safeMessage = path.join(sandbox.dir, 'msg-safe.md');
      fs.writeFileSync(safeMessage, `${SUBJECT}\n`, 'utf8');
      const safeRun = runCommit(sandbox, ['--dry-run', '--message-file', safeMessage]);
      const safeOut = `${safeRun.stdout}\n${safeRun.stderr}`;
      assert.strictEqual(safeRun.status, 0, safeOut);
      assert.ok(
        !safeOut.includes('BREAKING CHANGE detected'),
        `a non-breaking override must silence the warning, got:\n${safeOut}`
      );
      assert.ok(safeOut.includes(SUBJECT), safeOut);

      const breakingMessage = path.join(sandbox.dir, 'msg-breaking.md');
      fs.writeFileSync(breakingMessage, `${SUBJECT}\n\nBREAKING CHANGE: real footer\n`, 'utf8');
      const breakingRun = runCommit(sandbox, ['--dry-run', '--message-file', breakingMessage]);
      const breakingOut = `${breakingRun.stdout}\n${breakingRun.stderr}`;
      assert.strictEqual(breakingRun.status, 0, breakingOut);
      assert.ok(breakingOut.includes('BREAKING CHANGE detected'), breakingOut);

      const after = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sandbox.dir,
        encoding: 'utf8'
      }).trim();
      assert.strictEqual(after, before, 'all three runs are --dry-run: HEAD must not move');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(`${sandbox.dir}.origin.git`, { recursive: true, force: true });
    }
  });
});
