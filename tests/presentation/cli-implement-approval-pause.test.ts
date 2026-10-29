/**
 * agyloop - `implement` consumes the APPROVAL pause end-to-end (issue #367)
 *
 * Mirrors the issue's reproduction against a real git sandbox instead of a
 * mock: an APPROVAL-parked checkpoint with `pausedAtGate: 'APPROVAL'` is driven
 * through the real CLI, then `next --json` is asked for the next directive. On
 * the broken build the second command reported `actionable: false` with a pause
 * naming `codeloop implement` — the command that had just run.
 *
 * IP7 - `implement` saves a pause-free IMPLEMENT checkpoint and `next` is
 *       immediately actionable (AC-4, AC-5)
 * IP8 - `implement --dry-run` leaves the checkpoint bytes identical (AC-7)
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 354;
const PAUSED_AT_MS = 60_000;

const PLAN_CONTENT = [
  '# Plan',
  '',
  '## 3. Implementation Steps',
  '',
  '- [ ] Step 1: consume the APPROVAL pause on IMPLEMENT entry',
  '',
  '### Quality Gate Targets',
  '',
  '- `npm run build`',
  ''
].join('\n');

interface Sandbox {
  readonly dir: string;
  readonly binDir: string;
  readonly stateFile: string;
}

/** A real git repo + worktree parked at APPROVAL for issue #354. */
function seedSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-implement-pause-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
  execFileSync('git', ['worktree', 'add', '-q', '-b', `task/${ISSUE}`, `.worktrees/${ISSUE}`, 'main'], {
    cwd: dir
  });

  const planDir = path.join(dir, 'artifacts', 'plans', `${ISSUE}-cli-pause`);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, 'implementation_plan.md'), PLAN_CONTENT, 'utf8');

  const stateFile = path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'APPROVAL',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        planDir,
        worktree: {
          taskId: String(ISSUE),
          worktreePath: path.join(dir, '.worktrees', String(ISSUE)),
          branch: `task/${ISSUE}`,
          baseBranch: 'main',
          isIsolated: true
        },
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'APPROVAL', timestamp: now }],
        pausedAtGate: 'APPROVAL',
        pausedAtTimestamp: new Date(Date.now() - PAUSED_AT_MS).toISOString(),
        totalHumanWaitMs: 7
      },
      null,
      2
    ),
    'utf8'
  );

  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const gh = path.join(binDir, 'gh');
  fs.writeFileSync(
    gh,
    ['#!/bin/sh', 'case "$*" in', '  *"pr list"*) echo \'[]\' ;;', "  *) echo '' ;;", 'esac', ''].join(
      '\n'
    ),
    'utf8'
  );
  fs.chmodSync(gh, 0o755);

  return { dir, binDir, stateFile };
}

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `runCli` inside the sandbox with a stubbed `gh` on PATH. */
async function runIn(sandbox: Sandbox, args: string[]): Promise<CliRun> {
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalPath = process.env.PATH;
  const originalSubagent = process.env.AGY_SUBAGENT;
  let stdout = '';
  let stderr = '';

  try {
    process.chdir(sandbox.dir);
    process.env.PATH = `${sandbox.binDir}${path.delimiter}${originalPath ?? ''}`;
    delete process.env.AGY_SUBAGENT;

    console.log = (...argsOut: any[]) => {
      stdout += argsOut.map(String).join(' ') + '\n';
    };
    console.error = (...argsOut: any[]) => {
      stderr += argsOut.map(String).join(' ') + '\n';
    };

    const code = await runCli(args);
    return {
      code,
      stdout: stdout.replace(ANSI_ESCAPE, ''),
      stderr: stderr.replace(ANSI_ESCAPE, '')
    };
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
    console.error = originalError;
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalSubagent === undefined) {
      delete process.env.AGY_SUBAGENT;
    } else {
      process.env.AGY_SUBAGENT = originalSubagent;
    }
  }
}

function readCheckpoint(sandbox: Sandbox): any {
  return JSON.parse(fs.readFileSync(sandbox.stateFile, 'utf8'));
}

describe('`implement` consumes the APPROVAL pause end-to-end (issue #367)', () => {
  let sandboxes: string[] = [];

  beforeEach(() => {
    sandboxes = [];
  });

  afterEach(() => {
    for (const dir of sandboxes) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('IP7: implement clears the pause and `next --json` is actionable', async () => {
    const sandbox = seedSandbox();
    sandboxes.push(sandbox.dir);

    const implement = await runIn(sandbox, ['implement', '--issue', String(ISSUE)]);
    assert.strictEqual(implement.code, 0, `${implement.stdout}\n${implement.stderr}`);
    assert.match(implement.stdout, /Advanced to/);
    assert.ok(!implement.stdout.includes('[dry-run]'), implement.stdout);

    const persisted = readCheckpoint(sandbox);
    assert.strictEqual(persisted.currentStage, 'IMPLEMENT');
    assert.strictEqual(persisted.pausedAtGate, null, 'the APPROVAL pause must be consumed');
    assert.strictEqual(persisted.pausedAtTimestamp, null);
    assert.ok(
      persisted.totalHumanWaitMs > 7,
      `the wait must be banked, got ${persisted.totalHumanWaitMs}`
    );

    const next = await runIn(sandbox, ['next', '--issue', String(ISSUE), '--json']);
    assert.strictEqual(next.code, 0, `${next.stdout}\n${next.stderr}`);
    const payload = JSON.parse(next.stdout);
    assert.strictEqual(payload.currentStage, 'IMPLEMENT');
    assert.strictEqual(payload.actionable, true, `the implementer must be dispatchable: ${next.stdout}`);
    assert.strictEqual(payload.pause, null, `no pause may survive: ${JSON.stringify(payload.pause)}`);
    assert.strictEqual(payload.role, 'implementer');
    assert.ok(!next.stderr.includes('🛑'), `no gate banner: ${next.stderr}`);
    assert.ok(
      !next.stderr.includes('codeloop resume'),
      `the operator must not be told to resume: ${next.stderr}`
    );
  });

  test('IP8: implement --dry-run leaves the checkpoint byte-identical', async () => {
    const sandbox = seedSandbox();
    sandboxes.push(sandbox.dir);

    const before = fs.readFileSync(sandbox.stateFile, 'utf8');
    const run = await runIn(sandbox, ['implement', '--issue', String(ISSUE), '--dry-run']);
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const after = fs.readFileSync(sandbox.stateFile, 'utf8');

    assert.strictEqual(after, before, '--dry-run must not rewrite the checkpoint');
    const persisted = readCheckpoint(sandbox);
    assert.strictEqual(persisted.currentStage, 'APPROVAL');
    assert.strictEqual(persisted.pausedAtGate, 'APPROVAL');
    assert.strictEqual(persisted.totalHumanWaitMs, 7);
  });
});
