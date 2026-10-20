/**
 * agyloop - CLI halt inbound channel tests (issue #220)
 *
 * `codeloop halt --reason quota [--retry-after <s>] [--json] [--dry-run]`
 * persists a CIRCUIT_BREAKER pause and exits 2, restoring reachability of the
 * quota-halt state without wiring `AgentRunnerPort` into the lifecycle.
 *
 * AC1: halt persists pausedAtGate=CIRCUIT_BREAKER, exits 2 (first-wins).
 * AC2: missing / non-quota --reason fails exit 1, no state mutation.
 * AC3: --retry-after drives quotaResetAt (default 3600s estimate); invalid exits 1.
 * AC4: --json single document on stdout; --dry-run writes nothing, still exits 2.
 * AC5: AGY_SUBAGENT=1 permits halt (covered here; guard test extended too).
 * AC6: halt -> resume round-trip clears the pause.
 * AC8: help + CLI_COMMANDS.STATE_MUTATING_COMMANDS registry.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli, parseArguments } = require('../../dist/presentation/cli');
const {
  CLI_COMMANDS,
  COMMAND_HALT,
  STATE_MUTATING_COMMANDS,
  GATE_CIRCUIT_BREAKER,
  QUOTA_DEFAULT_RETRY_AFTER_SECONDS,
  QUOTA_RESUME_COMMAND,
  EXIT_CODE_FAILURE,
  EXIT_CODE_QUOTA_EXHAUSTED,
  EXIT_CODE_SUCCESS
} = require('../../dist/domain');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function stateFilePath(dir: string): string {
  return path.join(dir, '.agyloop', 'state.json');
}

function readState(dir: string): any {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(dir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Runs runCli inside a throwaway cwd with captured console streams,
 * restoring cwd/env/console afterwards.
 */
async function runCliInSandbox(args: readonly string[], { seed = null, env = {} }: any = {}): Promise<any> {
  const prevCwd = process.cwd();
  const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-'));
  const originalEnv: any = {};
  for (const key of Object.keys(env)) {
    originalEnv[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    if (seed !== null) {
      fs.mkdirSync(path.join(tempDir, '.agyloop'), { recursive: true });
      fs.writeFileSync(stateFilePath(tempDir), JSON.stringify(seed));
    }
    process.chdir(tempDir);
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return {
      code,
      stdout: stdout.replace(ANSI_ESCAPE, ''),
      stderr: stderr.replace(ANSI_ESCAPE, ''),
      persisted: readState(tempDir)
    };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    for (const key of Object.keys(env)) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function seedState(overrides: any = {}): any {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    currentStage: 'IMPLEMENT',
    mode: 'standard',
    issue: null,
    createdAt: now,
    updatedAt: now,
    history: [{ stage: 'IMPLEMENT', timestamp: now }],
    ...overrides
  };
}

describe('codeloop halt (issue #220)', () => {
  let originalLog: any;
  let originalError: any;

  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test('AC1: halt --reason quota checkpoints CIRCUIT_BREAKER and exits 2', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota'], {
      seed: seedState(),
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    assert.strictEqual(result.code, 2);
    assert.strictEqual(result.persisted?.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.ok(result.persisted?.pausedAtTimestamp, 'checkpoint must carry a timestamp');
    assert.ok(
      result.stdout.includes(QUOTA_RESUME_COMMAND) || result.stderr.includes(QUOTA_RESUME_COMMAND),
      'output must name the resume command'
    );
  });

  test('AC1: halt works with no pre-existing checkpoint', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota'], {
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    assert.strictEqual(result.persisted?.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.ok(result.persisted?.pausedAtTimestamp);
  });

  test('AC1: second halt preserves the original timestamp (first-wins)', async () => {
    const firstPause = '2026-10-14T12:00:00.000Z';
    const first = await runCliInSandbox(['halt', '--reason', 'quota'], {
      seed: seedState({ pausedAtGate: GATE_CIRCUIT_BREAKER, pausedAtTimestamp: firstPause }),
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(first.code, EXIT_CODE_QUOTA_EXHAUSTED);
    assert.strictEqual(first.persisted?.pausedAtTimestamp, firstPause);

    // Double-halt on a fresh checkpoint also keeps the first timestamp.
    const prevCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-firstwins-'));
    const origLog = console.log;
    const origErr = console.error;
    try {
      process.chdir(tempDir);
      console.log = (..._a: any[]): void => {};
      console.error = (..._a: any[]): void => {};
      delete process.env.AGY_SUBAGENT;
      assert.strictEqual(await runCli(['halt', '--reason', 'quota']), EXIT_CODE_QUOTA_EXHAUSTED);
      const once = readState(tempDir);
      assert.strictEqual(await runCli(['halt', '--reason', 'quota']), EXIT_CODE_QUOTA_EXHAUSTED);
      const twice = readState(tempDir);
      assert.strictEqual(twice?.pausedAtTimestamp, once?.pausedAtTimestamp);
    } finally {
      process.chdir(prevCwd);
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('AC2: missing --reason fails exit 1 with no state mutation', async () => {
    const before = seedState();
    const result = await runCliInSandbox(['halt'], {
      seed: before,
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_FAILURE);
    assert.ok(result.stderr.includes('--reason quota'), result.stderr);
    assert.deepStrictEqual(result.persisted, before);
  });

  test('AC2: non-quota --reason fails exit 1 with no state mutation', async () => {
    const before = seedState();
    const result = await runCliInSandbox(['halt', '--reason', 'exhausted'], {
      seed: before,
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_FAILURE);
    assert.ok(result.stderr.includes('--reason quota'), result.stderr);
    assert.deepStrictEqual(result.persisted, before);
  });

  test('AC2: missing --reason on empty workspace writes no state file', async () => {
    const prevCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-nomut-'));
    const origLog = console.log;
    const origErr = console.error;
    let stderr = '';
    try {
      process.chdir(tempDir);
      console.log = (..._a: any[]): void => {};
      console.error = (...a: any[]) => {
        stderr += a.map(String).join(' ') + '\n';
      };
      delete process.env.AGY_SUBAGENT;
      const code = await runCli(['halt']);
      assert.strictEqual(code, EXIT_CODE_FAILURE);
      assert.ok(!fs.existsSync(stateFilePath(tempDir)), 'no state file must be created');
    } finally {
      process.chdir(prevCwd);
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('AC3: --retry-after drives quotaResetAt in JSON output', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--retry-after', '120', '--json'], {
      seed: seedState(),
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.strictEqual(payload.quotaResetEstimated, false);
    const deltaMs = new Date(payload.quotaResetAt).getTime() - new Date(payload.pausedAtTimestamp).getTime();
    assert.strictEqual(deltaMs, 120 * 1000);
  });

  test('AC3: --retry-after=<n> form is accepted', async () => {
    const result = await runCliInSandbox(['halt', '--reason=quota', '--retry-after=45', '--json'], {
      seed: seedState(),
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    const payload = JSON.parse(result.stdout);
    const deltaMs = new Date(payload.quotaResetAt).getTime() - new Date(payload.pausedAtTimestamp).getTime();
    assert.strictEqual(deltaMs, 45 * 1000);
  });

  test('AC3: absent --retry-after falls back to the estimated default window', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--json'], {
      seed: seedState(),
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.quotaResetEstimated, true);
    const deltaMs = new Date(payload.quotaResetAt).getTime() - new Date(payload.pausedAtTimestamp).getTime();
    assert.strictEqual(deltaMs, QUOTA_DEFAULT_RETRY_AFTER_SECONDS * 1000);
  });

  for (const bad of ['abc', '-5', '1.5', '9999999']) {
    test(`AC3: invalid --retry-after '${bad}' fails exit 1 with no mutation`, async () => {
      const before = seedState();
      const result = await runCliInSandbox(['halt', '--reason', 'quota', '--retry-after', bad], {
        seed: before,
        env: { AGY_SUBAGENT: undefined }
      });
      assert.strictEqual(result.code, EXIT_CODE_FAILURE);
      assert.ok(result.stderr.includes('--retry-after'), result.stderr);
      assert.deepStrictEqual(result.persisted, before);
    });
  }

  test('AC4: --json emits a single machine-readable document on stdout', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--retry-after', '60', '--json'], {
      seed: seedState(),
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.ok(payload.quotaResetAt);
    assert.strictEqual(payload.persisted, true);
    assert.strictEqual(result.stderr, '', 'diagnostics must not leak onto stderr in the success path');
  });

  test('AC4: --dry-run resolves without writing state but still exits 2', async () => {
    const before = seedState();
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--dry-run', '--json'], {
      seed: before,
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.persisted, false);
    assert.strictEqual(payload.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.deepStrictEqual(result.persisted, before);
  });

  test('AC5: AGY_SUBAGENT=1 permits halt (no Zero Direct Root Mutation block)', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--dry-run'], {
      seed: seedState(),
      env: { AGY_SUBAGENT: '1' }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    assert.ok(!result.stderr.includes('Zero Direct Root Mutation'), result.stderr);
    assert.ok(!result.stderr.includes('Subagents are not permitted'), result.stderr);
  });

  test('AC6: halt -> resume round-trip clears the pause', async () => {
    const prevCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-roundtrip-'));
    const origLog = console.log;
    const origErr = console.error;
    let stdout = '';
    try {
      fs.mkdirSync(path.join(tempDir, '.agyloop'), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        stateFilePath(tempDir),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: null,
          createdAt: now,
          updatedAt: now,
          history: [{ stage: 'IMPLEMENT', timestamp: now }]
        })
      );
      process.chdir(tempDir);
      console.log = (...a: any[]) => {
        stdout += a.map(String).join(' ') + '\n';
      };
      console.error = (..._a: any[]): void => {};
      delete process.env.AGY_SUBAGENT;
      assert.strictEqual(await runCli(['halt', '--reason', 'quota']), EXIT_CODE_QUOTA_EXHAUSTED);
      assert.strictEqual(readState(tempDir)?.pausedAtGate, GATE_CIRCUIT_BREAKER);

      stdout = '';
      assert.strictEqual(await runCli(['status']), EXIT_CODE_SUCCESS);
      assert.ok(stdout.includes(GATE_CIRCUIT_BREAKER), 'status must report the breaker pause');

      assert.strictEqual(await runCli(['resume']), EXIT_CODE_SUCCESS);
      assert.strictEqual(readState(tempDir)?.pausedAtGate, null);
    } finally {
      process.chdir(prevCwd);
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('AC8: halt is registered in help, CLI_COMMANDS and STATE_MUTATING_COMMANDS', async () => {
    assert.strictEqual(COMMAND_HALT, 'halt');
    assert.strictEqual(CLI_COMMANDS.HALT, 'halt');
    assert.ok(
      (STATE_MUTATING_COMMANDS).includes('halt'),
      'halt must be listed as state-mutating so the root guard covers it'
    );

    const prevCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-help-'));
    const origLog = console.log;
    const origErr = console.error;
    let stdout = '';
    try {
      process.chdir(tempDir);
      console.log = (...a: any[]) => {
        stdout += a.map(String).join(' ') + '\n';
      };
      console.error = (..._a: any[]): void => {};
      assert.strictEqual(await runCli(['--help']), EXIT_CODE_SUCCESS);
      assert.ok(stdout.includes('halt --reason quota'), 'help must document the halt channel');
      assert.ok(stdout.includes('codeloop halt --reason quota'), 'exit-code docs must name the inbound channel');
    } finally {
      process.chdir(prevCwd);
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('parseArguments captures --retry-after in both forms', () => {
    assert.strictEqual(parseArguments(['halt', '--reason', 'quota', '--retry-after', '120']).options.retryAfter, '120');
    assert.strictEqual(parseArguments(['halt', '--retry-after=45']).options.retryAfter, '45');
    assert.strictEqual(parseArguments(['halt']).options.retryAfter, null);
  });
});

describe('codeloop halt --issue (issue #225)', () => {
  let originalLog: any;
  let originalError: any;

  beforeEach(() => {
    originalLog = console.log;
    originalError = console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  function taskFilePath(dir: string, issue: number): string {
    return path.join(dir, '.agyloop', 'tasks', `${issue}.json`);
  }

  function readTask(dir: string, issue: number): any {
    try {
      return JSON.parse(fs.readFileSync(taskFilePath(dir, issue), 'utf8'));
    } catch {
      return null;
    }
  }

  async function runCliInSandbox(args: readonly string[], { seed = null, env = {} }: any = {}): Promise<any> {
    const prevCwd = process.cwd();
    const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-issue-'));
    const originalEnv: any = {};
    for (const key of Object.keys(env)) {
      originalEnv[key] = process.env[key];
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = env[key];
      }
    }
    const origLog = console.log;
    const origErr = console.error;
    let stdout = '';
    let stderr = '';
    try {
      if (seed !== null) {
        fs.mkdirSync(path.join(tempDir, '.agyloop'), { recursive: true });
        fs.writeFileSync(stateFilePath(tempDir), JSON.stringify(seed));
      }
      process.chdir(tempDir);
      console.log = (...a: any[]) => {
        stdout += a.map(String).join(' ') + '\n';
      };
      console.error = (...a: any[]) => {
        stderr += a.map(String).join(' ') + '\n';
      };
      const code = await runCli(args);
      return {
        code,
        stdout: stdout.replace(ANSI_ESCAPE, ''),
        stderr: stderr.replace(ANSI_ESCAPE, ''),
        rootState: readState(tempDir),
        taskState: readTask(tempDir, 999)
      };
    } finally {
      process.chdir(prevCwd);
      console.log = origLog;
      console.error = origErr;
      for (const key of Object.keys(env)) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  test('AC1: halt --issue 999 writes tasks/999.json with issue:999', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--retry-after', '60', '--issue', '999'], {
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    assert.ok(result.taskState, 'tasks/999.json must exist');
    assert.strictEqual(result.taskState.issue, 999);
    assert.strictEqual(result.taskState.pausedAtGate, GATE_CIRCUIT_BREAKER);
    assert.strictEqual(result.rootState, null, 'root state.json must remain untouched');
  });

  test('AC2: halt --issue 999 --json includes issue in output', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--retry-after', '60', '--issue', '999', '--json'], {
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.issue, 999);
    assert.strictEqual(payload.pausedAtGate, GATE_CIRCUIT_BREAKER);
  });

  test('AC3: halt --issue 999 --dry-run writes nothing', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--issue', '999', '--dry-run', '--json'], {
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.persisted, false);
    assert.strictEqual(payload.issue, 999);
    assert.strictEqual(result.taskState, null, 'dry-run must not write tasks/999.json');
    assert.strictEqual(result.rootState, null, 'dry-run must not write root state.json');
  });

  test('AC4: halt without --issue keeps root checkpoint with issue:null', async () => {
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--json'], {
      env: { AGY_SUBAGENT: undefined }
    });
    assert.strictEqual(result.code, EXIT_CODE_QUOTA_EXHAUSTED);
    assert.ok(result.rootState, 'root state.json must exist');
    assert.strictEqual(result.rootState.issue, null);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.issue, null);
  });

  test('AC5: halt --issue 999 preserves first-wins pausedAtTimestamp', async () => {
    const firstPause = '2026-10-14T12:00:00.000Z';
    const prevCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-issue-firstwins-'));
    const origLog = console.log;
    const origErr = console.error;
    try {
      fs.mkdirSync(path.join(tempDir, '.agyloop', 'tasks'), { recursive: true });
      fs.writeFileSync(
        taskFilePath(tempDir, 999),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: 999,
          createdAt: firstPause,
          updatedAt: firstPause,
          history: [{ stage: 'IMPLEMENT', timestamp: firstPause }],
          pausedAtGate: GATE_CIRCUIT_BREAKER,
          pausedAtTimestamp: firstPause
        })
      );
      process.chdir(tempDir);
      console.log = (..._a: any[]): void => {};
      console.error = (..._a: any[]): void => {};
      delete process.env.AGY_SUBAGENT;
      assert.strictEqual(await runCli(['halt', '--reason', 'quota', '--issue', '999']), EXIT_CODE_QUOTA_EXHAUSTED);
      const state = readTask(tempDir, 999);
      assert.strictEqual(state.pausedAtTimestamp, firstPause);
      assert.strictEqual(state.issue, 999);
    } finally {
      process.chdir(prevCwd);
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #250 (AC B2): `halt` and `status` can never disagree about which
 * checkpoint they address.
 *
 * `halt --issue 999abc` used to WRITE `.agyloop/state.json` (the root) while
 * `status --issue 999abc` read `tasks/999.json` (the clamped 999). One token,
 * four resolutions — clamp / root / literal-target / fail. The policy is now
 * ONE: fail, before anything is read or written.
 */
describe('codeloop halt rejects a garbage --issue token (#250)', () => {
  async function runCliInSandbox(args: readonly string[], { seed = null, env = {} }: any = {}): Promise<any> {
    const prevCwd = process.cwd();
    const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-garbage-'));
    const originalEnv: any = {};
    for (const key of Object.keys(env)) {
      originalEnv[key] = process.env[key];
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = env[key];
      }
    }
    const origLog = console.log;
    const origErr = console.error;
    let stdout = '';
    let stderr = '';
    try {
      if (seed !== null) {
        fs.mkdirSync(path.join(tempDir, '.agyloop'), { recursive: true });
        fs.writeFileSync(stateFilePath(tempDir), JSON.stringify(seed));
      }
      process.chdir(tempDir);
      console.log = (...a: any[]) => {
        stdout += a.map(String).join(' ') + '\n';
      };
      console.error = (...a: any[]) => {
        stderr += a.map(String).join(' ') + '\n';
      };
      const code = await runCli(args);
      return {
        code,
        stdout: stdout.replace(ANSI_ESCAPE, ''),
        stderr: stderr.replace(ANSI_ESCAPE, ''),
        rootState: readState(tempDir),
        rootBytes: fs.readFileSync(stateFilePath(tempDir), 'utf8'),
        taskExists: fs.existsSync(path.join(tempDir, '.agyloop', 'tasks', '999abc.json'))
      };
    } finally {
      process.chdir(prevCwd);
      console.log = origLog;
      console.error = origErr;
      for (const key of Object.keys(env)) {
        if (originalEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  test('T-B2: halt --issue 999abc exits 1 and writes nothing at all', async () => {
    const seed = seedState();
    const result = await runCliInSandbox(['halt', '--reason', 'quota', '--issue', '999abc'], {
      seed,
      env: { AGY_SUBAGENT: undefined }
    });

    assert.strictEqual(result.code, EXIT_CODE_FAILURE);
    assert.ok(result.stderr.includes('999abc'), result.stderr);
    assert.deepStrictEqual(result.rootState, seed, 'the root checkpoint must be untouched');
    assert.strictEqual(result.taskExists, false, 'no tasks/999abc.json may be created');
  });

  test('T-B2: status --issue 999abc exits 1 as well', async () => {
    const result = await runCliInSandbox(['status', '--issue', '999abc'], {
      seed: seedState(),
      env: { AGY_SUBAGENT: undefined }
    });

    assert.strictEqual(result.code, EXIT_CODE_FAILURE);
    assert.ok(result.stderr.includes('999abc'), result.stderr);
  });

  test('T-B2: a valid --issue 999 addresses tasks/999.json, never the root', async () => {
    const prevCwd = process.cwd();
    const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-halt-valid-'));
    const origLog = console.log;
    const origErr = console.error;
    try {
      fs.mkdirSync(path.join(tempDir, '.agyloop', 'tasks'), { recursive: true });
      const rootSeed = seedState();
      fs.writeFileSync(stateFilePath(tempDir), JSON.stringify(rootSeed));
      process.chdir(tempDir);
      console.log = (..._a: any[]): void => {};
      console.error = (..._a: any[]): void => {};
      delete process.env.AGY_SUBAGENT;

      assert.strictEqual(
        await runCli(['halt', '--reason', 'quota', '--issue', '999']),
        EXIT_CODE_QUOTA_EXHAUSTED
      );

      const task = JSON.parse(fs.readFileSync(path.join(tempDir, '.agyloop', 'tasks', '999.json'), 'utf8'));
      assert.strictEqual(task.pausedAtGate, GATE_CIRCUIT_BREAKER);
      assert.strictEqual(task.issue, 999);
      assert.deepStrictEqual(readState(tempDir), rootSeed, 'the root must be byte-identical');
    } finally {
      process.chdir(prevCwd);
      console.log = origLog;
      console.error = origErr;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
