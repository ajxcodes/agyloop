/**
 * agyloop - `codeloop review`: content-aware blocking (issue #349 AC2/AC3)
 *
 * The live regression (#242): a critique report with a `critical` finding whose
 * body AFFIRMED the change ("Correctly pins actions/checkout@v7") reverted a
 * filed `APPROVED` verdict to IMPLEMENT, because the local invariant only looked
 * at severity.
 *
 * C1 - a critical affirmation records APPROVED (exit 0) and is named on stderr (AC2)
 * C2 - a genuine defect still records CHANGES_REQUESTED (exit 1) with count 1 (AC3)
 * C3 - `--json` carries the exemptions in ONE parseable document
 * C4 - a clean report produces no exemption line and an empty list
 *
 * Harness: the sandbox + sanitized-env recipe from `cli-review-verdict.test.ts`.
 * Every case supplies `--critique-report`, so the critique CLI is never needed.
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

let sharedShadowRoot: any = null;

/** A PATH shadow mirroring every entry except the `critique` binary. */
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
  if (sharedShadowRoot === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-349-shadow-'));
    sharedShadowRoot = { dir, path: buildCritiqueFreePathShadow(path.join(dir, 'bin')) };
  }
  return sharedShadowRoot.path;
}

after(() => {
  if (sharedShadowRoot && sharedShadowRoot.dir) {
    fs.rmSync(sharedShadowRoot.dir, { recursive: true, force: true });
  }
});

function seedCheckpoint(sandbox: string, stage: string): string {
  const tasksDir = path.join(sandbox, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const file = path.join(tasksDir, `${ISSUE}.json`);
  const now = new Date().toISOString();
  fs.writeFileSync(
    file,
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
  return file;
}

function readCheckpoint(sandbox: string): any {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(sandbox, '.agyloop', 'tasks', `${ISSUE}.json`), 'utf8')
    );
  } catch {
    return null;
  }
}

function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-349-review-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  seedCheckpoint(dir, 'REVIEW');
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
    return { value, stdout, stderr };
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

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

function writeVerdict(sandbox: string): string {
  const file = path.join(sandbox, 'verdict.md');
  fs.writeFileSync(file, APPROVED_BLOCK, 'utf8');
  return file;
}

function writeCritique(sandbox: string, comments: any): string {
  const file = path.join(sandbox, 'critique.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      summary: 'Automated review',
      confidenceLevel: 'High',
      confidenceExplanation: 'static scan',
      comments
    }),
    'utf8'
  );
  return file;
}

const AFFIRMATION_COMMENT = {
  path: 'src/app.ts',
  line: 10,
  severity: 'critical',
  body: 'Correctly pins actions/checkout@v7 and actions/setup-node@v7.'
};

const DEFECT_COMMENT = {
  path: 'src/app.ts',
  line: 10,
  severity: 'error',
  body: 'Null pointer dereference on an empty payload.'
};

describe('codeloop review - content-aware blocking (issue #349)', () => {
  test('C1: a critical affirmation records APPROVED and is named on stderr (AC2)', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await withSanitizedEnv(sandbox, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          writeVerdict(sandbox),
          '--critique-report',
          writeCritique(sandbox, [AFFIRMATION_COMMENT])
        ])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);
      assert.ok(output.includes('APPROVED'), output);
      assert.ok(
        run.stderr.includes('request no change'),
        `the exemption must be named on stderr, got:\n${run.stderr}`
      );
      assert.ok(run.stderr.includes('src/app.ts:10'), run.stderr);
      assert.ok(run.stderr.includes('[critical/affirmation]'), run.stderr);

      const checkpoint = readCheckpoint(sandbox);
      assert.strictEqual(checkpoint.currentStage, 'COMMIT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'APPROVED');
      assert.strictEqual(last.metadata.reviewSource, 'reviewer-output');
      assert.strictEqual(last.metadata.critiqueVerified, true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('C2: a genuine defect still exits 1 and reverts to IMPLEMENT (AC3)', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await withSanitizedEnv(sandbox, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          writeVerdict(sandbox),
          '--critique-report',
          writeCritique(sandbox, [DEFECT_COMMENT])
        ])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(output.includes('detected 1 blocking/error violation(s)'), output);
      assert.ok(!run.stderr.includes('request no change'), run.stderr);

      const checkpoint = readCheckpoint(sandbox);
      assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'CHANGES_REQUESTED');
      assert.strictEqual(last.metadata.reviewSource, 'reviewer-output+critique-escalation');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('C3: --json carries the exemptions in ONE document', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await withSanitizedEnv(sandbox, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          writeVerdict(sandbox),
          '--critique-report',
          writeCritique(sandbox, [AFFIRMATION_COMMENT]),
          '--json'
        ])
      );

      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, run.stderr);
      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.passed, true);
      assert.strictEqual(payload.verdict.status, 'APPROVED');
      assert.strictEqual(payload.currentStage, 'COMMIT');
      assert.strictEqual(payload.nonActionableFindings.length, 1);
      assert.deepStrictEqual(
        {
          path: payload.nonActionableFindings[0].path,
          line: payload.nonActionableFindings[0].line,
          severity: payload.nonActionableFindings[0].severity,
          actionability: payload.nonActionableFindings[0].actionability
        },
        { path: 'src/app.ts', line: 10, severity: 'critical', actionability: 'affirmation' }
      );
      assert.deepStrictEqual(payload.refutations, []);
      // The note still goes to stderr, never into the JSON document.
      assert.ok(run.stderr.includes('request no change'), run.stderr);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('C4: a clean report produces no exemption line and an empty list', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await withSanitizedEnv(sandbox, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          writeVerdict(sandbox),
          '--critique-report',
          writeCritique(sandbox, []),
          '--json'
        ])
      );

      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, run.stderr);
      assert.ok(!run.stderr.includes('request no change'), run.stderr);
      const payload = JSON.parse(run.stdout);
      assert.deepStrictEqual(payload.nonActionableFindings, []);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
