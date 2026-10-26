/**
 * agyloop - `--json` surface contract (#275, absorbed by #248 Wave 3)
 *
 * Two defects are pinned here:
 *
 *   A. `triage --json` printed a human banner to stdout BEFORE its JSON, so
 *      `codeloop triage --json | jq` died on the banner even though the command
 *      succeeded.
 *   B. `--json` was silently ignored by commands with no JSON surface, so a
 *      consumer got human text and exit 0.
 *
 * The enumeration is derived from `COMMAND_CAPABILITIES` — the SAME table the
 * capability gate reads — never a second hand-maintained list.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { COMMAND_CAPABILITIES } = require('../../dist/presentation/cli-flags');

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

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    currentStage: 'PLAN',
    mode: 'standard',
    issue: null,
    milestoneTitle: null,
    baseBranch: 'main',
    worktree: null,
    planDir: null,
    triagePayload: null,
    triageDisposition: null,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    history: [{ stage: 'PLAN', timestamp: SEEDED_AT }],
    pausedAtGate: null,
    pausedAtTimestamp: null,
    totalHumanWaitMs: 0,
    planRevisionCount: 0,
    implementToGateLoops: 0,
    reviewDispatchCount: 0,
    ...overrides
  };
}

function seedRoot(dir: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.agyloop'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agyloop', 'state.json'), JSON.stringify(snapshot(overrides)));
}

function seedTask(dir: string, issue: number, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'tasks', `${issue}.json`),
    JSON.stringify(snapshot({ issue, ...overrides }))
  );
}

function initGitWorkspace(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

async function runCliInSandbox(
  args: readonly string[],
  seed?: (dir: string) => void
): Promise<CaptureResult> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-json-'));
  let stdout = '';
  let stderr = '';

  try {
    seed?.(tempDir);
    process.chdir(tempDir);
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
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
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * One fixture per capability key. A key added to the table without a fixture
 * (or a fixture for a key that no longer exists) fails T-J1 — the enumeration
 * is the table's, not this file's.
 */
const CASES: Record<string, { args: string[]; seed?: (dir: string) => void }> = {
  '(default)': { args: ['--json'] },
  init: { args: ['init', '--json'] },
  next: { args: ['next', '--json'] },
  'branch-info': { args: ['branch-info', '--json'], seed: initGitWorkspace },
  status: { args: ['status', '--json'] },
  config: { args: ['config', '--json'] },
  models: { args: ['models', '--json'] },
  prompt: { args: ['prompt', '--json'] },
  reset: { args: ['reset', '--json'] },
  resume: { args: ['resume', '--json'] },
  halt: { args: ['halt', '--reason', 'quota', '--json'], seed: (dir) => seedRoot(dir, { currentStage: 'IMPLEMENT' }) },
  abort: { args: ['abort', '--json'] },
  transition: { args: ['transition', 'PLAN', '--json'] },
  'worktree:list': { args: ['worktree', 'list', '--json'] },
  'worktree:clean': { args: ['worktree', 'clean', '--json'] },
  'worktree:prune': { args: ['worktree', 'prune', '--json'] },
  'worktree:remove': { args: ['worktree', 'remove', '902', '--json'] },
  'critique:status': { args: ['critique', 'status', '--json'] },
  'critique:install': { args: ['critique', 'install', '--json'] },
  'critique:update': { args: ['critique', 'update', '--json'] },
  'opencode:install': { args: ['opencode', 'install', '--json'] },
  triage: {
    args: ['triage', '--issue', '901', '--json'],
    seed: (dir) => seedTask(dir, 901, { currentStage: 'TRIAGE' })
  },
  review: {
    args: ['review', '--issue', '905', '--verdict-file', 'verdict.md', '--json'],
    seed: (dir) => {
      initGitWorkspace(dir);
      seedTask(dir, 905, { currentStage: 'REVIEW' });
      fs.writeFileSync(path.join(dir, 'verdict.md'), 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: ok\n');
    }
  },
  plan: { args: ['plan', '--json'] },
  implement: { args: ['implement', '--json'] },
  commit: { args: ['commit', '--json'] },
  release: { args: ['release', '--json'] },
  yolo: { args: ['yolo', '--json'] },
  sync: { args: ['sync', '--json'] }
};

describe('--json surface contract (#275)', () => {
  test('T-J1: the fixture map matches the capability table exactly', () => {
    const tableKeys = Object.keys(COMMAND_CAPABILITIES).sort();
    const fixtureKeys = Object.keys(CASES).sort();
    assert.deepStrictEqual(fixtureKeys, tableKeys);
  });

  test('T-J2/T-J7: every supported surface emits ONE document with a dryRun marker', async () => {
    const supported = Object.keys(COMMAND_CAPABILITIES).filter(
      (key) => (COMMAND_CAPABILITIES as any)[key].json === 'supported'
    );
    assert.ok(supported.length >= 9, 'the JSON surface must not shrink silently');

    for (const key of supported) {
      const fixture = CASES[key];
      const result = await runCliInSandbox(fixture.args, fixture.seed);
      // `halt` predicts the real command's exit code (2) even in JSON mode.
      assert.ok(
        result.code === 0 || (key === 'halt' && result.code === 2),
        `${key}: ${result.stderr}`
      );
      assert.ok(!result.stdout.includes('\x1b'), `${key} must not emit ANSI on stdout`);
      let payload: any;
      try {
        payload = JSON.parse(result.stdout);
      } catch {
        assert.fail(`${key} did not emit a single JSON document:\n${result.stdout}\nstderr:${result.stderr}`);
      }
      assert.strictEqual(typeof payload.dryRun, 'boolean', `${key} payload must carry a dryRun marker`);
    }
  });

  test('T-J3: every refused surface errors and prints no JSON document', async () => {
    const refused = Object.keys(COMMAND_CAPABILITIES).filter(
      (key) => (COMMAND_CAPABILITIES as any)[key].json === 'refused'
    );
    for (const key of refused) {
      const fixture = CASES[key];
      const result = await runCliInSandbox(fixture.args, fixture.seed);
      assert.notStrictEqual(result.code, 0, `${key} must refuse --json`);
      assert.ok(result.stderr.includes('--json'), `${key}: ${result.stderr}`);
      assert.ok(!result.stdout.trimStart().startsWith('{'), `${key} printed a JSON document`);
    }
  });

  test('T-J4: `triage --json` stdout is parseable on its own (the banner bug)', async () => {
    const result = await runCliInSandbox(['triage', '--issue', '901', '--json'], (dir) =>
      seedTask(dir, 901, { currentStage: 'TRIAGE' })
    );
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(
      !result.stdout.includes('=== CodeLoop: PR Review Comments Triage ==='),
      `the banner must not precede the JSON document:\n${result.stdout}`
    );
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.dryRun, false);
    assert.strictEqual(typeof payload.stateUpdated, 'boolean');
    assert.ok(!('stateMachine' in payload), 'the payload must not serialise the entity');
  });

  test('T-J5: `status --json` is a single document with raw (ANSI-free) fields', async () => {
    const result = await runCliInSandbox(['status', '--json'], (dir) => {
      seedRoot(dir, { currentStage: 'COMPLETED', mode: 'standard', issue: 905 });
      seedTask(dir, 999, { currentStage: 'PLAN' });
    });
    assert.strictEqual(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes('\x1b'), 'no ANSI in a JSON document');
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.dryRun, false);
    assert.strictEqual(payload.currentStage, 'PLAN');
    assert.strictEqual(payload.mode, 'standard');
    assert.strictEqual(payload.resolvedIssue, 999);
    assert.ok(Array.isArray(payload.activeTasks));
    assert.ok(Array.isArray(payload.history));
    assert.ok(!('stateMachine' in payload));
  });

  test('T-J6: `review --json --dry-run` asserts no unwritten state', async () => {
    const result = await runCliInSandbox(
      ['review', '--issue', '905', '--verdict-file', 'verdict.md', '--json', '--dry-run'],
      (dir) => {
        initGitWorkspace(dir);
        seedTask(dir, 905, { currentStage: 'REVIEW' });
        fs.writeFileSync(path.join(dir, 'verdict.md'), 'REVIEW_STATUS: APPROVED\nREVIEW_SUMMARY: ok\n');
      }
    );
    assert.strictEqual(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.dryRun, true);
    assert.strictEqual(payload.previousStage, 'REVIEW');
    assert.strictEqual(payload.currentStage, 'REVIEW');
    assert.strictEqual(payload.wouldSetStage, 'COMMIT');
    assert.strictEqual(payload.wouldRecordVerdict, 'APPROVED');
    assert.ok(!('reviewVerdict' in payload), 'a dry run must not claim a filed verdict');
  });

  test('T-J9: `triage --json --dry-run` reports a prediction, never a written disposition', async () => {
    const result = await runCliInSandbox(
      ['triage', 'implement', '--issue', '901', '--dry-run', '--json'],
      (dir) => seedTask(dir, 901, { currentStage: 'TRIAGE' })
    );
    assert.strictEqual(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.strictEqual(payload.dryRun, true);
    assert.strictEqual(payload.stateUpdated, false);
    // The past-tense claim is the defect (#248, AC-275.6): nothing was written,
    // so no disposition may be reported as recorded, and no `recordedAt`
    // timestamp may be presented as a fact.
    assert.strictEqual(payload.dispositionRecorded, false);
    assert.strictEqual(payload.disposition, null);
    assert.ok(!JSON.stringify(payload).includes('recordedAt'), 'a dry run must not carry a recordedAt timestamp');
    // No PR feedback is readable in this fixture, so the PREDICTION is that
    // nothing would be recorded. With feedback, the triage use-case test
    // asserts `wouldRecordDisposition === true` while `dispositionRecorded`
    // stays false.
    assert.strictEqual(payload.wouldRecordDisposition, false);
  });
});
