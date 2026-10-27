/**
 * agyloop - `gate-report` is the gate evidence channel (issue #284, AC1)
 *
 * It files exactly one record, prints exactly what it recorded, and NEVER
 * touches the checkpoint: the dispatched gate emits text, the orchestrator
 * files it, `transition REVIEW` ingests it.
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
  ALLOWED_TRANSITIONS,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  formatGateReportAdvanceCommand
} = require('../../dist/domain');

const ISSUE = 489;

const VALID_BLOCK = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (1408 passed)", "testsPassed": 1408, "testsFailed": 0,
  "durationMs": 196000, "executedCommands": ["npm run lint", "npm test"],
  "smokeProtocol": "PASSED", "notRun": [] }
`;

interface Sandbox {
  readonly dir: string;
  readonly checkpointPath: string;
}

function seedCheckpoint(sandbox: string, stage: string): string {
  const tasksDir = path.join(sandbox, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  const file = path.join(tasksDir, `${ISSUE}.json`);
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
        totalHumanWaitMs: 0
      },
      null,
      2
    ),
    'utf8'
  );
  return file;
}

function makeSandbox(stage: string): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-gate-report-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });
  const checkpointPath = seedCheckpoint(dir, stage);
  return { dir, checkpointPath };
}

async function runIn(sandbox: Sandbox, args: string[]): Promise<{ code: any; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalSubagent = process.env.AGY_SUBAGENT;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(sandbox.dir);
    delete process.env.AGY_SUBAGENT;
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
    if (originalSubagent === undefined) {
      delete process.env.AGY_SUBAGENT;
    } else {
      process.env.AGY_SUBAGENT = originalSubagent;
    }
  }
}

function evidencePath(sandbox: Sandbox): string {
  return path.join(sandbox.dir, '.agyloop', 'tasks', `${ISSUE}.gate.json`);
}

describe('codeloop gate-report (issue #284)', () => {
  test('happy path: records the block, prints exactly what it recorded, and does not advance', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `expected exit 0, got:\n${run.stderr}`);
      assert.strictEqual(
        run.stdout,
        [
          '✓ Gate evidence recorded: PASSED — node — PASSED (1408 passed) — 3m 16s',
          `  Evidence: ${evidencePath(sandbox)}`,
          `  Next: codeloop transition REVIEW --issue ${ISSUE}`,
          ''
        ].join('\n')
      );

      assert.ok(fs.existsSync(evidencePath(sandbox)), 'the evidence file must exist');
      const recorded = JSON.parse(fs.readFileSync(evidencePath(sandbox), 'utf8'));
      assert.strictEqual(recorded.verdict, 'PASSED');
      assert.strictEqual(recorded.testsStatus, 'PASSED (1408 passed)');
      assert.strictEqual(recorded.durationMs, 196000);

      // #297 invariant: filing evidence NEVER advances the checkpoint.
      const after = fs.readFileSync(sandbox.checkpointPath, 'utf8');
      assert.strictEqual(after, before, 'gate-report must not modify the checkpoint');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('--json prints one document', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');
      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json',
        '--json'
      ]);
      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, run.stderr);

      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.recorded, true);
      assert.strictEqual(payload.verdict, 'PASSED');
      assert.strictEqual(payload.testsStatus, 'PASSED (1408 passed)');
      assert.strictEqual(payload.durationMs, 196000);
      assert.strictEqual(payload.evidencePath, evidencePath(sandbox));
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('refuses when the checkpoint is not at the gate, and writes NO file', async () => {
    const sandbox = makeSandbox('IMPLEMENT');
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      assert.ok(
        run.stderr.includes('Gate evidence refused') && run.stderr.includes('IMPLEMENT'),
        `the refusal must name the stage, got:\n${run.stderr}`
      );
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'nothing may be persisted on refusal');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('refuses a self-contradictory block (PASSED with failing tests) and writes NO file', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      fs.writeFileSync(
        path.join(sandbox.dir, 'gate.json'),
        VALID_BLOCK.replace('"testsFailed": 0', '"testsFailed": 1'),
        'utf8'
      );

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      assert.ok(run.stderr.includes('testsFailed'), `the refusal must name the field, got:\n${run.stderr}`);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'an invalid block must not be persisted');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('#297 guard: a dispatched subagent may not file its own gate evidence', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    const prevCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    let stderr = '';
    try {
      process.chdir(sandbox.dir);
      process.env.AGY_SUBAGENT = '1';
      console.log = () => {};
      console.error = (msg: any) => {
        stderr += String(msg) + '\n';
      };

      const code = await runCli(['gate-report', '--issue', String(ISSUE)]);
      assert.strictEqual(code, EXIT_CODE_FAILURE);
      assert.ok(stderr.includes('Subagents are not permitted'), stderr);
      assert.ok(!fs.existsSync(evidencePath(sandbox)));
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      delete process.env.AGY_SUBAGENT;
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('--dry-run validates and prints, but writes nothing', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');
      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json',
        '--dry-run'
      ]);
      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, run.stderr);
      assert.ok(run.stdout.includes('[dry-run] Would record gate evidence'), run.stdout);
      assert.ok(!fs.existsSync(evidencePath(sandbox)));
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

describe('gate-report stage guard and Next line (issue #311)', () => {
  test('#311 C1: filing at REVIEW is refused, writes nothing, and prints no Next line', async () => {
    const sandbox = makeSandbox('REVIEW');
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      assert.ok(
        run.stderr.includes('REVIEW') && run.stderr.includes(STAGE_QUALITY_GATE),
        `the refusal must name the observed stage and the legal one, got:\n${run.stderr}`
      );
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a refused filing must write no evidence file');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
      assert.ok(!run.stdout.includes('Next:'), `no Next line at REVIEW, got:\n${run.stdout}`);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('#311 C2: the Next line printed at QUALITY_GATE is a legal transition that consumes the evidence', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);
      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, run.stderr);

      const line =
        run.stdout.split('\n').find((entry) => entry.startsWith('  Next: ')) ?? '';
      assert.ok(line.length > 0, `the filing at QUALITY_GATE must advise the next step, got:\n${run.stdout}`);
      assert.strictEqual(line, `  Next: codeloop transition ${STAGE_REVIEW} --issue ${ISSUE}`);

      const target = line.slice('  Next: codeloop transition '.length).split(' ')[0];
      assert.notStrictEqual(target, STAGE_QUALITY_GATE, 'the advice must not be a self-transition');
      assert.ok(
        ALLOWED_TRANSITIONS[STAGE_QUALITY_GATE].includes(target),
        `${target} must be a legal exit from ${STAGE_QUALITY_GATE}`
      );

      const advance = await runIn(sandbox, ['transition', target, '--issue', String(ISSUE)]);
      assert.strictEqual(
        advance.code,
        EXIT_CODE_SUCCESS,
        `the printed command must be legal, got:\n${advance.stderr}`
      );
      const checkpoint = JSON.parse(fs.readFileSync(sandbox.checkpointPath, 'utf8'));
      assert.strictEqual(checkpoint.currentStage, STAGE_REVIEW);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'the ingested evidence must be consumed');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.gateVerdict, 'PASSED');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('#311 C3: the advance formatter is stage-derived and needs no issue token', () => {
    assert.strictEqual(
      formatGateReportAdvanceCommand(STAGE_QUALITY_GATE, null),
      `codeloop transition ${STAGE_REVIEW}`
    );
    assert.strictEqual(formatGateReportAdvanceCommand(STAGE_REVIEW, ISSUE), null);
    assert.strictEqual(formatGateReportAdvanceCommand(null, ISSUE), null);
    assert.strictEqual(
      formatGateReportAdvanceCommand(STAGE_QUALITY_GATE, ISSUE),
      `codeloop transition ${STAGE_REVIEW} --issue ${ISSUE}`
    );
  });
});
