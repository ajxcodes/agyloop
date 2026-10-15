/**
 * agyloop - CLI quota/breaker halt exit-code tests (issue #218 AC4 / plan DoD 3.8-T7)
 *
 * `lifecycleHaltExitCode` and `persistedHaltExitCode` are the ONLY thing a human or
 * a CI job observes for a quota halt, and nothing pinned them before. The contract:
 *
 *   quota exhaustion  -> exit 2 (recoverable: state is checkpointed, `codeloop next`
 *                       resumes once the provider window reopens)
 *   other breaker    -> exit 1
 *   anything else    -> null, i.e. the caller's existing handling is untouched
 *
 * plus a stderr banner naming the reset window and the resume command.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli, lifecycleHaltExitCode, persistedHaltExitCode } = require('../../dist/presentation/cli');
const {
  QuotaExhaustedError,
  CircuitBreakerTrippedError,
  classifyQuotaExhaustion,
  CB_ACTION_ABORT,
  CB_ACTION_PAUSE_FOR_HUMAN,
  GATE_CIRCUIT_BREAKER,
  QUOTA_RESUME_COMMAND
} = require('../../dist/domain');
const { EXIT_CODE_FAILURE, EXIT_CODE_QUOTA_EXHAUSTED } = require('../../dist/domain/constants');

const FIXED_NOW = new Date('2026-10-14T12:00:00.000Z');
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/**
 * Captures console.log/console.error around a callback so the banner can be asserted
 * on the stream the user (and CI) actually sees.
 */
async function withCapturedConsole<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args: unknown[]) => {
    stdout += args.map(String).join(' ') + '\n';
  };
  console.error = (...args: unknown[]) => {
    stderr += args.map(String).join(' ') + '\n';
  };
  try {
    const result = await fn();
    return { result, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function quotaError(): InstanceType<typeof QuotaExhaustedError> {
  return new QuotaExhaustedError({
    signal: classifyQuotaExhaustion('anthropic RESOURCE_EXHAUSTED retry-after: 120'),
    runner: 'opencode',
    stage: 'IMPLEMENT',
    now: FIXED_NOW
  });
}

describe('lifecycleHaltExitCode (thrown-halt guard)', () => {
  test('maps QuotaExhaustedError to the distinct quota exit code and explains the resume', async () => {
    const err = quotaError();
    const { result, stderr } = await withCapturedConsole(async () => lifecycleHaltExitCode(err));

    assert.strictEqual(result, EXIT_CODE_QUOTA_EXHAUSTED);
    assert.strictEqual(result, 2);
    assert.notStrictEqual(result, EXIT_CODE_FAILURE, 'a quota halt is not an ordinary failure');
    assert.ok(stderr.includes('Provider quota exhausted'), stderr);
    assert.ok(stderr.includes(QUOTA_RESUME_COMMAND), stderr);
    assert.ok(stderr.includes('2026-10-14T12:02:00.000Z'), stderr);
  });

  test('maps a non-quota CircuitBreakerTrippedError to the ordinary failure code', async () => {
    const err = new CircuitBreakerTrippedError(
      'qualityGateRetries',
      3,
      4,
      CB_ACTION_PAUSE_FOR_HUMAN,
      'Circuit breaker \'qualityGateRetries\' tripped: exceeded limit 3 (actual: 4).'
    );
    const { result, stderr } = await withCapturedConsole(async () => lifecycleHaltExitCode(err));

    assert.strictEqual(result, EXIT_CODE_FAILURE);
    assert.ok(stderr.includes('qualityGateRetries'), stderr);
    assert.ok(stderr.includes(QUOTA_RESUME_COMMAND), stderr);
  });

  test('returns null for every other error so the caller keeps its own handling', async () => {
    const cases: readonly unknown[] = [new Error('x'), new TypeError('nope'), 'a string', null, undefined, 42, {}];

    for (const candidate of cases) {
      const { result, stdout, stderr } = await withCapturedConsole(async () => lifecycleHaltExitCode(candidate));
      assert.strictEqual(result, null, `expected null for ${String(candidate)}`);
      assert.strictEqual(stderr, '', 'an unhandled error must not print a halt banner');
      assert.strictEqual(stdout, '');
    }
  });

  test('an aborting breaker still reports a failure, not success', async () => {
    const err = new CircuitBreakerTrippedError('tokenBudget', 100, 200, CB_ACTION_ABORT, 'budget blown');
    const { result } = await withCapturedConsole(async () => lifecycleHaltExitCode(err));
    assert.strictEqual(result, EXIT_CODE_FAILURE);
  });
});

describe('persistedHaltExitCode (checkpointed-halt guard)', () => {
  test('quotaExhausted maps to exit 2', async () => {
    const { result, stderr } = await withCapturedConsole(async () =>
      persistedHaltExitCode({
        pausedAtGate: GATE_CIRCUIT_BREAKER,
        quotaExhausted: true,
        message: 'Provider quota exhausted (HTTP 429).'
      })
    );

    assert.strictEqual(result, EXIT_CODE_QUOTA_EXHAUSTED);
    assert.ok(stderr.includes('Provider quota exhausted'), stderr);
    assert.ok(stderr.includes(QUOTA_RESUME_COMMAND), stderr);
  });

  test('a non-quota breaker pause maps to exit 1', async () => {
    const { result, stderr } = await withCapturedConsole(async () =>
      persistedHaltExitCode({
        pausedAtGate: GATE_CIRCUIT_BREAKER,
        message: 'Circuit breaker \'qualityGateRetries\' tripped.'
      })
    );

    assert.strictEqual(result, EXIT_CODE_FAILURE);
    assert.strictEqual(result, 1);
    assert.ok(stderr.includes('qualityGateRetries'), stderr);
  });

  test('a pause at any other gate is left entirely to the caller', async () => {
    const gates: readonly (string | null | undefined)[] = ['COMMIT', 'APPROVAL', 'TRIAGE', null, undefined];

    for (const pausedAtGate of gates) {
      const { result, stdout, stderr } = await withCapturedConsole(async () => persistedHaltExitCode({ pausedAtGate }));
      assert.strictEqual(result, null, `expected null for gate ${String(pausedAtGate)}`);
      assert.strictEqual(stderr, '');
      assert.strictEqual(stdout, '');
    }
  });

  test('falls back to a generic banner when the lifecycle supplied no message', async () => {
    const { result, stderr } = await withCapturedConsole(async () =>
      persistedHaltExitCode({ pausedAtGate: GATE_CIRCUIT_BREAKER })
    );
    assert.strictEqual(result, EXIT_CODE_FAILURE);
    assert.ok(stderr.includes('Circuit breaker halted the pipeline.'), stderr);
  });
});

/**
 * Seeds a checkpoint sitting at IMPLEMENT with the gate-retry breaker already at its
 * limit, plus a config whose single gate command fails instantly. That drives the
 * real `RunLifecycleUseCase` retry breaker, so the CLI is fed a genuine
 * `pausedAtGate: CIRCUIT_BREAKER` result instead of a hand-built stub.
 */
function seedBreakerState(dir: string): void {
  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.codeloop'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'state.json'),
    JSON.stringify({
      version: '1.0.0',
      currentStage: 'IMPLEMENT',
      mode: 'standard',
      issue: 99,
      implementToGateLoops: 1,
      createdAt: now,
      updatedAt: now,
      history: [{ stage: 'IMPLEMENT', timestamp: now }]
    })
  );
  fs.writeFileSync(
    path.join(dir, '.codeloop', 'config.json'),
    JSON.stringify({
      options: { gateCommands: ['node -e "process.exit(1)"'], gateTimeoutSeconds: 5 },
      circuitBreakers: { maxGateRetries: 1, actionOnTrip: 'pause_for_human' }
    })
  );
}

interface SandboxResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly persisted: Record<string, unknown> | null;
}

/**
 * Runs `runCli` inside a throwaway cwd, restoring cwd/TTY/console in `finally` and
 * failing loudly instead of hanging if a prompt is ever opened.
 */
async function runCliInSandbox(args: readonly string[]): Promise<SandboxResult> {
  const prevCwd = process.cwd();
  const originalStdinIsTTY = (process.stdin as any).isTTY;
  const originalStdoutIsTTY = (process.stdout as any).isTTY;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-quota-halt-'));
  let stdout = '';
  let stderr = '';

  try {
    seedBreakerState(tempDir);
    process.chdir(tempDir);
    (process.stdin as any).isTTY = false;
    (process.stdout as any).isTTY = false;
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };

    const timeoutMs = 30000;
    const code = await Promise.race([
      runCli(args),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`HANG: runCli(${JSON.stringify(args)}) never settled.`)),
          timeoutMs
        );
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      })
    ]);

    let persisted: Record<string, unknown> | null = null;
    try {
      persisted = JSON.parse(fs.readFileSync(path.join(tempDir, '.agyloop', 'state.json'), 'utf8'));
    } catch {
      persisted = null;
    }

    return { code, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, ''), persisted };
  } finally {
    process.chdir(prevCwd);
    (process.stdin as any).isTTY = originalStdinIsTTY;
    (process.stdout as any).isTTY = originalStdoutIsTTY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('runCli reports a circuit-breaker pause as a failure', () => {
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test('default lifecycle exits non-zero, banners on stderr and checkpoints the gate', async () => {
    const result = await runCliInSandbox(['--no-worktree']);

    assert.notStrictEqual(result.code, 0, 'a breaker pause is a failure, not a success');
    assert.strictEqual(result.code, EXIT_CODE_FAILURE);
    assert.ok(result.stderr.includes('Circuit breaker'), result.stderr);
    assert.ok(result.stderr.includes('qualityGateRetries'), result.stderr);
    assert.ok(result.stderr.includes(QUOTA_RESUME_COMMAND), result.stderr);

    // AC4 round trip through the CLI: the pause must survive on disk, otherwise the
    // operator loses the context and has to restart the stage from scratch.
    assert.strictEqual(result.persisted?.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.ok(result.persisted?.pausedAtTimestamp, 'the checkpoint must carry a timestamp');
  });

  test('yolo exits non-zero and banners on stderr', async () => {
    const result = await runCliInSandbox(['yolo', '--no-worktree']);

    assert.strictEqual(result.code, EXIT_CODE_FAILURE);
    assert.ok(result.stderr.includes('qualityGateRetries'), result.stderr);
    assert.ok(result.stderr.includes(QUOTA_RESUME_COMMAND), result.stderr);
    assert.strictEqual(result.persisted?.pausedAtGate, GATE_CIRCUIT_BREAKER);
  });

  test('a halted run writes its banner to stderr, never to stdout', async () => {
    const result = await runCliInSandbox(['yolo', '--no-worktree']);

    assert.ok(!result.stdout.includes('Circuit breaker'), result.stdout);
    assert.ok(!result.stdout.includes('State is checkpointed'), result.stdout);
  });
});
