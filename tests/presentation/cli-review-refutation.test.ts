/**
 * agyloop - `codeloop review --refute` (issue #349 AC4, end to end)
 *
 * The incident: critique claimed `actions/checkout@v7` does not exist and
 * demanded a revert to `@v4`. The tag exists, and the sentence genuinely
 * requests a change, so content-aware blocking will never exempt it. The
 * operator says so explicitly, with a reason, and the act is audited.
 *
 * CR1 - a valid refutation records APPROVED and names it on stderr (AC4-S1/S5)
 * CR2 - the same fixture without a refutation still reverts (AC4-S2)
 * CR3 - no reason / empty reason / no value are refused, checkpoint untouched (AC4-S3)
 * CR4 - an unknown target is refused (AC4-S4)
 * CR5 - an ambiguous path:line is refused; #severity narrows it (AC4-S4)
 * CR6 - `--json` carries the audit trail in one document (AC4.4)
 * CR7 - a genuine defect beside a refuted claim still reverts (AC4-S6)
 * CR8 - the flag is scoped to `review` (AC4.3)
 * CR9 - repeatable, and a dry run records nothing
 */

const { describe, test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS, EXIT_CODE_FAILURE } = require('../../dist/domain');

const CRITIQUE_BINARY = 'critique';
const ISSUE = 349;
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

const V7_BODY = 'actions/checkout@v7 does not exist. Revert to @v4.';
const V7_REFUTATION = 'src/app.ts:10=actions/checkout@v7 exists (v7.0.1, published 2026-07-20); verified with gh api';
const V7_REASON = 'actions/checkout@v7 exists (v7.0.1, published 2026-07-20); verified with gh api';

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

let sharedShadow: any = null;

function buildCritiqueFreePathShadow(shadowRoot: string): string {
  fs.mkdirSync(shadowRoot, { recursive: true });
  const seen = new Set();
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shadowEntries = [];
  let idx = 0;

  for (const dir of parts) {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    let entries;
    try {
      entries = fs.readdirSync(real);
    } catch {
      continue;
    }

    const target = path.join(shadowRoot, `d${idx++}`);
    if (!entries.includes(CRITIQUE_BINARY)) {
      try {
        fs.symlinkSync(real, target, 'dir');
        shadowEntries.push(target);
        continue;
      } catch {
        // Fall through to entry-by-entry copies.
      }
    }

    fs.mkdirSync(target, { recursive: true });
    for (const entry of entries) {
      if (entry === CRITIQUE_BINARY || entry.startsWith(`${CRITIQUE_BINARY}.`)) continue;
      try {
        fs.symlinkSync(fs.realpathSync(path.join(real, entry)), path.join(target, entry));
      } catch {
        // Skip entries that cannot be resolved.
      }
    }
    shadowEntries.push(target);
  }

  return shadowEntries.join(path.delimiter);
}

function sharedShadowPath() {
  if (sharedShadow === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-349-refute-shadow-'));
    sharedShadow = { dir, path: buildCritiqueFreePathShadow(path.join(dir, 'bin')) };
  }
  return sharedShadow.path;
}

after(() => {
  if (sharedShadow) {
    fs.rmSync(sharedShadow.dir, { recursive: true, force: true });
  }
});

function checkpointPath(sandbox: string): string {
  return path.join(sandbox, '.agyloop', 'tasks', `${ISSUE}.json`);
}

function seedCheckpoint(sandbox: string, stage = 'REVIEW'): void {
  const tasksDir = path.join(sandbox, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    checkpointPath(sandbox),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: stage,
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history: [{ stage, timestamp: now }],
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

function readCheckpoint(sandbox: string): any {
  try {
    return JSON.parse(fs.readFileSync(checkpointPath(sandbox), 'utf8'));
  } catch {
    return null;
  }
}

function readCheckpointBytes(sandbox: string): string | null {
  try {
    return fs.readFileSync(checkpointPath(sandbox), 'utf8');
  } catch {
    return null;
  }
}

function lastMetadata(sandbox: string): any {
  const checkpoint = readCheckpoint(sandbox);
  const history = checkpoint.history;
  return history[history.length - 1].metadata;
}

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

function makeSandbox(comments: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-349-refute-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'verdict.md'), APPROVED_BLOCK, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'report.json'),
    JSON.stringify({
      summary: 'Automated review',
      confidenceLevel: 'High',
      confidenceExplanation: 'static scan',
      comments
    }),
    'utf8'
  );
  seedCheckpoint(dir);
  return dir;
}

async function withSanitizedEnv(sandbox: string, fn: () => Promise<any>): Promise<any> {
  const prevCwd = process.cwd();
  const envBackup = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    AGY_SUBAGENT: process.env.AGY_SUBAGENT
  };
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';

  try {
    process.chdir(sandbox);
    process.env.PATH = sharedShadowPath();
    process.env.HOME = path.join(sandbox, '.home');
    delete process.env.XDG_DATA_HOME;
    delete process.env.AGY_SUBAGENT;
    console.log = (...a) => {
      stdout += `${a.map(String).join(' ')}\n`;
    };
    console.error = (...a) => {
      stderr += `${a.map(String).join(' ')}\n`;
    };
    const value = await fn();
    return { value, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
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

function review(sandbox: string, extraArgs: string[] = []): Promise<any> {
  return withSanitizedEnv(sandbox, async () =>
    runCli([
      'review',
      '--issue',
      String(ISSUE),
      '--verdict-file',
      'verdict.md',
      '--critique-report',
      'report.json',
      ...extraArgs
    ])
  );
}

const V7_COMMENTS = [
  { path: 'src/app.ts', line: 10, severity: 'error', body: V7_BODY }
];

const TWO_AT_ONE_LINE = [
  {
    path: 'src/db.ts',
    line: 42,
    severity: 'critical',
    body: 'Null pointer dereference when the row is absent.'
  },
  { path: 'src/db.ts', line: 42, severity: 'error', body: 'The retry loop leaks a timer.' }
];

describe('codeloop review --refute (issue #349)', () => {
  test('CR1: a valid refutation records APPROVED and is audited (AC4-S1/S5)', async () => {
    const sandbox = makeSandbox(V7_COMMENTS);
    try {
      const run = await review(sandbox, ['--refute', V7_REFUTATION]);

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);
      assert.ok(run.stdout.includes('Review Status'), output);
      assert.ok(/Review Status\s*: APPROVED/.test(run.stdout), output);
      assert.ok(/Next Stage\s*: \[COMMIT\]/.test(run.stdout), output);

      assert.ok(run.stderr.includes('Operator refuted 1'), run.stderr);
      assert.ok(run.stderr.includes('src/app.ts:10 [error/change-request]'), run.stderr);
      assert.ok(run.stderr.includes(V7_BODY), run.stderr);
      assert.ok(run.stderr.includes('reason: actions/checkout@v7 exists'), run.stderr);

      const metadata = lastMetadata(sandbox);
      assert.strictEqual(metadata.reviewVerdict, 'APPROVED');
      assert.strictEqual(metadata.reviewSource, 'reviewer-output');
      assert.strictEqual(metadata.reviewRefutations.length, 1);
      assert.strictEqual(metadata.reviewRefutations[0].target, 'src/app.ts:10');
      assert.strictEqual(metadata.reviewRefutations[0].reason, V7_REASON);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CR2: without a refutation the same fixture still reverts (AC4-S2)', async () => {
    const sandbox = makeSandbox(V7_COMMENTS);
    try {
      const run = await review(sandbox);

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(/Review Status\s*: CHANGES_REQUESTED/.test(run.stdout), output);
      assert.ok(/Next Stage\s*: \[IMPLEMENT\]/.test(run.stdout), output);

      const metadata = lastMetadata(sandbox);
      assert.strictEqual(metadata.reviewVerdict, 'CHANGES_REQUESTED');
      assert.ok(!('reviewRefutations' in metadata));
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CR3: a refutation without a reason is refused and writes nothing (AC4-S3)', async () => {
    const sandbox = makeSandbox(V7_COMMENTS);
    try {
      const before = readCheckpointBytes(sandbox);

      const noReason = await review(sandbox, ['--refute', 'src/app.ts:10']);
      assert.strictEqual(noReason.value, EXIT_CODE_FAILURE, noReason.stdout);
      assert.ok(noReason.stderr.includes('reason'), noReason.stderr);
      assert.strictEqual(readCheckpointBytes(sandbox), before, 'the checkpoint must be byte-identical');

      const blankReason = await review(sandbox, ['--refute', 'src/app.ts:10=   ']);
      assert.strictEqual(blankReason.value, EXIT_CODE_FAILURE, blankReason.stdout);
      assert.ok(blankReason.stderr.includes('reason'), blankReason.stderr);
      assert.strictEqual(readCheckpointBytes(sandbox), before);

      const noValue = await review(sandbox, ['--refute']);
      assert.strictEqual(noValue.value, EXIT_CODE_FAILURE, noValue.stdout);
      assert.ok(noValue.stderr.includes('requires a value'), noValue.stderr);
      assert.strictEqual(readCheckpointBytes(sandbox), before);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CR4: a target matching no blocking finding is refused (AC4-S4)', async () => {
    const sandbox = makeSandbox(V7_COMMENTS);
    try {
      const before = readCheckpointBytes(sandbox);

      const run = await review(sandbox, ['--refute', 'src/missing.ts:1=does not exist']);

      assert.strictEqual(run.value, EXIT_CODE_FAILURE, run.stdout);
      assert.ok(run.stderr.includes('no blocking finding'), run.stderr);
      assert.strictEqual(readCheckpointBytes(sandbox), before);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CR5: an ambiguous target is refused, then #severity narrows it (AC4-S4)', async () => {
    const sandbox = makeSandbox(TWO_AT_ONE_LINE);
    try {
      const ambiguous = await review(sandbox, ['--refute', 'src/db.ts:42=v7 exists']);
      assert.strictEqual(ambiguous.value, EXIT_CODE_FAILURE, ambiguous.stdout);
      assert.ok(ambiguous.stderr.includes('2 blocking findings'), ambiguous.stderr);
      assert.ok(!(lastMetadata(sandbox) || {}).reviewRefutations);

      seedCheckpoint(sandbox);
      const narrowed = await review(sandbox, [
        '--refute',
        'src/db.ts:42#error=the retry loop is bounded'
      ]);
      assert.strictEqual(narrowed.value, EXIT_CODE_FAILURE, narrowed.stdout);
      assert.ok(/Review Status\s*: CHANGES_REQUESTED/.test(narrowed.stdout), narrowed.stdout);

      const metadata = lastMetadata(sandbox);
      assert.strictEqual(metadata.reviewRefutations.length, 1);
      assert.strictEqual(metadata.reviewRefutations[0].severity, 'error');
      assert.strictEqual(metadata.reviewRefutations[0].target, 'src/db.ts:42#error');
      assert.ok(
        metadata.reviewRefutations.every((entry: any) => entry.severity !== 'critical'),
        'the critical finding must not be refuted by the error selector'
      );
      assert.ok(
        narrowed.stdout.includes('Null pointer dereference when the row is absent.'),
        narrowed.stdout
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CR6: --json carries the refutation audit in one document (AC4.4)', async () => {
    const sandbox = makeSandbox(V7_COMMENTS);
    try {
      const run = await review(sandbox, ['--json', '--refute', V7_REFUTATION]);

      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, run.stderr);
      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.passed, true);
      assert.strictEqual(payload.currentStage, 'COMMIT');
      assert.strictEqual(payload.verdict.status, 'APPROVED');
      assert.strictEqual(payload.refutations.length, 1);

      const applied = payload.refutations[0];
      assert.strictEqual(applied.target, 'src/app.ts:10');
      assert.strictEqual(applied.path, 'src/app.ts');
      assert.strictEqual(applied.line, 10);
      assert.strictEqual(applied.severity, 'error');
      assert.strictEqual(applied.actionability, 'change-request');
      assert.strictEqual(applied.bodyExcerpt, V7_BODY);
      assert.strictEqual(applied.reason, V7_REASON);
      assert.strictEqual(applied.findingIndex, 0);

      // The stderr note survives --json, so the act is never silent.
      assert.ok(run.stderr.includes('Operator refuted 1'), run.stderr);
      assert.strictEqual(lastMetadata(sandbox).reviewRefutations.length, 1);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CR7: a genuine defect beside a refuted claim still reverts (AC4-S6)', async () => {
    const sandbox = makeSandbox([
      ...V7_COMMENTS,
      {
        path: 'src/db.ts',
        line: 42,
        severity: 'error',
        body: 'Null pointer dereference when the row is absent.'
      }
    ]);
    try {
      const run = await review(sandbox, ['--json', '--refute', V7_REFUTATION]);

      assert.strictEqual(run.value, EXIT_CODE_FAILURE, run.stdout);
      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.passed, false);
      assert.strictEqual(payload.verdict.status, 'CHANGES_REQUESTED');
      assert.strictEqual(payload.currentStage, 'IMPLEMENT');
      assert.ok(
        payload.verdict.summary.includes('(1 refuted by the operator)'),
        payload.verdict.summary
      );
      const criteria = payload.verdict.unfulfilledCriteria.join('\n');
      assert.ok(criteria.includes('src/db.ts:42'), criteria);
      assert.ok(!criteria.includes('actions/checkout@v7'), criteria);
      assert.strictEqual(payload.refutations.length, 1);
      assert.strictEqual(lastMetadata(sandbox).reviewRefutations.length, 1);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CR8: --refute is scoped to review (AC4.3)', async () => {
    const sandbox = makeSandbox(V7_COMMENTS);
    try {
      const before = readCheckpointBytes(sandbox);
      const run = await withSanitizedEnv(sandbox, async () =>
        runCli(['status', '--issue', String(ISSUE), '--refute', 'src/app.ts:10=x'])
      );

      assert.strictEqual(run.value, EXIT_CODE_FAILURE, run.stdout);
      assert.ok(run.stderr.includes("only supported by 'review'"), run.stderr);
      assert.strictEqual(readCheckpointBytes(sandbox), before);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('CR9: refutations are repeatable, and a dry run records nothing', async () => {
    const sandbox = makeSandbox([
      ...V7_COMMENTS,
      { path: 'src/db.ts', line: 42, severity: 'error', body: 'The retry loop leaks a timer.' }
    ]);
    try {
      const run = await review(sandbox, [
        '--refute',
        V7_REFUTATION,
        '--refute',
        'src/db.ts:42=the loop is bounded by maxRetries'
      ]);

      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stderr.includes('Operator refuted 2'), run.stderr);
      assert.ok(run.stderr.includes('src/app.ts:10 [error/change-request]'), run.stderr);
      assert.ok(run.stderr.includes('src/db.ts:42 [error/change-request]'), run.stderr);
      assert.ok(run.stderr.includes('reason: the loop is bounded by maxRetries'), run.stderr);
      assert.strictEqual(lastMetadata(sandbox).reviewRefutations.length, 2);

      // A dry run reports the prediction and writes nothing.
      seedCheckpoint(sandbox);
      const before = readCheckpointBytes(sandbox);
      const dry = await review(sandbox, [
        '--json',
        '--dry-run',
        '--refute',
        V7_REFUTATION,
        '--refute',
        'src/db.ts:42=the loop is bounded by maxRetries'
      ]);

      assert.strictEqual(dry.value, EXIT_CODE_SUCCESS, `${dry.stdout}\n${dry.stderr}`);
      const payload = JSON.parse(dry.stdout);
      assert.strictEqual(payload.dryRun, true);
      assert.strictEqual(payload.refutations.length, 2);
      assert.strictEqual(payload.refutations[0].reason, V7_REASON);
      assert.strictEqual(payload.wouldSetStage, 'COMMIT');
      assert.strictEqual(readCheckpointBytes(sandbox), before, 'a dry run must write nothing');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
