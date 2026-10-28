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
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PLAN_DIR = `artifacts/plans/${ISSUE}-smoke`;

const VALID_BLOCK = `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (1899 passed)", "testsPassed": 1899, "testsFailed": 0,
  "durationMs": 196000, "executedCommands": ["npm run lint", "npm test"],
  "smokeProtocol": "PASSED", "notRun": [] }
`;

/**
 * Creates the plan directory a transition to PLAN / a gate row needs: the
 * summary the writer rewrites, plus a plan the target parser can read.
 */
function seedPlanDir(dir: string): void {
  const planDir = path.join(dir, PLAN_DIR);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, 'implementation_plan.md'),
    ['# [Implementation] - Smoke', '', '- [ ] Step 1: probe', '', '## 4. Quality Gate & Test Verification', '', '### Quality Gate Targets', '', '```bash', 'npm test', '```', ''].join('\n'),
    'utf8'
  );
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', 'summary-log.md'), path.join(planDir, 'CodeLoop Summary.md'));
}

function makeSandbox(options: { withPlan?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-gate-evidence-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: base'], { cwd: dir, stdio: 'ignore' });

  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  if (options.withPlan) {
    seedPlanDir(dir);
  }
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
        ...(options.withPlan ? { planDir: PLAN_DIR } : {}),
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
  const originalWarn = console.warn;
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
    // The transition advice is a `console.warn`, which reaches stderr in a real
    // invocation; capturing only `console.error` would silently miss it.
    console.warn = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
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

describe('stage-boundary operator output (issue #315)', () => {
  test('AC-10: QG -> PLAN names the re-plan sequence, never the gate walk-back', async () => {
    const sandbox = makeSandbox({ withPlan: true });
    try {
      const run = await runIn(sandbox.dir, ['transition', 'PLAN', '--issue', String(ISSUE)]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `${run.stdout}\n${run.stderr}`);
      assert.ok(
        run.stderr.includes('APPROVAL'),
        `the re-plan sequence must be named, got: ${run.stderr}`
      );
      assert.ok(
        !run.stderr.includes('return to the gate'),
        `a re-plan exit must never advise walking back into the gate, got: ${run.stderr}`
      );
      assert.ok(
        !run.stderr.includes('gate-report'),
        `a re-plan exit must never ask for evidence for a round that was not dispatched, got: ${run.stderr}`
      );
      assert.strictEqual(readCheckpoint(sandbox.checkpointPath).currentStage, 'PLAN');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('AC-10 regression: QG -> IMPLEMENT keeps the gate walk-back', async () => {
    const sandbox = makeSandbox({ withPlan: true });
    try {
      const run = await runIn(sandbox.dir, [
        'transition',
        'IMPLEMENT',
        '--issue',
        String(ISSUE),
        '--no-worktree'
      ]);

      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `${run.stdout}\n${run.stderr}`);
      assert.ok(
        run.stderr.includes('return to the gate'),
        `a fix-it exit still needs its evidence next round, got: ${run.stderr}`
      );
      assert.ok(run.stderr.includes('gate-report'), run.stderr);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('AC-17: smoke labels never enter executedCommands, and render on their own line', async () => {
    const sandbox = makeSandbox({ withPlan: true });
    try {
      fs.writeFileSync(
        path.join(sandbox.dir, 'gate.json'),
        `${GATE_REPORT_JSON_MARKER}
{ "verdict": "PASSED", "buildSystem": "node", "buildStatus": "PASSED",
  "testsStatus": "PASSED (1899 passed)", "testsPassed": 1899, "testsFailed": 0,
  "durationMs": 196000,
  "executedCommands": ["npm run lint", "npm run typecheck", "npm run build", "node --test tests/a.test.ts", "npm test",
    "smoke-check-1: app boots PASSED", "smoke-check-2: login FAILED", "smoke-check-3: dark mode", "smoke-check-4: export PASSED"],
  "smokeProtocol": "PASSED", "notRun": [] }
`,
        'utf8'
      );
      await runIn(sandbox.dir, ['gate-report', '--issue', String(ISSUE), '--report-file', 'gate.json']);
      const advance = await runIn(sandbox.dir, ['transition', 'REVIEW', '--issue', String(ISSUE)]);
      assert.strictEqual(advance.code, EXIT_CODE_SUCCESS, advance.stderr);

      const checkpoint = readCheckpoint(sandbox.checkpointPath);
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(
        last.metadata.gateExecutedCommands.length,
        5,
        `the plan names 5 commands, got: ${JSON.stringify(last.metadata.gateExecutedCommands)}`
      );
      assert.ok(
        !last.metadata.gateExecutedCommands.some((entry: string) => /smoke-check/i.test(entry)),
        'a smoke-check label is not a command'
      );
      assert.strictEqual(last.metadata.gateSmokeChecks.length, 4);

      const summary = fs.readFileSync(
        path.join(sandbox.dir, PLAN_DIR, 'CodeLoop Summary.md'),
        'utf8'
      );
      const commandsLine = summary
        .split('\n')
        .find((line: string) => line.startsWith('- **Executed Commands:**'));
      assert.ok(commandsLine, `the summary must list the executed commands, got:\n${summary}`);
      assert.ok(!/smoke-check/i.test(commandsLine as string), commandsLine as string);
      assert.strictEqual(
        (commandsLine as string).split('`').length - 1,
        10,
        `five commands are five backtick pairs, got: ${commandsLine}`
      );

      const smokeLine = summary
        .split('\n')
        .find((line: string) => line.startsWith('- **Smoke Checks:**'));
      assert.ok(smokeLine, `the summary must carry a separate smoke-checks line, got:\n${summary}`);
      assert.ok((smokeLine as string).includes('✅'), smokeLine as string);
      assert.ok((smokeLine as string).includes('❌'), smokeLine as string);
      assert.ok((smokeLine as string).includes('❔'), smokeLine as string);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
