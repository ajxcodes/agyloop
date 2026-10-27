/**
 * agyloop - `review --json` reports THIS round's verdict (issue #284, D7/AC8)
 *
 * The defect: `lastRecordedReviewerVerdict()` scanned history backwards for
 * ANY `reviewerVerdict`, so a round that supplied no reviewer block reported
 * the PREVIOUS round's status. A critique-only re-run must omit the field; a
 * filed round must report its own.
 *
 * Harness: the critique-free PATH shadow from `cli-review-verdict.test.ts` — the
 * Tier 1 report must not be able to escalate the verdict under test.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS } = require('../../dist/domain');
const { CliCritiqueGateway } = require('../../dist/infrastructure');

const CRITIQUE_BINARY = 'critique';
const ISSUE = 911;

function buildCritiqueFreePathShadow(shadowRoot: string): string {
  fs.mkdirSync(shadowRoot, { recursive: true });
  const seen = new Set<string>();
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shadowEntries: string[] = [];
  let idx = 0;

  for (const dir of parts) {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    let entries: string[];
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
        // Fall through to entry-by-entry copy.
      }
    }

    fs.mkdirSync(target, { recursive: true });
    for (const entry of entries) {
      if (entry === CRITIQUE_BINARY || entry.startsWith(`${CRITIQUE_BINARY}.`)) continue;
      try {
        fs.symlinkSync(fs.realpathSync(path.join(real, entry)), path.join(target, entry));
      } catch {
        // Skip unresolvable entries.
      }
    }
    shadowEntries.push(target);
  }

  return shadowEntries.join(path.delimiter);
}

interface Sandbox {
  readonly dir: string;
  readonly shadowPath: string;
  readonly headSha: string;
}

function seedCheckpoint(sandbox: string, stage: string, history: Array<Record<string, unknown>>): void {
  const tasksDir = path.join(sandbox, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(tasksDir, `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: stage,
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0
      },
      null,
      2
    ),
    'utf8'
  );
}

function makeSandbox(stage: string, history: Array<Record<string, unknown>>): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-review-json-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  seedCheckpoint(dir, stage, history);
  return { dir, shadowPath: buildCritiqueFreePathShadow(path.join(dir, '.shadow-bin')), headSha };
}

async function withSanitizedEnv(
  sandbox: Sandbox,
  fn: () => Promise<any>
): Promise<{ value: any; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {
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
    process.chdir(sandbox.dir);
    process.env.PATH = sandbox.shadowPath;
    process.env.HOME = path.join(sandbox.dir, '.home');
    delete process.env.XDG_DATA_HOME;
    delete process.env.AGY_SUBAGENT;
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
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

/** A history whose LAST round supplied no reviewer block, but an earlier one did. */
function reReviewHistory() {
  const now = new Date().toISOString();
  return [
    {
      stage: 'REVIEW',
      timestamp: now,
      metadata: { reviewerVerdict: 'APPROVED', reviewVerdict: 'APPROVED' }
    },
    { stage: 'COMMIT', timestamp: now },
    { stage: 'QUALITY_GATE', timestamp: now },
    { stage: 'REVIEW', timestamp: now }
  ];
}

async function assertCritiqueAbsent(t: any, sandbox: Sandbox): Promise<boolean> {
  const probe = await withSanitizedEnv(sandbox, async () =>
    new CliCritiqueGateway().resolveReviewer(sandbox.dir)
  );
  if (!probe.value || probe.value.source !== 'none') {
    t.skip(`environment cannot guarantee critique absence: ${JSON.stringify(probe.value)}`);
    return false;
  }
  return true;
}

describe('review --json currency (issue #284, D7)', () => {
  test('D7a: a critique-only re-run OMITS reviewerVerdict instead of inheriting the previous round', async (t: any) => {
    const sandbox = makeSandbox('REVIEW', reReviewHistory());
    try {
      if (!(await assertCritiqueAbsent(t, sandbox))) return;

      const run = await withSanitizedEnv(sandbox, async () =>
        runCli(['review', '--issue', String(ISSUE), '--json'])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);

      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.reviewVerdict, 'SKIPPED');
      assert.strictEqual(payload.verdictSource, 'skipped');
      assert.ok(
        !('reviewerVerdict' in payload),
        `the previous round's APPROVED must not be inherited, got: ${JSON.stringify(payload)}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('D7b: a filed verdict reports ITS status and the reviewed base commit', async (t: any) => {
    const sandbox = makeSandbox('REVIEW', reReviewHistory());
    try {
      if (!(await assertCritiqueAbsent(t, sandbox))) return;

      const verdictFile = path.join(sandbox.dir, 'verdict.md');
      fs.writeFileSync(verdictFile, APPROVED_BLOCK, 'utf8');

      const run = await withSanitizedEnv(sandbox, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', verdictFile, '--json'])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);

      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.reviewerVerdict, 'APPROVED');
      assert.strictEqual(
        payload.reviewedBaseCommit,
        sandbox.headSha,
        `the reviewed HEAD must be reported, got: ${JSON.stringify(payload)}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('D7c: with no earlier round and no block the field is absent (control)', async (t: any) => {
    const now = new Date().toISOString();
    const sandbox = makeSandbox('REVIEW', [{ stage: 'REVIEW', timestamp: now }]);
    try {
      if (!(await assertCritiqueAbsent(t, sandbox))) return;

      const run = await withSanitizedEnv(sandbox, async () =>
        runCli(['review', '--issue', String(ISSUE), '--json'])
      );
      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.reviewVerdict, 'SKIPPED');
      assert.ok(!('reviewerVerdict' in payload), `no block means no field, got: ${JSON.stringify(payload)}`);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('D7d: --dry-run omits reviewVerdict and reviewerVerdict', async (t: any) => {
    const sandbox = makeSandbox('REVIEW', reReviewHistory());
    try {
      if (!(await assertCritiqueAbsent(t, sandbox))) return;

      const run = await withSanitizedEnv(sandbox, async () =>
        runCli(['review', '--issue', String(ISSUE), '--json', '--dry-run'])
      );
      const payload = JSON.parse(run.stdout);
      assert.ok(!('reviewVerdict' in payload), `a dry run records nothing, got: ${JSON.stringify(payload)}`);
      assert.ok(!('reviewerVerdict' in payload), `a dry run records nothing, got: ${JSON.stringify(payload)}`);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
