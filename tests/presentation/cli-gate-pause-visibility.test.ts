/**
 * agyloop - CLI visibility of a persisted gate pause (issue #218 AC4, defects A/B/C)
 *
 * A circuit-breaker pause is persisted in `.agyloop/state.json` as `pausedAtGate`, but
 * before these fixes only the human `codeloop next` banner ever mentioned it:
 *
 *   - `codeloop next --json` returned before that banner, so the command the agent
 *     harness is told to run (skills/agyloop/SKILL.md) could not see the pause at all.
 *   - `codeloop status` never rendered it, so a human had no way to know the run was
 *     waiting on them.
 *   - `--help` told users to run `codeloop next` to clear the pause, which never
 *     happened: `resumeFromGate()` was reachable only from `transition` and `triage`.
 *
 * Contract pinned here: the pause travels as DATA on the `--json` path (stdout stays a
 * single parseable document, diagnostics go to stderr), the human `status` output names
 * the gate and when it was recorded, and help/parsing know about `codeloop resume`.
 *
 * PA1 - an APPROVAL pause presents ONE next step: `resumeCommand: null`, a message naming
 *       `codeloop implement`, no 🛑 banner (issue #362, Finding 3)
 * PA2 - a TRIAGE pause still advertises `codeloop resume` (issue #362)
 * PA3 - the shared predicate did not widen: COMMIT is unchanged (issue #315/#362)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runCli,
  parseArguments,
  printHelp,
  RESUME_COMMAND,
  COMMIT_GATE_COMMAND,
  APPROVAL_GATE_COMMAND
} = require('../../dist/presentation/cli');
const { GATE_CIRCUIT_BREAKER, QUOTA_RESUME_COMMAND } = require('../../dist/domain');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const PAUSED_AT = '2026-10-14T12:00:00.000Z';

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Seeds a checkpoint halted at the circuit-breaker gate. This is the exact on-disk shape
 * `RunLifecycleUseCase` persists for a quota halt / exhausted retry budget. The worktree
 * descriptor is required: `GetNextActionUseCase` refuses to emit an IMPLEMENT directive
 * that targets the root workspace (Zero Direct Root Mutation invariant).
 */
function seedPausedState(dir: string, gate = GATE_CIRCUIT_BREAKER): void {
  const stateDir = path.join(dir, '.agyloop');
  const worktreePath = path.join(dir, '.worktrees', '99');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'IMPLEMENT',
      mode: 'standard',
      issue: 99,
      baseBranch: 'phase/1-bridge',
      worktree: {
        taskId: 99,
        worktreePath,
        branch: 'task/99-breaker',
        baseBranch: 'phase/1-bridge',
        createdAt: PAUSED_AT
      },
      pausedAtGate: gate,
      pausedAtTimestamp: PAUSED_AT,
      createdAt: PAUSED_AT,
      updatedAt: PAUSED_AT,
      history: [{ stage: 'IMPLEMENT', timestamp: PAUSED_AT }]
    })
  );
}

/** Seeds a healthy, unpaused checkpoint at the given stage (default IMPLEMENT). */
function seedRunningState(
  dir: string,
  stage = 'IMPLEMENT',
  pause?: { readonly gate: string; readonly at: string }
): void {
  const stateDir = path.join(dir, '.agyloop');
  const worktreePath = path.join(dir, '.worktrees', '99');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      version: '1.0.0',
      currentStage: stage,
      mode: 'standard',
      issue: 99,
      baseBranch: 'phase/1-bridge',
      worktree: {
        taskId: 99,
        worktreePath,
        branch: 'task/99-breaker',
        baseBranch: 'phase/1-bridge',
        createdAt: PAUSED_AT
      },
      ...(pause ? { pausedAtGate: pause.gate, pausedAtTimestamp: pause.at } : {}),
      createdAt: PAUSED_AT,
      updatedAt: PAUSED_AT,
      history: [{ stage, timestamp: pause?.at ?? PAUSED_AT }]
    })
  );
}

/**
 * Runs `runCli` in a throwaway cwd with both console streams captured, restoring
 * everything (cwd, TTY flags, console) in `finally`.
 */
async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-gate-pause-'));
  let stdout = '';
  let stderr = '';

  try {
    if (seed) {
      seed(tempDir);
    }
    process.chdir(tempDir);
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    const code = await Promise.race([
      runCli(args),
      // Hang guard (same recipe as cli-prompt-guards.test.ts): a prompt opened on a
      // silent stdin pipe never settles, and a hung suite is worse than a red one.
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`HANG: runCli(${JSON.stringify(args)}) never settled.`)),
          20000
        );
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      })
    ]);

    return { code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('next --json surfaces a persisted gate pause as data', () => {
  test('the pause reaches stdout as JSON, with no prose mixed in', async () => {
    const result = await runCliInSandbox(['next', '--json'], seedPausedState);

    // A harness that cannot parse the document cannot act on the pause either.
    const parsed = JSON.parse(result.stdout.trim());

    assert.ok(parsed.pause, `expected a pause block, got: ${result.stdout}`);
    assert.strictEqual(parsed.pause.gate, GATE_CIRCUIT_BREAKER);
    assert.strictEqual(parsed.pause.pausedAt, PAUSED_AT);
    assert.strictEqual(parsed.pause.resumeCommand, RESUME_COMMAND);
    assert.ok(parsed.pause.message.includes(GATE_CIRCUIT_BREAKER), parsed.pause.message);

    // The single boolean a caller needs: do NOT invoke the subagent while paused.
    assert.strictEqual(parsed.actionable, false);

    // The human banner must not leak into the machine-readable stream. (The recovery
    // prose exists only as the `pause.message` string VALUE, inside the document.)
    assert.ok(result.stdout.trim().startsWith('{'), result.stdout);
    assert.ok(result.stdout.trim().endsWith('}'), result.stdout);
    assert.ok(!result.stdout.includes('Next Subagent Directive'), result.stdout);
    assert.ok(!result.stdout.includes('=== CodeLoop:'), result.stdout);
    assert.ok(!result.stdout.includes('🛑'), result.stdout);
    assert.strictEqual(
      result.stdout.split('Resolve the blocking condition').length - 1,
      1,
      'recovery prose may only appear once, as the pause.message value'
    );
  });

  test('the directive itself is still emitted alongside the pause', async () => {
    const result = await runCliInSandbox(['next', '--json'], seedPausedState);
    const parsed = JSON.parse(result.stdout.trim());

    assert.strictEqual(result.code, 0, 'a pause is reportable, not a crash');
    assert.strictEqual(parsed.currentStage, 'IMPLEMENT');
    assert.strictEqual(parsed.actionType, 'subagent');
    assert.ok(parsed.invocationPayload.Subagents[0].TypeName, 'the payload shape is unchanged');
    assert.ok(parsed.humanSummary, 'existing per-field consumers keep working');
  });

  test('the pause warning goes to stderr, never stdout', async () => {
    const result = await runCliInSandbox(['next', '--json'], seedPausedState);

    assert.ok(result.stderr.includes(GATE_CIRCUIT_BREAKER), result.stderr);
    assert.ok(result.stderr.includes(RESUME_COMMAND), result.stderr);
    assert.ok(!result.stdout.includes('🛑'), result.stdout);
  });

  test('an unpaused pipeline reports pause: null and stays actionable', async () => {
    const result = await runCliInSandbox(['next', '--json'], seedRunningState);
    const parsed = JSON.parse(result.stdout.trim());

    assert.strictEqual(parsed.pause, null);
    assert.strictEqual(parsed.actionable, true);
    assert.strictEqual(result.stderr, '', 'a healthy pipeline must not warn');
  });

  test('a persisted COMMIT pause presents as the gate, not a resumable blocker (issue #315, AC-7/AC-13)', async () => {
    // `run-review` now records `pausedAtGate: 'COMMIT'` + a timestamp on the
    // standard REVIEW→COMMIT path so the confirmation wait is measurable. That
    // is the state production writes — the old test seeded a no-pause COMMIT
    // checkpoint production never created, so it would pass a fix changing
    // nothing. Here the pause is PERSISTED, and it must still read as a gate:
    // the next step is `codeloop commit`, never `codeloop resume`.
    const result = await runCliInSandbox(['next', '--json'], (dir) =>
      seedRunningState(dir, 'COMMIT', { gate: 'COMMIT', at: PAUSED_AT })
    );
    const parsed = JSON.parse(result.stdout.trim());

    assert.strictEqual(parsed.actionType, 'human_gate');
    assert.strictEqual(parsed.actionable, false, `a human gate must not be actionable:\n${result.stdout}`);
    assert.ok(parsed.pause, `a human gate must carry a pause object:\n${result.stdout}`);
    assert.strictEqual(parsed.pause.gate, 'COMMIT');
    assert.strictEqual(parsed.pause.pausedAt, PAUSED_AT);
    // The pause is kept for accounting but is NOT resumable: the operator's
    // step at this gate is the commit itself.
    assert.strictEqual(parsed.pause.resumeCommand, null);
    assert.match(parsed.pause.message, /codeloop commit/);
    assert.doesNotMatch(
      parsed.pause.message,
      /codeloop resume/,
      `the pause must not claim resume is the next step, got: ${parsed.pause.message}`
    );
    // No contradictory 🛑 "run codeloop resume" banner: it used to contradict
    // the directive's own `codeloop commit --create-pr` summary.
    assert.doesNotMatch(result.stderr, /codeloop resume/, result.stderr);
    assert.doesNotMatch(result.stderr, /🛑/, result.stderr);
  });
});

describe('an APPROVAL pause presents one next step (issue #362, Finding 3)', () => {
  test('PA1: resumeCommand is null and the message names the approve command', async () => {
    // Exactly what `transition-stage.ts` writes when it enters APPROVAL:
    // `pausedAtGate: 'APPROVAL'` plus the timestamp. The persisted pause used to
    // shadow the synthesised human-gate pause, so `next --json` said "run
    // codeloop resume" beside a humanSummary that said "run codeloop implement".
    const result = await runCliInSandbox(['next', '--json'], (dir) =>
      seedRunningState(dir, 'APPROVAL', { gate: 'APPROVAL', at: PAUSED_AT })
    );
    const parsed = JSON.parse(result.stdout.trim());

    assert.strictEqual(parsed.actionType, 'human_gate');
    assert.strictEqual(parsed.actionable, false, result.stdout);
    assert.ok(parsed.pause, `expected a pause block, got: ${result.stdout}`);
    assert.strictEqual(parsed.pause.gate, 'APPROVAL');
    assert.strictEqual(parsed.pause.pausedAt, PAUSED_AT);
    // The documented human-gate contract (skills/agyloop/SKILL.md): there is
    // nothing to resume at a gate.
    assert.strictEqual(parsed.pause.resumeCommand, null);
    assert.ok(parsed.pause.message.includes(APPROVAL_GATE_COMMAND), parsed.pause.message);
    assert.match(parsed.pause.message, /codeloop implement/);
    assert.match(parsed.pause.message, /codeloop transition IMPLEMENT/);
    assert.doesNotMatch(parsed.pause.message, /codeloop resume/);
    assert.match(parsed.humanSummary, /codeloop transition IMPLEMENT/);
    // No contradictory 🛑 banner: the two next steps must agree.
    assert.doesNotMatch(result.stderr, /🛑/, result.stderr);
    assert.doesNotMatch(result.stderr, /codeloop resume/, result.stderr);
  });

  test('PA2: a TRIAGE pause still advertises codeloop resume', async () => {
    // A persisted TRIAGE pause genuinely gates re-dispatch, so its hint stays.
    const result = await runCliInSandbox(['next', '--json'], (dir) =>
      seedRunningState(dir, 'TRIAGE', { gate: 'TRIAGE', at: PAUSED_AT })
    );
    const parsed = JSON.parse(result.stdout.trim());

    assert.strictEqual(parsed.pause.resumeCommand, RESUME_COMMAND, result.stdout);
    assert.match(parsed.pause.message, /codeloop resume/);
  });

  test('PA3: the shared predicate did not widen — COMMIT is unchanged', async () => {
    const result = await runCliInSandbox(['next', '--json'], (dir) =>
      seedRunningState(dir, 'COMMIT', { gate: 'COMMIT', at: PAUSED_AT })
    );
    const parsed = JSON.parse(result.stdout.trim());

    assert.strictEqual(parsed.pause.gate, 'COMMIT');
    assert.strictEqual(parsed.pause.resumeCommand, null);
    assert.ok(parsed.pause.message.includes(COMMIT_GATE_COMMAND), parsed.pause.message);
    assert.doesNotMatch(parsed.pause.message, /codeloop resume/);
  });
});

describe('status renders a persisted gate pause', () => {
  test('human output names the gate and when the pause was recorded', async () => {
    const result = await runCliInSandbox(['status'], seedPausedState);

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Paused At Gate'), result.stdout);
    assert.ok(result.stdout.includes(GATE_CIRCUIT_BREAKER), result.stdout);
    assert.ok(result.stdout.includes('Paused At'), result.stdout);
    assert.ok(result.stdout.includes(PAUSED_AT), result.stdout);
    // The recovery hint must name a command that actually clears the pause.
    assert.ok(result.stdout.includes(RESUME_COMMAND), result.stdout);
  });

  test('existing status output is untouched when the pipeline is paused', async () => {
    const result = await runCliInSandbox(['status'], seedPausedState);

    assert.ok(result.stdout.includes('=== CodeLoop: Pipeline Status ==='), result.stdout);
    assert.ok(result.stdout.includes('IMPLEMENT'), result.stdout);
    assert.ok(result.stdout.includes('Checkpoint'), result.stdout);
    assert.ok(result.stdout.includes('Transition History'), result.stdout);
  });

  test('no pause block is printed for a healthy pipeline', async () => {
    const result = await runCliInSandbox(['status'], seedRunningState);

    assert.strictEqual(result.code, 0);
    assert.ok(!result.stdout.includes('Paused At Gate'), result.stdout);
  });

  test('a non-breaker pause (human gate) is rendered without a breaker recovery hint', async () => {
    const result = await runCliInSandbox(['status'], (dir) => seedPausedState(dir, 'APPROVAL'));

    assert.ok(result.stdout.includes('Paused At Gate'), result.stdout);
    assert.ok(result.stdout.includes('APPROVAL'), result.stdout);
    assert.ok(!result.stdout.includes('resolve the blocking condition'), result.stdout);
  });
});

describe('codeloop resume', () => {
  test('parseArguments recognizes the command and its flags', () => {
    const parsed = parseArguments(['resume']);
    assert.strictEqual(parsed.command, 'resume');
    assert.strictEqual(parsed.options.dryRun, false);

    const parsedDry = parseArguments(['resume', '--dry-run', '--json']);
    assert.strictEqual(parsedDry.command, 'resume');
    assert.strictEqual(parsedDry.options.dryRun, true);
    assert.strictEqual(parsedDry.options.json, true);

    const parsedIssue = parseArguments(['resume', '--issue', '99']);
    assert.strictEqual(parsedIssue.command, 'resume');
    assert.strictEqual(parsedIssue.options.issue, '99');
  });

  test('help lists the command and stops recommending `next` as the recovery', () => {
    let output = '';
    const originalLog = console.log;
    console.log = (msg: unknown) => {
      output += String(msg) + '\n';
    };

    try {
      printHelp();
    } finally {
      console.log = originalLog;
    }

    assert.ok(output.includes('Pipeline Management:'), output);
    assert.ok(output.includes('resume'), output);
    // Exit-code-2 guidance must name the command that actually clears the pause.
    assert.ok(output.includes(`Resume with '${RESUME_COMMAND}'`), output);
    assert.ok(!output.includes(`Resume with 'codeloop next'`), output);

    // The domain banner constant and the presentation-layer help text must name the
    // same command; if they drift, the quota banner starts advising an unresumable
    // command again.
    assert.strictEqual(QUOTA_RESUME_COMMAND, RESUME_COMMAND);
  });

  test('--dry-run reports the clear without writing the checkpoint', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-resume-dry-'));
    const statePath = path.join(tempDir, '.agyloop', 'state.json');
    const prevCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';

    try {
      seedPausedState(tempDir);
      process.chdir(tempDir);
      console.log = (msg: unknown) => {
        stdout += String(msg) + '\n';
      };
      console.error = () => {};

      const code = await runCli(['resume', '--dry-run']);

      assert.strictEqual(code, 0);
      assert.ok(stdout.includes('[dry-run]'), stdout);
      assert.ok(stdout.includes(GATE_CIRCUIT_BREAKER), stdout);
      assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).pausedAtGate, GATE_CIRCUIT_BREAKER);
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('an unpaused pipeline is a no-op that still exits 0', async () => {
    const result = await runCliInSandbox(['resume'], seedRunningState);

    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('=== CodeLoop: Pipeline Resume ==='), result.stdout);
    assert.ok(/nothing to resume/i.test(result.stdout), result.stdout);
    assert.ok(result.stdout.includes('(none)'), result.stdout);
  });

  test('--issue routes the resume at the matching task checkpoint only', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-resume-issue-'));
    const rootState = path.join(tempDir, '.agyloop', 'state.json');
    const taskState = path.join(tempDir, '.agyloop', 'tasks', '99.json');
    fs.mkdirSync(path.join(tempDir, '.agyloop', 'tasks'), { recursive: true });
    fs.writeFileSync(rootState, JSON.stringify({ version: '1.0.0', currentStage: 'IMPLEMENT', mode: 'standard', issue: null, pausedAtGate: GATE_CIRCUIT_BREAKER, pausedAtTimestamp: PAUSED_AT, createdAt: PAUSED_AT, updatedAt: PAUSED_AT, history: [] }));
    fs.writeFileSync(taskState, JSON.stringify({ version: '1.0.0', currentStage: 'IMPLEMENT', mode: 'standard', issue: 99, pausedAtGate: GATE_CIRCUIT_BREAKER, pausedAtTimestamp: PAUSED_AT, createdAt: PAUSED_AT, updatedAt: PAUSED_AT, history: [] }));

    const prevCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';

    try {
      process.chdir(tempDir);
      console.log = (msg: unknown) => {
        stdout += String(msg) + '\n';
      };
      console.error = () => {};

      const code = await runCli(['resume', '--issue', '99']);

      assert.strictEqual(code, 0);
      assert.ok(stdout.includes(GATE_CIRCUIT_BREAKER), stdout);
      assert.strictEqual(JSON.parse(fs.readFileSync(taskState, 'utf8')).pausedAtGate, null);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(rootState, 'utf8')).pausedAtGate,
        GATE_CIRCUIT_BREAKER,
        'an unrelated checkpoint must not be touched'
      );
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resuming a paused pipeline clears the pause and prints pure JSON', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-resume-json-'));
    const statePath = path.join(tempDir, '.agyloop', 'state.json');
    const prevCwd = process.cwd();
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    let stderr = '';

    try {
      seedPausedState(tempDir);
      process.chdir(tempDir);
      console.log = (msg: unknown) => {
        stdout += String(msg) + '\n';
      };
      console.error = (msg: unknown) => {
        stderr += String(msg) + '\n';
      };

      const code = await runCli(['resume', '--json']);

      assert.strictEqual(code, 0);
      const parsed = JSON.parse(stdout.trim());
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.resumed, true);
      assert.strictEqual(parsed.pausedAtGate, GATE_CIRCUIT_BREAKER);
      assert.strictEqual(parsed.pausedAtTimestamp, PAUSED_AT);
      assert.strictEqual(parsed.currentStage, 'IMPLEMENT');
      assert.ok(typeof parsed.totalHumanWaitMs === 'number', JSON.stringify(parsed));
      assert.ok(!('stateMachine' in parsed), 'the rehydrated entity is not CLI output');
      assert.strictEqual(stderr, '');

      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.strictEqual(persisted.pausedAtGate, null, 'the pause must be gone from disk');
      assert.strictEqual(persisted.pausedAtTimestamp, null);
      assert.strictEqual(persisted.currentStage, 'IMPLEMENT', 'resume never advances the stage');
    } finally {
      process.chdir(prevCwd);
      console.log = originalLog;
      console.error = originalError;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});