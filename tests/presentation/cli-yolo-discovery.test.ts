/**
 * agyloop - YOLO DISCOVERY park e2e through runCli (issue #234)
 *
 * `codeloop yolo --title "Bug: probe" --type discovery` must end in a
 * checkpointed DISCOVERY park instead of crashing with
 * `Cannot run quality gates from stage 'DISCOVERY'`.
 *
 * C1: canonical repro exits 0, prints next guidance + scaffold line, never the
 *     gate sentinel, and persists `currentStage=DISCOVERY, mode=yolo, pausedAtGate=null`.
 * C2: `[bug]` title classification parks identically (offline title heuristic).
 * C3: the yolo success path surfaces `result.message` (resume + checkpoint copy).
 *
 * Harness: in-process `runCli` sandbox copied from cli-halt.test.ts (cwd under
 * os.tmpdir() -> FileStateRepository smoke isolation proves the temp state file).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS } = require('../../dist/domain');

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
async function runCliInSandbox(args: readonly string[], { env = {} }: any = {}): Promise<any> {
  const prevCwd = process.cwd();
  const tempDir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-yolo-discovery-'));
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

async function runYolo(args: readonly string[]): Promise<any> {
  return runCliInSandbox(args, { env: { AGY_SUBAGENT: undefined } });
}

function assertParked(result: any): void {
  assert.strictEqual(result.code, EXIT_CODE_SUCCESS, `exit 0 expected; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.ok(!result.stdout.includes('Cannot run quality gates from stage'), result.stdout);
  assert.ok(!result.stderr.includes('Cannot run quality gates from stage'), result.stderr);
  assert.ok(result.stdout.includes('codeloop next'), result.stdout);
  assert.ok(result.stdout.includes('📁 Initialized plan directory:'), result.stdout);
  assert.ok(!result.stdout.includes('Auto-approved plan gate'), result.stdout);
  assert.strictEqual(result.persisted?.currentStage, 'DISCOVERY');
  assert.strictEqual(result.persisted?.mode, 'yolo');
  assert.ok(result.persisted?.pausedAtGate == null, 'the park must not record a gate pause');
  const history = result.persisted?.history ?? [];
  const lastEntry = history[history.length - 1];
  assert.strictEqual(lastEntry?.metadata?.note, 'Initiated discovery mode for defect RCA');
}

describe('codeloop yolo DISCOVERY park (issue #234)', () => {
  test('C1: canonical repro parks at DISCOVERY and exits 0', async () => {
    const result = await runYolo(['yolo', '--title', 'Bug: probe', '--type', 'discovery']);
    assertParked(result);
  });

  test('C2: [bug] title classification parks identically', async () => {
    const result = await runYolo(['yolo', '--title', '[bug] probe']);
    assertParked(result);
  });

  test('C3: the success path surfaces the next step and checkpoint guidance, with no resume hint when nothing is paused', async () => {
    // Issue #315 (AC-9): the park does not record a pause, so naming
    // `codeloop resume` here sent the operator to a no-op. The hint returns
    // only when the checkpoint really is paused.
    const result = await runYolo(['yolo', '--title', 'Bug: probe', '--type', 'discovery']);
    assert.match(result.stdout, /codeloop next/);
    assert.match(result.stdout, /State is checkpointed/);
    assert.doesNotMatch(result.stdout, /codeloop resume/);
  });
});
