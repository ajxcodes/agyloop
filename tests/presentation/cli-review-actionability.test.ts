/** The canonical task seed with this suite's stage shape. */
function seedStageCheckpoint(sandbox: string, stage: string): string {
  const now = new Date().toISOString();
  return seedTaskCanonical(sandbox, {
    issue: ISSUE,
    currentStage: stage,
    createdAt: now,
    updatedAt: now,
    history: [{ stage, timestamp: now }],
    reviewDispatchCount: 0
  });
}

/**
 * codeloop - `codeloop review`: content-aware blocking (issue #349 AC2/AC3)
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
const { buildChangeSetDigestCommand } = require('../../dist/application');
const { makeSandbox: makeSandboxCanonical } = require('../helpers/sandbox.ts');
const { EXIT_CODE_SUCCESS, EXIT_CODE_FAILURE } = require('../../dist/domain');
const { buildCritiqueFreePathShadow, buildPathShadowWithout, checkpointLine } = require('../helpers/render.ts');
const { readCheckpoint, checkpointPath, seedTask: seedTaskCanonical } = require('../helpers/state-seed.ts');

/** The task checkpoint when seeded, or null when the file is absent (local envelope of the canonical read). */
function readCheckpointOrNothing(dir: string): any {
  const file = checkpointPath(dir, ISSUE);
  return fs.existsSync(file) ? readCheckpoint(file) : null;
}


const CRITIQUE_BINARY = 'critique';
const ISSUE = 349;

let sharedShadowRoot: any = null;

/** A PATH shadow mirroring every entry except the `critique` binary. */

function sharedShadowPath() {
  if (sharedShadowRoot === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-349-shadow-'));
    sharedShadowRoot = { dir, path: buildCritiqueFreePathShadow(path.join(dir, 'bin')) };
  }
  return sharedShadowRoot.path;
}

after(() => {
  if (sharedShadowRoot && sharedShadowRoot.dir) {
    fs.rmSync(sharedShadowRoot.dir, { recursive: true, force: true });
  }
});



function makeReviewActionabilitySandbox(): string {
  const sandbox = makeSandboxCanonical({
    // Issue #452: the provenance sidecar is written AFTER its digest is read, so
    // it must not itself become part of the change set it describes.
    prefix: 'codeloop-349-review-',
    dirName: '',
    gitignore: ['*.provenance.json'],
    seed: (dir: string) => {
      fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
    },
    initialCommit: 'chore: probe init'
  });
  const dir = sandbox.dir;
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  seedStageCheckpoint(dir, 'REVIEW');
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

// Issue #445: the report is certified only when the sidecar beside it names this
// review's base and HEAD, so the positive-path fixture seeds it.
function writeProvenance(critiquePath: string, baseRef = 'main'): void {
  const cwd = path.dirname(critiquePath);
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8'
  }).trim();
  // Issue #452: the sidecar binds content too.
  const changeSetDigest = execFileSync('sh', ['-c', buildChangeSetDigestCommand()], {
    cwd,
    encoding: 'utf8'
  }).trim();
  fs.writeFileSync(
    `${critiquePath}.provenance.json`,
    JSON.stringify({ baseRef, headCommit, changeSetDigest }),
    'utf8'
  );
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
    const sandbox = makeReviewActionabilitySandbox();
    try {
      const verdictFile = writeVerdict(sandbox);
      const critiqueFile = writeCritique(sandbox, [AFFIRMATION_COMMENT]);
      // Both inputs must exist before the digest is read (#452).
      writeProvenance(critiqueFile);
      const run = await withSanitizedEnv(sandbox, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report',
          critiqueFile
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

      const checkpoint = readCheckpointOrNothing(sandbox);
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
    const sandbox = makeReviewActionabilitySandbox();
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

      const checkpoint = readCheckpointOrNothing(sandbox);
      assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'CHANGES_REQUESTED');
      assert.strictEqual(last.metadata.reviewSource, 'reviewer-output+critique-escalation');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('C3: --json carries the exemptions in ONE document', async () => {
    const sandbox = makeReviewActionabilitySandbox();
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
    const sandbox = makeReviewActionabilitySandbox();
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
