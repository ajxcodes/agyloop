/**
 * agyloop - operator output is TRUE when piped and when the checkpoint is absent
 * (issue #315, Defects A and G7)
 *
 * A pager is normal usage: `codeloop status | head -n 1`, `| less` (quit early).
 * Before the guard, the second write after the reader closed threw an unhandled
 * `EPIPE` and killed the process with a stack trace and exit 1 — so the report
 * crashed exactly when an operator was reading it.
 *
 * This file owns the entrypoint guard (AC-1/AC-2) and the truthful checkpoint
 * line (AC-9). Stage-boundary cases (planner block, advance line, review
 * header, counters) live in the suites that own those commands.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'codeloop.js');

interface Sandbox {
  readonly dir: string;
}

function makeSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-output-truthfulness-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: seed'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  return { dir };
}

/** Runs the CLI in `dir` and captures both streams, in-process. */
async function runCliIn(dir: string, args: readonly string[]) {
  const { runCli } = require('../../dist/presentation/cli');
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalIsTTY = process.stdin.isTTY;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(dir);
    process.stdin.isTTY = false;
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    process.stdin.isTTY = originalIsTTY;
  }
}

/**
 * Seeds a checkpoint with a history long enough that the report spans many
 * writes — the condition under which a closed consumer really does produce an
 * `EPIPE` on a subsequent write.
 */
function seedLongHistory(dir: string, entries: number): void {  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  const history = Array.from({ length: entries }, (_, index) => ({
    stage: index % 2 === 0 ? 'REVIEW' : 'QUALITY_GATE',
    timestamp: now
  }));
  fs.writeFileSync(
    path.join(tasksDir, '315.json'),
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'REVIEW',
      mode: 'standard',
      issue: 315,
      baseBranch: 'main',
      createdAt: now,
      updatedAt: now,
      history
    }),
    'utf8'
  );
}

/**
 * Spawns `status` with a piped stdout and destroys the read end on the FIRST
 * chunk — the exact thing `head`/`less` do. The report is long, so the process
 * still has writes to make after the consumer is gone.
 */
function runStatusIntoClosedPipe(dir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'status'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGY_SUBAGENT: '', HOME: path.join(dir, '.home') }
    });
    let stdout = '';
    let stderr = '';
    let closed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!closed) {
        closed = true;
        child.stdout.destroy();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code: number | null) => resolve({ code, stdout, stderr }));
  });
}

describe('a closed consumer never turns a report into a crash (AC-1, AC-2)', () => {
  test('status piped into a closed consumer exits 0 with no stack trace', async () => {
    const sandbox = makeSandbox();
    try {
      seedLongHistory(sandbox.dir, 2_000);
      const run = await runStatusIntoClosedPipe(sandbox.dir);

      assert.strictEqual(run.code, 0, `a pager must not fail the report:\n${run.stderr}`);
      assert.ok(
        !/EPIPE/.test(run.stderr),
        `no EPIPE may reach stderr, got:\n${run.stderr}`
      );
      assert.ok(
        !/Unhandled 'error' event/.test(run.stderr),
        `no unhandled stream error may reach stderr, got:\n${run.stderr}`
      );
      assert.ok(
        !/^\s+at\s+\S+/m.test(run.stderr),
        `no stack trace may reach stderr, got:\n${run.stderr}`
      );

      const firstNonEmpty = run.stdout.split('\n').find((line) => line.trim().length > 0);
      assert.strictEqual(
        firstNonEmpty,
        '=== CodeLoop: Pipeline Status ===',
        `the report's header is still the first non-empty line, got: ${firstNonEmpty}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('status > /dev/null still exits 0 and the guard is installed once', () => {
    const sandbox = makeSandbox();
    try {
      const run = spawnSync(process.execPath, [BIN, 'status'], {
        cwd: sandbox.dir,
        encoding: 'utf8',
        env: { ...process.env, AGY_SUBAGENT: '', HOME: path.join(sandbox.dir, '.home') }
      });
      assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stdout.includes('=== CodeLoop: Pipeline Status ==='), run.stdout);
      assert.strictEqual(run.stderr, '', run.stderr);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('a non-EPIPE stream error is re-thrown, never swallowed into success', () => {
    // Runs in a child so the deliberate throw cannot take the test runner down.
    // The guard's contract: EPIPE/ECONNRESET exit 0; anything else is a REAL
    // write failure and must surface exactly as Node would have surfaced it —
    // as an uncaught exception, not a success exit.
    const sandbox = makeSandbox();
    const resultPath = `${sandbox.dir}.guard-result.json`;
    try {
      const script = `
        const fs = require('fs');
        const out = process.argv[1];
        const record = (payload) => {
          try { fs.writeFileSync(out, JSON.stringify(payload)); } catch (err) { /* last resort */ }
        };
        process.on('uncaughtException', (err) => {
          record({ uncaughtCode: err && err.code, uncaughtMessage: err && err.message });
          process.exit(0);
        });
        const { runCli } = require(${JSON.stringify(path.join(REPO_ROOT, 'dist', 'presentation', 'cli.js'))});
        runCli(['status']).then(() => {
          // The guard listens on process.stdout; emit the failure directly so no
          // real write is required. EPIPE would exit 0 inside the guard, so a
          // surviving EIO proves the non-EPIPE branch re-throws.
          const ioError = Object.assign(new Error('i/o failure'), { code: 'EIO' });
          process.stdout.emit('error', ioError);
          // Reaching this timeout means the guard swallowed the error.
          setTimeout(() => {
            record({ uncaughtCode: 'SWALLOWED' });
            process.exit(0);
          }, 800);
        }, (err) => {
          record({ rejected: String(err) });
        });
      `;
      const child = spawnSync(process.execPath, ['-e', script, resultPath], {
        cwd: sandbox.dir,
        encoding: 'utf8',
        env: { ...process.env, AGY_SUBAGENT: '', HOME: path.join(sandbox.dir, '.home') }
      });
      assert.strictEqual(child.status, 0, `the child must exit 0, got:\n${child.stdout}\n${child.stderr}`);
      const recorded = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      assert.strictEqual(
        recorded.uncaughtCode,
        'EIO',
        `a real write failure must be re-thrown, got ${JSON.stringify(recorded)}`
      );
      assert.strictEqual(recorded.uncaughtMessage, 'i/o failure');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
      fs.rmSync(resultPath, { force: true });
    }
  });
});

describe('a report never names a checkpoint that does not exist (AC-9)', () => {  test('status says (not created yet) and status --json carries stateFileExists:false', async () => {
    const sandbox = makeSandbox();
    try {
      const human = await runCliIn(sandbox.dir, ['status']);
      assert.strictEqual(human.code, 0, human.stderr);
      const checkpointLine = human.stdout
        .split('\n')
        .find((line: string) => line.trimStart().startsWith('Checkpoint'));
      assert.ok(checkpointLine, `the Checkpoint line must exist, got:\n${human.stdout}`);
      assert.ok(
        checkpointLine!.includes('(not created yet)'),
        `a missing checkpoint must be named as missing, got: ${checkpointLine}`
      );
      assert.ok(
        !checkpointLine!.includes('.agyloop/state.json'),
        `a path that does not exist must not be printed as the checkpoint, got: ${checkpointLine}`
      );

      const json = await runCliIn(sandbox.dir, ['status', '--json']);
      assert.strictEqual(json.code, 0, json.stderr);
      const parsed = JSON.parse(json.stdout);
      assert.strictEqual(parsed.stateFileExists, false);
      // The resolution target is preserved for consumers that address it.
      assert.ok(
        parsed.stateFilePath.endsWith(path.join('.agyloop', 'state.json')),
        parsed.stateFilePath
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('an existing checkpoint is named and stateFileExists is true', async () => {
    const sandbox = makeSandbox();
    try {
      seedLongHistory(sandbox.dir, 1);
      const human = await runCliIn(sandbox.dir, ['status', '--issue', '315']);
      const checkpointLine = human.stdout
        .split('\n')
        .find((line: string) => line.trimStart().startsWith('Checkpoint'));
      assert.ok(checkpointLine!.includes(path.join('tasks', '315.json')), checkpointLine);

      const json = await runCliIn(sandbox.dir, ['status', '--json', '--issue', '315']);
      assert.strictEqual(JSON.parse(json.stdout).stateFileExists, true);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

describe('an unknown command names codeloop (AC-8)', () => {
  test('the hint never sends the operator to the deprecated launcher', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await runCliIn(sandbox.dir, ['bogus-command']);

      assert.strictEqual(run.code, 1, run.stderr);
      assert.match(run.stderr, /Run "codeloop --help" for available commands\./);
      assert.doesNotMatch(
        run.stderr,
        /agyloop/,
        `the help hint must not teach the deprecated launcher, got:\n${run.stderr}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Stage-boundary operator output (issue #315, Phase 3)
 * ------------------------------------------------------------------------- */

const STAGE_ISSUE = 315;
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/** A discovery report `DiscoveryReport.isPopulated` accepts. */
const POPULATED_RCA = [
  '# [Discovery] - Stage boundary output',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:** plan advertises a planner at DISCOVERY and claims advances it did not make.',
  '- **Expected Behavior:** the block names the subagent the invocation concerns, and an advance is only claimed when one happened.',
  '- **Affected Components / Paths:** `src/presentation/cli.ts`.',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:** re-read the plan case and the result shape it receives.',
  '- **Identified Failure Mode:** the block was printed unconditionally from `plannerDef`.',
  '- **Relevant Code References:** `cli.ts:3351`, `start-planning.ts:321`.',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '- **Local Reproduction Command:** `codeloop plan --issue 315 --dry-run`',
  '- **Failing Test Target:** `tests/presentation/cli-output-truthfulness.test.ts`',
  '',
  '## 4. Remediation Strategy',
  '- **Recommended Fix Approach:** gate the block on the stage that is next actionable.',
  '- **Potential Regressions / Side Effects:** a planner is no longer advertised from DISCOVERY.'
].join('\n');

function seedCheckpoint(dir: string, issue: number, snapshot: Record<string, unknown>): void {
  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(tasksDir, `${issue}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        mode: 'standard',
        issue,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0,
        ...snapshot
      },
      null,
      2
    ),
    'utf8'
  );
}

/**
 * Seeds a plan directory for the issue, optionally with a populated RCA report
 * (which is what lets DISCOVERY advance instead of parking).
 */
function seedPlanDir(
  dir: string,
  issue: number,
  options: { readonly populatedRca?: boolean } = {}
): string {
  const planDir = path.join(dir, 'artifacts', 'plans', `${issue}-smoke`);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, 'implementation_plan.md'),
    [
      '# [Implementation] - Stage boundary output',
      '',
      '## 3. Implementation Steps',
      '- [ ] Step 1: gate the planner block',
      '- [ ] Step 2: guard the advance line',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, 'templates', 'summary-log.md'),
    path.join(planDir, 'CodeLoop Summary.md')
  );
  if (options.populatedRca) {
    fs.writeFileSync(path.join(planDir, '[Discovery] - Stage boundary output.md'), POPULATED_RCA, 'utf8');
  }
  return planDir;
}

function readCheckpoint(dir: string, issue: number): any {
  return JSON.parse(
    fs.readFileSync(path.join(dir, '.agyloop', 'tasks', `${issue}.json`), 'utf8')
  );
}

describe('plan at a stage it does not leave (AC-3, AC-4, AC-5)', () => {
  test('a DISCOVERY park never attributes the planner', async () => {
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE);
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE)]);
      const stdout = run.stdout.replace(ANSI_ESCAPE, '');

      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(/Parked at DISCOVERY/.test(stdout), stdout);
      assert.ok(!/planner/.test(stdout), `a park must not advertise a planner, got:\n${stdout}`);
      assert.ok(
        !/Model Tier\s*:\s*pro/.test(stdout),
        'a `pro` attribution for an invocation that never happened, got:\n' + stdout
      );
      assert.ok(/Subagent\s*:\s*discovery/.test(stdout), `the park must name discovery, got:\n${stdout}`);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('a DISCOVERY advance never attributes the planner', async () => {
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE, { populatedRca: true });
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE)]);
      const stdout = run.stdout.replace(ANSI_ESCAPE, '');

      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(/Pipeline advanced to \[PLAN\]/.test(stdout), stdout);
      assert.ok(
        !/planner/.test(stdout),
        `an advance must not attribute a planner dispatch, got:\n${stdout}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('at PLAN the block prints the model the next directive uses', async () => {
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE, { populatedRca: true });
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'PLAN',
        planDir,
        history: [
          { stage: 'DISCOVERY', timestamp: new Date(Date.now() - 60_000).toISOString() },
          { stage: 'PLAN', timestamp: new Date().toISOString() }
        ]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE)]);
      const stdout = run.stdout.replace(ANSI_ESCAPE, '');
      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(/Subagent\s*:\s*planner/.test(stdout), stdout);

      const modelMatch = /Model Tier\s*:\s*(\S+)/.exec(stdout);
      assert.ok(modelMatch, `the planner block must name a model, got:\n${stdout}`);

      const next = await runCliIn(sandbox.dir, ['next', '--issue', String(STAGE_ISSUE), '--json']);
      const directive = JSON.parse(next.stdout);
      assert.strictEqual(directive.role, 'planner', next.stdout);
      assert.strictEqual(
        directive.invocationPayload.Subagents[0].Model,
        modelMatch![1],
        'the advertised model must be the one the directive dispatches'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('a dry run never prints an advance', async () => {
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE, { populatedRca: true });
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE), '--dry-run']);
      const stdout = run.stdout.replace(ANSI_ESCAPE, '');

      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(
        !/Pipeline advanced to/.test(stdout),
        `a dry run must not claim an advance it withheld, got:\n${stdout}`
      );
      assert.ok(/\[DRY RUN\] Stage unchanged/.test(stdout), stdout);
      assert.strictEqual(
        readCheckpoint(sandbox.dir, STAGE_ISSUE).currentStage,
        'DISCOVERY',
        'the checkpoint must be untouched'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('a dry run at IMPLEMENT neither advances nor advertises the planner', async () => {
    // The smoke check an operator actually runs before a re-plan. A dry run
    // leaves the checkpoint at IMPLEMENT, where the next actionable work is the
    // IMPLEMENTER's, so a planner block there is a false attribution — and the
    // dry run advanced nothing for the block to describe.
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE);
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'IMPLEMENT',
        planDir,
        history: [
          { stage: 'APPROVAL', timestamp: new Date(Date.now() - 120_000).toISOString() },
          { stage: 'IMPLEMENT', timestamp: new Date(Date.now() - 60_000).toISOString() }
        ]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE), '--dry-run']);
      const stdout = run.stdout.replace(ANSI_ESCAPE, '');

      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(!/Subagent/.test(stdout), `no subagent block on a no-op dry run, got:\n${stdout}`);
      assert.ok(!/planner/.test(stdout), stdout);
      assert.ok(!/Pipeline advanced to/.test(stdout), stdout);
      assert.ok(/\[DRY RUN\] Stage unchanged: still \[IMPLEMENT\]/.test(stdout), stdout);
      assert.strictEqual(readCheckpoint(sandbox.dir, STAGE_ISSUE).currentStage, 'IMPLEMENT');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('a re-plan from IMPLEMENT advertises the planner (PLAN is next actionable)', async () => {
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE);
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'IMPLEMENT',
        planDir,
        history: [
          { stage: 'APPROVAL', timestamp: new Date(Date.now() - 120_000).toISOString() },
          { stage: 'IMPLEMENT', timestamp: new Date(Date.now() - 60_000).toISOString() }
        ]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE)]);
      const stdout = run.stdout.replace(ANSI_ESCAPE, '');

      assert.strictEqual(run.code, 0, run.stderr);
      assert.strictEqual(readCheckpoint(sandbox.dir, STAGE_ISSUE).currentStage, 'PLAN');
      assert.ok(/Subagent\s*:\s*planner/.test(stdout), stdout);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('at QUALITY_GATE plan prints a no-op line, not an advance', async () => {
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE);
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'QUALITY_GATE',
        planDir,
        history: [
          { stage: 'IMPLEMENT', timestamp: new Date(Date.now() - 60_000).toISOString() },
          { stage: 'QUALITY_GATE', timestamp: new Date().toISOString() }
        ]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE)]);
      const stdout = run.stdout.replace(ANSI_ESCAPE, '');

      assert.strictEqual(run.code, 0, run.stderr);
      assert.ok(/Already at \[QUALITY_GATE\]; nothing to advance\./.test(stdout), stdout);
      assert.ok(!/Pipeline advanced to/.test(stdout), stdout);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

describe('a resume hint is printed only when a pause is recorded (AC-9)', () => {
  test('a DISCOVERY park with no pause never tells the operator to resume', async () => {
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE);
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'DISCOVERY',
        planDir,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE)]);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.strictEqual(run.code, 0, output);
      assert.match(output, /Parked at DISCOVERY/);
      assert.doesNotMatch(
        output,
        /codeloop resume/,
        `a park the checkpoint has not paused cannot be resumed, got:\n${output}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('a DISCOVERY park with a recorded pause keeps the resume hint', async () => {
    const sandbox = makeSandbox();
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE);
      const pausedAt = new Date(Date.now() - 60_000).toISOString();
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'DISCOVERY',
        planDir,
        pausedAtGate: 'CIRCUIT_BREAKER',
        pausedAtTimestamp: pausedAt,
        history: [{ stage: 'DISCOVERY', timestamp: pausedAt }]
      });

      const run = await runCliIn(sandbox.dir, ['plan', '--issue', String(STAGE_ISSUE)]);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.match(output, /Parked at DISCOVERY/, output);
      assert.match(
        output,
        /codeloop resume/,
        `a paused checkpoint must still name the command that clears the pause, got:\n${output}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

describe('status --json carries every dispatch counter (AC-11)', () => {
  test('all four counters appear under the checkpoint’s names', async () => {
    const sandbox = makeSandbox();
    try {
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'IMPLEMENT',
        discoveryDispatchCount: 1,
        planDispatchCount: 2,
        reviewDispatchCount: 3,
        implementationDispatchCount: 4,
        history: [{ stage: 'IMPLEMENT', timestamp: new Date().toISOString() }]
      });

      const json = await runCliIn(sandbox.dir, ['status', '--json', '--issue', String(STAGE_ISSUE)]);
      assert.strictEqual(json.code, 0, json.stderr);
      const parsed = JSON.parse(json.stdout);

      assert.strictEqual(parsed.discoveryDispatchCount, 1);
      assert.strictEqual(parsed.planDispatchCount, 2);
      assert.strictEqual(parsed.reviewDispatchCount, 3);
      assert.strictEqual(
        parsed.implementationDispatchCount,
        4,
        'the fourth counter must be machine-readable, not text-only'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

describe('delivery is reported truthfully (AC-22, AC-24)', () => {
  test('--create-pr is documented outside --help', () => {
    const docs = [
      path.join(REPO_ROOT, 'README.md'),
      path.join(REPO_ROOT, 'skills', 'agyloop', 'SKILL.md'),
      path.join(REPO_ROOT, 'integrations', 'opencode', 'codeloop-skill.md')
    ];
    for (const doc of docs) {
      const text = fs.readFileSync(doc, 'utf8');
      assert.ok(
        text.includes('--create-pr'),
        `${path.relative(REPO_ROOT, doc)} must document --create-pr, not leave it in --help only`
      );
    }
  });

  test('a COMPLETED run with no recorded PR is reported as NOT delivered', async () => {
    const sandbox = makeSandbox();
    try {
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'COMPLETED',
        pullRequest: null,
        history: [
          { stage: 'COMMIT', timestamp: new Date(Date.now() - 60_000).toISOString() },
          { stage: 'COMPLETED', timestamp: new Date().toISOString() }
        ]
      });

      const human = await runCliIn(sandbox.dir, ['status', '--issue', String(STAGE_ISSUE)]);
      assert.strictEqual(human.code, 0, human.stderr);
      const deliveryLine = human.stdout
        .split('\n')
        .find((line: string) => line.trimStart().startsWith('Delivery'));
      assert.ok(deliveryLine, `a COMPLETED run must state its delivery state, got:\n${human.stdout}`);
      assert.match(deliveryLine!, /NOT delivered/);
      assert.doesNotMatch(deliveryLine!, /PR #/);

      const json = await runCliIn(sandbox.dir, ['status', '--json', '--issue', String(STAGE_ISSUE)]);
      const parsed = JSON.parse(json.stdout);
      assert.strictEqual(parsed.pullRequest, null, 'an unrecorded PR is null, never "delivered"');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('a COMPLETED run with a recorded PR names it', async () => {
    const sandbox = makeSandbox();
    try {
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'COMPLETED',
        pullRequest: {
          number: 331,
          url: 'https://example.test/pull/331',
          status: 'created'
        },
        history: [
          { stage: 'COMMIT', timestamp: new Date(Date.now() - 60_000).toISOString() },
          { stage: 'COMPLETED', timestamp: new Date().toISOString() }
        ]
      });

      const human = await runCliIn(sandbox.dir, ['status', '--issue', String(STAGE_ISSUE)]);
      assert.strictEqual(human.code, 0, human.stderr);
      assert.match(human.stdout, /Delivery\s*: PR #331 \(https:\/\/example\.test\/pull\/331\)/);

      const json = await runCliIn(sandbox.dir, ['status', '--json', '--issue', String(STAGE_ISSUE)]);
      assert.deepStrictEqual(JSON.parse(json.stdout).pullRequest, {
        number: 331,
        url: 'https://example.test/pull/331',
        status: 'created'
      });
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});

describe('review renders one header (AC-6)', () => {
  const APPROVED_VERDICT = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

  test('review --verdict-file prints exactly one report title', () => {
    const sandbox = makeSandbox();
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-review-input-'));
    try {
      const planDir = seedPlanDir(sandbox.dir, STAGE_ISSUE);
      seedCheckpoint(sandbox.dir, STAGE_ISSUE, {
        currentStage: 'REVIEW',
        planDir,
        history: [{ stage: 'REVIEW', timestamp: new Date().toISOString() }]
      });
      const verdictPath = path.join(inputDir, 'verdict.md');
      const critiquePath = path.join(inputDir, 'critique.json');
      fs.writeFileSync(verdictPath, APPROVED_VERDICT, 'utf8');
      fs.writeFileSync(
        critiquePath,
        JSON.stringify({
          summary: 'Clean automated review',
          confidenceLevel: 'High',
          confidenceExplanation: 'diff verified',
          comments: []
        }),
        'utf8'
      );

      const run = spawnSync(
        process.execPath,
        [
          BIN,
          'review',
          '--issue',
          String(STAGE_ISSUE),
          '--verdict-file',
          verdictPath,
          '--critique-report',
          critiquePath
        ],
        {
          cwd: sandbox.dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: path.join(sandbox.dir, '.home'),
            AGY_SUBAGENT: ''
          }
        }
      );

      const headers = (run.stdout.match(/=== CodeLoop:/g) ?? []).length;
      assert.strictEqual(
        headers,
        1,
        `one report, one title — got ${headers}:\n${run.stdout}\n${run.stderr}`
      );
      assert.ok(
        run.stdout.includes('=== CodeLoop: Review Verdict Report ==='),
        `the report must own its title, got:\n${run.stdout}`
      );
    } finally {
      fs.rmSync(inputDir, { recursive: true, force: true });
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
