/** The canonical task seed with this suite's REVIEW history shape. */
function seedReviewStageCheckpoint(sandbox: string, stage: string, history: Array<Record<string, unknown>>): void {
  const now = new Date().toISOString();
  seedTask(sandbox, {
    issue: ISSUE,
    currentStage: stage,
    createdAt: now,
    updatedAt: now,
    history,
    totalHumanWaitMs: 0
  });
}

/**
 * codeloop - `review --json` reports THIS round's verdict (issue #284, D7/AC8)
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
const { makeSandbox: makeSandboxCanonical } = require('../helpers/sandbox.ts');
const { CliCritiqueGateway } = require('../../dist/infrastructure');
const { buildCritiqueFreePathShadow, buildPathShadowWithout, checkpointLine } = require('../helpers/render.ts');
const { seedTask, seedCheckpoint, seedRootState, seedCorruptTask, checkpointPath } = require('../helpers/state-seed.ts');

const CRITIQUE_BINARY = 'critique';
const ISSUE = 911;


interface Sandbox {
  readonly dir: string;
  readonly shadowPath: string;
  readonly headSha: string;
}


function makeReviewJsonSandbox(stage: string, history: Array<Record<string, unknown>>): Sandbox {
  const sandbox = makeSandboxCanonical({
    prefix: 'codeloop-cli-review-json-',
    dirName: '',
    gitignore: false,
    seed: (dir: string) => {
      fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
    },
    initialCommit: 'chore: probe init'
  });
  const dir = sandbox.dir;
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  seedReviewStageCheckpoint(dir, stage, history);
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
    const sandbox = makeReviewJsonSandbox('REVIEW', reReviewHistory());
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
    const sandbox = makeReviewJsonSandbox('REVIEW', reReviewHistory());
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
    const sandbox = makeReviewJsonSandbox('REVIEW', [{ stage: 'REVIEW', timestamp: now }]);
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
    const sandbox = makeReviewJsonSandbox('REVIEW', reReviewHistory());
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
