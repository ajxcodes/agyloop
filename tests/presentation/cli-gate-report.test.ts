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
  STAGE_IMPLEMENT,
  formatGateReportAdvanceCommand,
  formatGateReportExample
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
      // Issue #327 (AC-5): the refusal names the LEGAL walk-back to the gate
      // and the filing command it ends with — never an orphaned instruction.
      assert.ok(
        run.stderr.includes(`codeloop transition ${STAGE_IMPLEMENT} --issue ${ISSUE}`),
        `the walk-back must name IMPLEMENT, got:\n${run.stderr}`
      );
      assert.ok(
        run.stderr.includes(`codeloop transition ${STAGE_QUALITY_GATE} --issue ${ISSUE}`),
        `the walk-back must re-enter the gate, got:\n${run.stderr}`
      );
      assert.ok(
        run.stderr.includes(`codeloop gate-report --issue ${ISSUE} --report-file <path>`),
        `the walk-back must end with the filing command, got:\n${run.stderr}`
      );
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a refused filing must write no evidence file');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
      assert.ok(!run.stdout.includes('Next:'), `no Next line at REVIEW, got:\n${run.stdout}`);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('#327: filing at COMMIT is refused with the single direct gate hop', async () => {
    const sandbox = makeSandbox('COMMIT');
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      assert.ok(run.stderr.includes('Gate evidence refused'), run.stderr);
      assert.ok(
        run.stderr.includes(`codeloop transition ${STAGE_QUALITY_GATE} --issue ${ISSUE}`),
        `COMMIT reaches the gate directly, got:\n${run.stderr}`
      );
      assert.ok(
        !run.stderr.includes(`codeloop transition ${STAGE_IMPLEMENT} --issue ${ISSUE}`),
        `no detour through IMPLEMENT should be named at COMMIT, got:\n${run.stderr}`
      );
      assert.ok(!fs.existsSync(evidencePath(sandbox)));
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

describe('the gate prompt example files through the real CLI (issue #338)', () => {
  /** Replace every documented placeholder, exactly as the prompt instructs. */
  function filledExample(): string {
    return formatGateReportExample('PASSED')
      .replaceAll('<id>', 'node')
      .replaceAll('<command>', 'npm test')
      .replaceAll('<check-id>', 'check-1')
      .replaceAll('<check label>', 'app boots')
      .replaceAll('<gate-id>', 'e2e')
      .replaceAll('<gate label>', 'e2e suite')
      .replaceAll('<why it did not run>', 'no fixtures')
      .replaceAll('(N passed)', '(3 passed)')
      .replaceAll('"testsPassed": 0', '"testsPassed": 3')
      .replaceAll('"passed": 0, "failed": 0', '"passed": 3, "failed": 0')
      .replaceAll('"durationMs": 0', '"durationMs": 69000');
  }

  test('#338 T3.1: the documented shape is the ACCEPTED shape', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.txt'), filledExample(), 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.txt'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `expected exit 0, got:\n${run.stderr}`);
      assert.ok(
        run.stdout.includes('✓ Gate evidence recorded: PASSED — node — PASSED (3 passed) — 1m 9s'),
        run.stdout
      );

      const recorded = JSON.parse(fs.readFileSync(evidencePath(sandbox), 'utf8'));
      assert.strictEqual(recorded.smokeChecks.length, 1);
      assert.strictEqual(recorded.smokeChecks[0].id, 'check-1');
      assert.strictEqual(recorded.smokeChecks[0].label, 'app boots');
      assert.strictEqual(recorded.smokeChecks[0].passed, true);
      assert.strictEqual(recorded.notRun.length, 1);
      assert.strictEqual(recorded.notRun[0].id, 'e2e');
      assert.strictEqual(recorded.notRun[0].reason, 'no fixtures');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('#338 T3.2: the shapes the prompt now forbids still fail, naming the field', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      const naturalButUndocumented = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (3 passed)", "testsPassed": 3, "testsFailed": 0,
  "durationMs": 69000, "executedCommands": ["npm test"],
  "smokeChecks": [{ "check": 1, "planLine": 666, "status": "PASSED" }] }
`;
      fs.writeFileSync(path.join(sandbox.dir, 'gate.txt'), naturalButUndocumented, 'utf8');
      const rejected = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.txt'
      ]);
      assert.strictEqual(rejected.code, EXIT_CODE_FAILURE);
      assert.ok(rejected.stderr.includes('smokeChecks.id'), rejected.stderr);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a rejected block writes no evidence');

      const bareStrings = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (3 passed)", "testsPassed": 3, "testsFailed": 0,
  "durationMs": 69000, "executedCommands": ["npm test"],
  "notRun": ["act: no CI-workflow simulation in scope"] }
`;
      fs.writeFileSync(path.join(sandbox.dir, 'gate.txt'), bareStrings, 'utf8');
      const rejectedNotRun = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.txt'
      ]);
      assert.strictEqual(rejectedNotRun.code, EXIT_CODE_FAILURE);
      assert.ok(rejectedNotRun.stderr.includes('notRun'), rejectedNotRun.stderr);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a rejected block writes no evidence');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #408 (D2): filing a PASSED block that does not cover the plan's
 * declared `### Quality Gate Targets` is refused — at filing and on
 * `--dry-run` — and a plan with no targets keeps today's behaviour.
 */
describe('gate-report declared-command coverage (issue #408)', () => {
  const PLAN_DIR = `artifacts/plans/${ISSUE}-smoke`;
  const FOUR_TARGETS = ['npm run build', 'npm run typecheck', 'npm run lint', 'npm test'];

  /** Writes a plan declaring `commands`, and points the checkpoint at it. */
  function seedPlanWithTargets(sandbox: Sandbox, commands: readonly string[]): void {
    const planDir = path.join(sandbox.dir, PLAN_DIR);
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, 'implementation_plan.md'),
      ['# [Implementation] - probe', '', '### Quality Gate Targets', '', '```bash', ...commands, '```', ''].join(
        '\n'
      ),
      'utf8'
    );
    const checkpoint = JSON.parse(fs.readFileSync(sandbox.checkpointPath, 'utf8'));
    checkpoint.planDir = PLAN_DIR;
    fs.writeFileSync(sandbox.checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf8');
  }

  /** Writes a full valid `GATE_REPORT_JSON` block and returns its path. */
  function writeReport(
    sandbox: Sandbox,
    options: {
      verdict?: string;
      executedCommands: readonly string[];
      commandResults?: ReadonlyArray<{ command: string; passed: number | null; failed: number | null }>;
    }
  ): string {
    const verdict = options.verdict ?? 'PASSED';
    const passed = verdict === 'PASSED';
    const payload = {
      verdict,
      buildSystem: 'node',
      buildStatus: verdict,
      testsStatus: passed ? 'PASSED (4 passed)' : 'FAILED (1 failed)',
      testsPassed: passed ? 4 : 0,
      testsFailed: passed ? 0 : 1,
      durationMs: 1000,
      executedCommands: options.executedCommands,
      commandResults: options.commandResults ?? [],
      smokeProtocol: 'NOT_DECLARED',
      notRun: []
    };
    const file = path.join(sandbox.dir, 'gate.json');
    fs.writeFileSync(
      file,
      `${GATE_REPORT_JSON_MARKER}\n${JSON.stringify(payload)}\n`,
      'utf8'
    );
    return file;
  }

  test('T-CLI-1: full coverage over four declared targets files the evidence', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      seedPlanWithTargets(sandbox, FOUR_TARGETS);
      writeReport(sandbox, { executedCommands: FOUR_TARGETS });
      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, run.stderr);
      assert.ok(run.stdout.includes('✓ Gate evidence recorded'), run.stdout);
      assert.ok(fs.existsSync(evidencePath(sandbox)), 'full coverage must be filed');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('T-CLI-2: one missing command is refused, naming the other three', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      seedPlanWithTargets(sandbox, FOUR_TARGETS);
      writeReport(sandbox, { executedCommands: ['npm run build'] });
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      for (const command of ['npm run typecheck', 'npm run lint', 'npm test']) {
        assert.ok(run.stderr.includes(command), `stderr must name ${command}:\n${run.stderr}`);
      }
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a partial report writes no evidence');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('T-CLI-3: empty coverage is refused, naming all four commands', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      seedPlanWithTargets(sandbox, FOUR_TARGETS);
      writeReport(sandbox, { executedCommands: [], commandResults: [] });

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      for (const command of FOUR_TARGETS) {
        assert.ok(run.stderr.includes(command), `stderr must name ${command}:\n${run.stderr}`);
      }
      assert.ok(!fs.existsSync(evidencePath(sandbox)));
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('T-CLI-4: a plan with no targets heading keeps today’s behaviour', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      writeReport(sandbox, { executedCommands: ['npm run build'] });
      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, run.stderr);
      assert.ok(fs.existsSync(evidencePath(sandbox)));
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('T-CLI-5: --dry-run reports the same missing commands and writes nothing', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      seedPlanWithTargets(sandbox, FOUR_TARGETS);
      writeReport(sandbox, { executedCommands: ['npm run build'] });
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json',
        '--dry-run'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.ok(output.includes('[dry-run]'), output);
      for (const command of ['npm run typecheck', 'npm run lint', 'npm test']) {
        assert.ok(output.includes(command), `the dry run must name ${command}:\n${output}`);
      }
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a dry run writes no evidence');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
      assert.ok(!output.includes('Next:'), `a refused dry run prints no Next line:\n${output}`);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('T-CLI-6: a FAILED report is not coverage-checked (only PASSED certifies)', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      seedPlanWithTargets(sandbox, FOUR_TARGETS);
      writeReport(sandbox, { verdict: 'FAILED', executedCommands: ['npm run build'] });

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, run.stderr);
      assert.ok(fs.existsSync(evidencePath(sandbox)));
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #412: a PASSED block that names a test command while recording
 * `testsPassed = 0` is not evidence — refused at filing, and on `--dry-run`.
 */
describe('gate-report zero-test evidence floor (issue #412)', () => {
  function writeBlock(
    sandbox: Sandbox,
    block: {
      verdict?: string;
      testsStatus: string;
      testsPassed: number | null;
      testsFailed?: number;
      executedCommands: readonly string[];
      notRun?: ReadonlyArray<{ id: string; label: string; reason: string }>;
    }
  ): string {
    const file = path.join(sandbox.dir, 'gate.json');
    fs.writeFileSync(
      file,
      `${GATE_REPORT_JSON_MARKER}\n${JSON.stringify({
        verdict: block.verdict ?? 'PASSED',
        buildSystem: 'node',
        buildStatus: block.verdict ?? 'PASSED',
        testsStatus: block.testsStatus,
        testsPassed: block.testsPassed,
        testsFailed: block.testsFailed ?? 0,
        durationMs: 1000,
        executedCommands: block.executedCommands,
        smokeProtocol: 'NOT_DECLARED',
        notRun: block.notRun ?? []
      })}\n`,
      'utf8'
    );
    return file;
  }

  test('F-Z1: the zero-test block is refused, names the command and writes nothing', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      writeBlock(sandbox, {
        testsStatus: 'PASSED (0 passed)',
        testsPassed: 0,
        testsFailed: 0,
        executedCommands: ['npm test']
      });
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      assert.ok(run.stderr.includes('npm test'), run.stderr);
      assert.ok(run.stderr.includes('testsPassed'), run.stderr);
      assert.ok(run.stderr.includes('Nothing was written'), run.stderr);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a zero-test block writes no evidence');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('F-Z2: the same block on --dry-run reports the refusal and writes nothing', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      writeBlock(sandbox, {
        testsStatus: 'PASSED (0 passed)',
        testsPassed: 0,
        testsFailed: 0,
        executedCommands: ['npm test']
      });

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json',
        '--dry-run'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.ok(output.includes('[dry-run]'), output);
      assert.ok(output.includes('npm test'), output);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a dry run writes no evidence');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('F-Z3: a build-only PASSED block with zero tests is recorded', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      writeBlock(sandbox, {
        testsStatus: 'PASSED (0 passed)',
        testsPassed: 0,
        testsFailed: 0,
        executedCommands: ['npm run build']
      });

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, run.stderr);
      assert.ok(fs.existsSync(evidencePath(sandbox)));
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('F-Z4: a positive aggregate with a zero per-command count is refused', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      const halfFilled = filledExampleBlockWithoutCommandCount();
      fs.writeFileSync(path.join(sandbox.dir, 'gate.txt'), halfFilled, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.txt'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE, run.stderr);
      assert.ok(run.stderr.includes('npm test'), run.stderr);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a half-filled block writes no evidence');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  /** The documented example with a positive aggregate but the raw `passed: 0`. */
  function filledExampleBlockWithoutCommandCount(): string {
    return formatGateReportExample('PASSED')
      .replaceAll('<id>', 'node')
      .replaceAll('<command>', 'npm test')
      .replaceAll('<check-id>', 'check-1')
      .replaceAll('<check label>', 'app boots')
      .replaceAll('<gate-id>', 'e2e')
      .replaceAll('<gate label>', 'e2e suite')
      .replaceAll('<why it did not run>', 'no fixtures')
      .replaceAll('(N passed)', '(3 passed)')
      .replaceAll('"testsPassed": 0', '"testsPassed": 3')
      .replaceAll('"durationMs": 0', '"durationMs": 69000');
  }

  test('F-Z5: a null-count block is refused, names the command and the token, and writes nothing', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      writeBlock(sandbox, {
        testsStatus: 'PASSED',
        testsPassed: null,
        executedCommands: ['npm test']
      });
      const before = fs.readFileSync(sandbox.checkpointPath, 'utf8');

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      assert.ok(run.stderr.includes('npm test'), run.stderr);
      assert.ok(run.stderr.includes('testsPassed'), run.stderr);
      assert.ok(run.stderr.includes('TEST_METRICS'), run.stderr);
      assert.ok(run.stderr.includes('Nothing was written'), run.stderr);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a null-count block writes no evidence');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPath, 'utf8'), before);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('F-Z6: the same null-count block on --dry-run reports the refusal and writes nothing', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      writeBlock(sandbox, {
        testsStatus: 'PASSED',
        testsPassed: null,
        executedCommands: ['npm test']
      });

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json',
        '--dry-run'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_FAILURE);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.ok(output.includes('[dry-run]'), output);
      assert.ok(output.includes('npm test'), output);
      assert.ok(!fs.existsSync(evidencePath(sandbox)), 'a dry run writes no evidence');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('F-Z7: a build-only PASSED block with a null count is recorded', async () => {
    const sandbox = makeSandbox('QUALITY_GATE');
    try {
      writeBlock(sandbox, {
        testsStatus: 'PASSED',
        testsPassed: null,
        executedCommands: ['npm run build']
      });

      const run = await runIn(sandbox, [
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, run.stderr);
      assert.ok(fs.existsSync(evidencePath(sandbox)));
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
