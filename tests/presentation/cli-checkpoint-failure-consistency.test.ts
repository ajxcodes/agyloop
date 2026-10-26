/**
 * agyloop - corrupt-checkpoint failure consistency (#251, absorbed by #248)
 *
 * Two contracts:
 *
 *   1. a checkpoint that PARSES but carries an invalid stage must be a rendered
 *      `✗`, never `Fatal:` + a raw stack;
 *   2. every command that reads the same corrupt checkpoint must reach the SAME
 *      verdict: exit 1, rendered, silent-0 never.
 *
 * A third contract is the reason `status` is special: one bad file in `tasks/`
 * must not brick the whole workspace matrix (AC-251.3).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const SEEDED_AT = '2026-10-01T00:00:00.000Z';

interface CaptureResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

function validSnapshot(issue: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    currentStage: 'PLAN',
    mode: 'standard',
    issue,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    history: [{ stage: 'PLAN', timestamp: SEEDED_AT }],
    ...overrides
  };
}

function seedTaskFile(dir: string, issue: number, contents: string): void {
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agyloop', 'tasks', `${issue}.json`), contents);
}

async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-corrupt-'));
  let stdout = '';
  let stderr = '';

  try {
    seed?.(tempDir);
    process.chdir(tempDir);
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertRendered(result: CaptureResult, label: string): void {
  assert.strictEqual(result.code, 1, `${label} must exit 1`);
  assert.ok(result.stderr.includes('✗'), `${label} must render a ✗: ${result.stderr}`);
  assert.ok(!result.stderr.includes('Fatal:'), `${label} must not print Fatal:`);
  assert.ok(!result.stderr.includes('    at '), `${label} must not print a stack frame`);
}

describe('corrupt checkpoints (#251)', () => {
  test('T-C1: status --issue on a GARBAGE stage renders, never crashes', async () => {
    const result = await runCliInSandbox(['status', '--issue', '999'], (dir) =>
      seedTaskFile(dir, 999, JSON.stringify({ currentStage: 'GARBAGE' }))
    );
    assertRendered(result, 'status --issue 999');
    assert.match(result.stderr, /✗ Status failed:/);
  });

  test('T-C2: one bad file does not brick the active-task matrix', async () => {
    const result = await runCliInSandbox(['status'], (dir) => {
      seedTaskFile(dir, 998, JSON.stringify(validSnapshot(998, { updatedAt: '2026-10-02T00:00:00.000Z' })));
      seedTaskFile(dir, 999, JSON.stringify({ currentStage: 'GARBAGE' }));
    });
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(!result.stderr.includes('Fatal:'), result.stderr);
    assert.ok(result.stdout.includes('#998'), result.stdout);
    assert.ok(!result.stdout.includes('#999'), `the invalid row must be skipped:\n${result.stdout}`);
    assert.match(result.stderr, /Skipped unreadable checkpoint/);
  });

  test('T-C2b: status --json reports skippedCorrupt without failing', async () => {
    const result = await runCliInSandbox(['status', '--json'], (dir) => {
      seedTaskFile(dir, 998, JSON.stringify(validSnapshot(998, { updatedAt: '2026-10-02T00:00:00.000Z' })));
      seedTaskFile(dir, 999, JSON.stringify({ currentStage: 'GARBAGE' }));
    });
    assert.strictEqual(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.skippedCorrupt));
    assert.strictEqual(payload.skippedCorrupt.length, 1);
    assert.match(payload.skippedCorrupt[0].error, /Invalid stage 'GARBAGE'/);
    assert.ok(payload.skippedCorrupt[0].path, 'the skipped row must name its file');
  });

  test('T-C3: the same corrupt checkpoint is exit 1 + rendered across every reader', async () => {
    const invocations: Array<[string, string[]]> = [
      ['status', ['status', '--issue', '999']],
      ['next', ['next', '--issue', '999']],
      ['next --json', ['next', '--issue', '999', '--json']],
      ['resume', ['resume', '--issue', '999']],
      ['halt', ['halt', '--reason', 'quota', '--issue', '999']],
      ['transition', ['transition', 'PLAN', '--issue', '999']],
      ['branch-info', ['branch-info', '--issue', '999']]
    ];

    for (const [label, args] of invocations) {
      const result = await runCliInSandbox(args, (dir) =>
        seedTaskFile(dir, 999, JSON.stringify({ currentStage: 'GARBAGE' }))
      );
      assertRendered(result, label);
    }
  });

  test('T-C4: an unparseable task file is still dropped from the scan', async () => {
    const result = await runCliInSandbox(['status'], (dir) => {
      seedTaskFile(dir, 998, JSON.stringify(validSnapshot(998)));
      seedTaskFile(dir, 997, '{"currentStage": "PLAN"');
    });
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(!result.stderr.includes('Fatal:'), result.stderr);
    assert.ok(!result.stdout.includes('#997'), result.stdout);
  });
});
