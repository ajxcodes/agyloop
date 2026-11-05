/**
 * codeloop - `codeloop review` certifies the QUALITY_GATE exit (issue #455)
 *
 * RGC1 - no evidence: the real CLI refuses, exits non-zero and writes NOTHING
 * RGC2 - a filed report certifies the round, records the verdict and consumes it
 * RGC3 - `--dry-run` warns about the missing evidence and writes nothing
 *
 * Harness: copied from `cli-transition-gate-evidence.test.ts`. A
 * `--critique-report` is always supplied so no host `critique` binary is
 * consulted and the verdict is deterministic.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { makeSandbox: makeSandboxCanonical } = require('../helpers/sandbox.ts');
const { readCheckpoint } = require('../helpers/state-seed.ts');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');
const {
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE,
  GATE_REPORT_JSON_MARKER,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_IMPLEMENT,
  STAGE_COMMIT
} = require('../../dist/domain');

const ISSUE = 455;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLAN_DIR = `artifacts/plans/${ISSUE}`;

const VERDICT_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: the delivered change set is clean.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

const GATE_BLOCK = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (12 passed)", "testsPassed": 12, "testsFailed": 0,
  "durationMs": 1000, "executedCommands": ["npm test"],
  "smokeProtocol": "NOT_DECLARED", "notRun": [] }
`;

const CRITIQUE_JSON =
  '{"summary":"Clean automated review","confidenceLevel":"High","confidenceExplanation":"diff verified","comments":[]}';

function seedPlanDir(dir: string): void {
  const planDir = path.join(dir, PLAN_DIR);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, 'implementation_plan.md'),
    [
      '# [Implementation] - Smoke',
      '',
      '## 4. Quality Gate & Test Verification',
      '',
      '### Quality Gate Targets',
      '',
      '- `npm test`',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, 'templates', 'summary-log.md'),
    path.join(planDir, 'CodeLoop Summary.md')
  );
}

function makeReviewGateEvidenceSandbox(): any {
  const sandbox = makeSandboxCanonical({
    prefix: 'codeloop-cli-review-gate-evidence-',
    dirName: '',
    gitignore: false,
    initialBranch: 'main',
    seed: (dir: string) => {
      fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
    },
    initialCommit: 'chore: base'
  });
  const dir = sandbox.dir;

  seedPlanDir(dir);

  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  const checkpointPathLocal = path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
  fs.writeFileSync(
    checkpointPathLocal,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: STAGE_QUALITY_GATE,
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        planDir: PLAN_DIR,
        createdAt: now,
        updatedAt: now,
        history: [
          { stage: STAGE_IMPLEMENT, timestamp: now },
          { stage: STAGE_QUALITY_GATE, timestamp: now }
        ],
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(path.join(dir, 'verdict.md'), VERDICT_BLOCK, 'utf8');
  fs.writeFileSync(path.join(dir, 'critique.json'), CRITIQUE_JSON, 'utf8');

  return {
    dir,
    checkpointPathLocal,
    evidencePath: path.join(dir, '.agyloop', 'tasks', `${ISSUE}.gate.json`)
  };
}



describe('review certifies the QUALITY_GATE exit (issue #455)', () => {
  test('RGC1 review at QUALITY_GATE with no evidence exits non-zero and leaves the checkpoint byte-identical', async () => {
    const sandbox = makeReviewGateEvidenceSandbox();
    try {
      const before = fs.readFileSync(sandbox.checkpointPathLocal, 'utf8');

      const run = await runCliInSandboxCanonical([
        'review',
        '--issue',
        String(ISSUE),
        '--verdict-file',
        'verdict.md',
        '--critique-report',
        'critique.json'
      ], { dir: sandbox.dir });

      assert.strictEqual(run.code, EXIT_CODE_FAILURE, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stderr.includes('Gate evidence refused'), run.stderr);
      assert.ok(run.stderr.includes('gate round 1'), run.stderr);
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPathLocal, 'utf8'), before);

      const checkpoint = readCheckpoint(sandbox.checkpointPathLocal);
      assert.strictEqual(checkpoint.currentStage, STAGE_QUALITY_GATE);
      assert.ok(!checkpoint.history.some((entry: any) => entry.stage === STAGE_REVIEW));
      assert.ok(!fs.existsSync(sandbox.evidencePath), 'a refusal creates no evidence');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('RGC2 a filed report lets review certify the round, record the verdict and consume the evidence', async () => {
    const sandbox = makeReviewGateEvidenceSandbox();
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), GATE_BLOCK, 'utf8');
      const filed = await runCliInSandboxCanonical([
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ], { dir: sandbox.dir });
      assert.strictEqual(filed.code, EXIT_CODE_SUCCESS, filed.stderr);
      assert.ok(fs.existsSync(sandbox.evidencePath));

      const run = await runCliInSandboxCanonical([
        'review',
        '--issue',
        String(ISSUE),
        '--verdict-file',
        'verdict.md',
        '--critique-report',
        'critique.json'
      ], { dir: sandbox.dir });
      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `${run.stdout}\n${run.stderr}`);

      const checkpoint = readCheckpoint(sandbox.checkpointPathLocal);
      assert.strictEqual(checkpoint.currentStage, STAGE_COMMIT);
      const reviewEntry = [...checkpoint.history]
        .reverse()
        .find((entry: any) => entry.stage === STAGE_REVIEW);
      assert.ok(reviewEntry, 'a REVIEW entry must be recorded');
      assert.strictEqual(reviewEntry.metadata.gateVerdict, 'PASSED');
      assert.strictEqual(reviewEntry.metadata.gateTests, 'PASSED (12 passed)');
      assert.ok(!fs.existsSync(sandbox.evidencePath), 'ingest consumes the evidence file');
      assert.strictEqual(
        checkpoint.history[checkpoint.history.length - 1].metadata.reviewVerdict,
        'APPROVED'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('RGC3 --dry-run warns and writes nothing', async () => {
    const sandbox = makeReviewGateEvidenceSandbox();
    try {
      const before = fs.readFileSync(sandbox.checkpointPathLocal, 'utf8');

      const run = await runCliInSandboxCanonical([
        'review',
        '--issue',
        String(ISSUE),
        '--verdict-file',
        'verdict.md',
        '--critique-report',
        'critique.json',
        '--dry-run'
      ], { dir: sandbox.dir });

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stderr.includes('Gate evidence refused'), run.stderr);
      assert.ok(run.stderr.includes('gate round 1'), run.stderr);
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPathLocal, 'utf8'), before);
      assert.ok(!fs.existsSync(sandbox.evidencePath), 'a dry run creates no evidence');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
