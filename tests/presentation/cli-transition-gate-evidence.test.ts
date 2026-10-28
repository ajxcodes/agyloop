/**
 * agyloop - the QUALITY_GATE exit consumes evidence (issue #327, Defect 3)
 *
 * GE1 - no evidence: `transition REVIEW` refuses, writes nothing, records no REVIEW row
 * GE2 - the production order: file, then transition -> the verdict is recorded and consumed
 * GE3 - filing past the only consuming exit now names the legal walk-back
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const {
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE,
  GATE_REPORT_JSON_MARKER,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_IMPLEMENT
} = require('../../dist/domain');

const ISSUE = 702;

const VALID_BLOCK = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (1899 passed)", "testsPassed": 1899, "testsFailed": 0,
  "durationMs": 196000, "executedCommands": ["npm run lint", "npm test"],
  "smokeProtocol": "PASSED", "notRun": [] }
`;

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-gate-evidence-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: base'], { cwd: dir, stdio: 'ignore' });

  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  const checkpointPath = path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: STAGE_QUALITY_GATE,
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
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

  return {
    dir,
    checkpointPath,
    evidencePath: path.join(dir, '.agyloop', 'tasks', `${ISSUE}.gate.json`)
  };
}

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
    return { code, stdout, stderr };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function readCheckpoint(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('QUALITY_GATE exit consumes evidence (issue #327)', () => {
  test('GE1: no evidence refuses the exit, writes nothing and records no REVIEW row', async () => {
    const sandbox = makeSandbox();
    try {
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');

      const run = await runIn(sandbox.dir, ['transition', 'REVIEW', '--issue', String(ISSUE)]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE, run.stdout);
      assert.ok(run.stderr.includes('Gate evidence refused'), run.stderr);
      assert.ok(run.stderr.includes(`codeloop gate-report --issue ${ISSUE}`), run.stderr);
      assert.ok(run.stderr.includes(`codeloop transition ${STAGE_REVIEW} --issue ${ISSUE}`), run.stderr);

      assert.strictEqual(
        fs.readFileSync(sandbox.checkpointPath, 'utf8'),
        before,
        'a refusal must leave the checkpoint byte-identical'
      );
      const checkpoint = readCheckpoint(sandbox.checkpointPath);
      assert.strictEqual(checkpoint.currentStage, STAGE_QUALITY_GATE);
      assert.ok(!checkpoint.history.some((entry: any) => entry.stage === STAGE_REVIEW));
      assert.ok(!fs.existsSync(sandbox.evidencePath), 'a refusal must not create evidence');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('GE2: file then transition records the verdict and consumes the evidence', async () => {
    const sandbox = makeSandbox();
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');

      const filed = await runIn(sandbox.dir, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);
      assert.strictEqual(filed.code, EXIT_CODE_SUCCESS, filed.stderr);
      assert.ok(fs.existsSync(sandbox.evidencePath));

      const advance = await runIn(sandbox.dir, ['transition', 'REVIEW', '--issue', String(ISSUE)]);
      assert.strictEqual(advance.code, EXIT_CODE_SUCCESS, advance.stderr);

      const checkpoint = readCheckpoint(sandbox.checkpointPath);
      assert.strictEqual(checkpoint.currentStage, STAGE_REVIEW);
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.stage, STAGE_REVIEW);
      assert.strictEqual(last.metadata.gateVerdict, 'PASSED');
      assert.strictEqual(last.metadata.gateTests, 'PASSED (1899 passed)');
      assert.ok(!fs.existsSync(sandbox.evidencePath), 'ingest consumes the evidence file');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('GE3: filing past the consuming exit names the legal walk-back', async () => {
    const sandbox = makeSandbox();
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');
      await runIn(sandbox.dir, ['gate-report', '--issue', String(ISSUE), '--report-file', 'gate.json']);
      await runIn(sandbox.dir, ['transition', 'REVIEW', '--issue', String(ISSUE)]);

      const late = await runIn(sandbox.dir, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(late.code, EXIT_CODE_FAILURE);
      assert.ok(late.stderr.includes('Gate evidence refused'), late.stderr);
      assert.ok(
        late.stderr.includes(`codeloop transition ${STAGE_IMPLEMENT} --issue ${ISSUE}`),
        late.stderr
      );
      assert.ok(
        late.stderr.includes(`codeloop transition ${STAGE_QUALITY_GATE} --issue ${ISSUE}`),
        late.stderr
      );
      assert.ok(
        late.stderr.includes(`codeloop gate-report --issue ${ISSUE} --report-file <path>`),
        late.stderr
      );
      assert.strictEqual(readCheckpoint(sandbox.checkpointPath).currentStage, STAGE_REVIEW);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
