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
const { FilePlanGenerator } = require('../../dist/infrastructure');
const { makeSandbox: makeSandboxCanonical } = require('../helpers/sandbox.ts');
const { readCheckpoint } = require('../helpers/state-seed.ts');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');
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

function makeGateEvidenceSandbox(options: { withPlan?: boolean } = {}) {
  const sandbox = makeSandboxCanonical({
    prefix: 'agyloop-cli-gate-evidence-',
    dirName: '',
    gitignore: false,
    initialBranch: 'main',
    seed: (dir: string) => {
      fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
    },
    initialCommit: 'chore: base'
  });
  const dir = sandbox.dir;

  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  if (options.withPlan) {
    seedPlanDir(dir);
  }
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
    checkpointPathLocal,
    evidencePath: path.join(dir, '.agyloop', 'tasks', `${ISSUE}.gate.json`)
  };
}



describe('QUALITY_GATE exit consumes evidence (issue #327)', () => {
  test('GE1: no evidence refuses the exit, writes nothing and records no REVIEW row', async () => {
    const sandbox = makeGateEvidenceSandbox();
    try {
      const before = fs.readFileSync(sandbox.checkpointPathLocal, 'utf8');

      const run = await runCliInSandboxCanonical(['transition', 'REVIEW', '--issue', String(ISSUE)], { dir: sandbox.dir });

      assert.strictEqual(run.code, EXIT_CODE_FAILURE, run.stdout);
      assert.ok(run.stderr.includes('Gate evidence refused'), run.stderr);
      assert.ok(run.stderr.includes(`codeloop gate-report --issue ${ISSUE}`), run.stderr);
      assert.ok(run.stderr.includes(`codeloop transition ${STAGE_REVIEW} --issue ${ISSUE}`), run.stderr);

      assert.strictEqual(
        fs.readFileSync(sandbox.checkpointPathLocal, 'utf8'),
        before,
        'a refusal must leave the checkpoint byte-identical'
      );
      const checkpoint = readCheckpoint(sandbox.checkpointPathLocal);
      assert.strictEqual(checkpoint.currentStage, STAGE_QUALITY_GATE);
      assert.ok(!checkpoint.history.some((entry: any) => entry.stage === STAGE_REVIEW));
      assert.ok(!fs.existsSync(sandbox.evidencePath), 'a refusal must not create evidence');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('GE2: file then transition records the verdict and consumes the evidence', async () => {
    const sandbox = makeGateEvidenceSandbox();
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');

      const filed = await runCliInSandboxCanonical([
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ], { dir: sandbox.dir });
      assert.strictEqual(filed.code, EXIT_CODE_SUCCESS, filed.stderr);
      assert.ok(fs.existsSync(sandbox.evidencePath));

      const advance = await runCliInSandboxCanonical(['transition', 'REVIEW', '--issue', String(ISSUE)], { dir: sandbox.dir });
      assert.strictEqual(advance.code, EXIT_CODE_SUCCESS, advance.stderr);

      const checkpoint = readCheckpoint(sandbox.checkpointPathLocal);
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
    const sandbox = makeGateEvidenceSandbox();
    try {
      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');
      await runCliInSandboxCanonical(['gate-report', '--issue', String(ISSUE), '--report-file', 'gate.json'], { dir: sandbox.dir });
      await runCliInSandboxCanonical(['transition', 'REVIEW', '--issue', String(ISSUE)], { dir: sandbox.dir });

      const late = await runCliInSandboxCanonical([
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ], { dir: sandbox.dir });

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
      assert.strictEqual(readCheckpoint(sandbox.checkpointPathLocal).currentStage, STAGE_REVIEW);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

describe('stage-boundary operator output (issue #315)', () => {
  test('AC-10: QG -> PLAN names the re-plan sequence, never the gate walk-back', async () => {
    const sandbox = makeGateEvidenceSandbox({ withPlan: true });
    try {
      const run = await runCliInSandboxCanonical(['transition', 'PLAN', '--issue', String(ISSUE)], { dir: sandbox.dir });

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
      assert.strictEqual(readCheckpoint(sandbox.checkpointPathLocal).currentStage, 'PLAN');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('AC-10 regression: QG -> IMPLEMENT keeps the gate walk-back', async () => {
    const sandbox = makeGateEvidenceSandbox({ withPlan: true });
    try {
      const run = await runCliInSandboxCanonical([
        'transition',
        'IMPLEMENT',
        '--issue',
        String(ISSUE),
        '--no-worktree'
      ], { dir: sandbox.dir });

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
    const sandbox = makeGateEvidenceSandbox({ withPlan: true });
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
      await runCliInSandboxCanonical(['gate-report', '--issue', String(ISSUE), '--report-file', 'gate.json'], { dir: sandbox.dir });
      const advance = await runCliInSandboxCanonical(['transition', 'REVIEW', '--issue', String(ISSUE)], { dir: sandbox.dir });
      assert.strictEqual(advance.code, EXIT_CODE_SUCCESS, advance.stderr);

      const checkpoint = readCheckpoint(sandbox.checkpointPathLocal);
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

/**
 * Issue #408 (D1): a REFUSED exit keeps the filed report.
 *
 * The consume-on-ingest clear used to run before the digest guard, so the
 * checkpoint stayed at QUALITY_GATE while `tasks/<n>.gate.json` was deleted —
 * "nothing was written" was true of the checkpoint and false of the evidence.
 */
describe('a refused gate exit preserves filed evidence (issue #408)', () => {
  test('T-D1-E2E: a refused digest keeps the evidence, and the repaired retry consumes it once', async () => {
    const sandbox = makeGateEvidenceSandbox({ withPlan: true });
    try {
      const planPath = path.join(sandbox.dir, PLAN_DIR, 'implementation_plan.md');
      const checkpoint = readCheckpoint(sandbox.checkpointPathLocal);
      checkpoint.approvedPlanPath = planPath;
      checkpoint.approvedPlanDigest = 'deadbeef';
      fs.writeFileSync(
        sandbox.checkpointPathLocal,
        `${JSON.stringify(checkpoint, null, 2)}\n`,
        'utf8'
      );
      const before = fs.readFileSync(sandbox.checkpointPathLocal, 'utf8');

      fs.writeFileSync(path.join(sandbox.dir, 'gate.json'), VALID_BLOCK, 'utf8');
      const filed = await runCliInSandboxCanonical([
        'gate-report',
        '--issue',
        String(ISSUE),
        '--report-file',
        'gate.json'
      ], { dir: sandbox.dir });
      assert.strictEqual(filed.code, EXIT_CODE_SUCCESS, filed.stderr);
      assert.ok(fs.existsSync(sandbox.evidencePath));

      const refused = await runCliInSandboxCanonical([
        'transition',
        'REVIEW',
        '--issue',
        String(ISSUE)
      ], { dir: sandbox.dir });

      assert.strictEqual(refused.code, EXIT_CODE_FAILURE, refused.stdout);
      assert.match(refused.stderr, /changed during the quality gate/i);
      assert.match(refused.stderr, /NOT consumed/);
      assert.ok(fs.existsSync(sandbox.evidencePath), 'the refusal must not delete the report');
      assert.strictEqual(fs.readFileSync(sandbox.checkpointPathLocal, 'utf8'), before);
      assert.strictEqual(readCheckpoint(sandbox.checkpointPathLocal).currentStage, STAGE_QUALITY_GATE);

      // Repair the digest only: the SAME filed block certifies the exit.
      const repaired = readCheckpoint(sandbox.checkpointPathLocal);
      repaired.approvedPlanDigest = new FilePlanGenerator().hashPlanDocument(planPath);
      fs.writeFileSync(
        sandbox.checkpointPathLocal,
        `${JSON.stringify(repaired, null, 2)}\n`,
        'utf8'
      );

      const advanced = await runCliInSandboxCanonical([
        'transition',
        'REVIEW',
        '--issue',
        String(ISSUE)
      ], { dir: sandbox.dir });
      assert.strictEqual(advanced.code, EXIT_CODE_SUCCESS, advanced.stderr);
      assert.strictEqual(readCheckpoint(sandbox.checkpointPathLocal).currentStage, STAGE_REVIEW);
      assert.ok(!fs.existsSync(sandbox.evidencePath), 'the committed exit consumes exactly once');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
