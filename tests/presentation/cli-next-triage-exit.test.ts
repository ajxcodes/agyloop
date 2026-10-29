/**
 * agyloop - `next` exits the TRIAGE gate on a terminal PR (issue #351, AC-1)
 *
 * The unit suite proves the decision; this one proves the CLI does not undo it.
 * The #349 failure was observed HERE: `codeloop next --json` at TRIAGE returned
 * `actionable: false` with a `pause.gate: "TRIAGE"` for a PR that had been
 * merged, and stderr told the operator to `codeloop resume`.
 *
 * CLI1 - a MERGED PR: COMPLETED / idle, pause consumed, no triage directive
 * CLI2 - a CLOSED PR: the same
 * CLI3 - an OPEN PR: the TRIAGE directive and the checkpoint pause survive
 * CLI4 - the human report says [COMPLETED] and never names the triage subagent
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 351;

/** A `gh` stub answering `pr list` with the given PR state. */
function installGhStub(binDir: string, state: 'OPEN' | 'MERGED' | 'CLOSED'): void {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'gh');
  const mergedAt = state === 'MERGED' ? '"2026-10-28T00:00:00Z"' : 'null';
  const pr = [
    '{',
    `"number":7,`,
    `"title":"Task #${ISSUE}",`,
    `"body":"Closes #${ISSUE}",`,
    `"state":"${state}",`,
    `"mergedAt":${mergedAt},`,
    '"baseRefName":"main",',
    `"headRefName":"task/${ISSUE}",`,
    '"url":"https://example.test/pull/7",',
    '"labels":[]',
    '}'
  ].join('');
  fs.writeFileSync(
    file,
    ['#!/bin/sh', 'case "$*" in', `  *"pr list"*) echo '[${pr}]' ;;`, '  *) echo \'\' ;;', 'esac', ''].join('\n'),
    'utf8'
  );
  fs.chmodSync(file, 0o755);
}

interface Sandbox {
  readonly dir: string;
  readonly binDir: string;
  readonly stateFile: string;
}

/** A git repo parked at the TRIAGE gate for issue #351 — the #349 shape. */
function seedSandbox(state: 'OPEN' | 'MERGED' | 'CLOSED'): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-next-triage-exit-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'], { cwd: dir });

  const stateFile = path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'TRIAGE',
        mode: 'standard',
        issue: ISSUE,
        baseBranch: 'main',
        triagePayload: '- [reviewer]: please fix the nil dereference',
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'TRIAGE', timestamp: now }],
        pausedAtGate: 'TRIAGE',
        pausedAtTimestamp: now,
        totalHumanWaitMs: 0
      },
      null,
      2
    ),
    'utf8'
  );

  const binDir = path.join(dir, 'bin');
  installGhStub(binDir, state);
  return { dir, binDir, stateFile };
}

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

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

describe('`next` exits the TRIAGE gate on a terminal PR (issue #351)', () => {
  let sandboxes: string[] = [];

  beforeEach(() => {
    sandboxes = [];
  });

  afterEach(() => {
    for (const dir of sandboxes) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const state of ['MERGED', 'CLOSED'] as const) {
    test(`CLI${state === 'MERGED' ? '1' : '2'}: a ${state} PR reports COMPLETED / idle and never a triage directive`, async () => {
      const sandbox = seedSandbox(state);
      sandboxes.push(sandbox.dir);

      const run = await runIn(sandbox, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.currentStage, 'COMPLETED');
      assert.strictEqual(payload.actionType, 'completed');
      assert.strictEqual(payload.pause, null, 'the TRIAGE pause is consumed, so nothing is paused');
      assert.ok(
        !JSON.stringify(payload).includes('Invoke Triage Subagent'),
        'a merged/closed PR must not yield a triage directive'
      );

      const persisted = readCheckpoint(sandbox);
      assert.strictEqual(persisted.currentStage, 'COMPLETED');
      assert.strictEqual(persisted.pausedAtGate, null);
      assert.strictEqual(persisted.triagePayload, null);
      const last = persisted.history[persisted.history.length - 1];
      assert.strictEqual(last.metadata?.triageExit, 'pr-terminal');
      assert.strictEqual(last.metadata?.prState, state);
      assert.strictEqual(last.metadata?.prNumber, 7);

      // Issue #354 (item 1): the persisted note and the printed report must
      // distinguish a merged delivery from a closed-without-merge non-delivery.
      if (state === 'CLOSED') {
        assert.match(String(last.metadata?.note), /closed without merging/);
        assert.match(String(last.metadata?.note), /not delivered/);
        assert.ok(
          payload.humanSummary.includes('not delivered'),
          `the CLOSED report must name the non-delivery: ${payload.humanSummary}`
        );
      } else {
        assert.strictEqual(
          String(last.metadata?.note),
          'Triage gate ended: PR #7 is MERGED. Open review feedback no longer needs a disposition.'
        );
        assert.ok(
          !payload.humanSummary.includes('not delivered'),
          `MERGED must not claim a non-delivery: ${payload.humanSummary}`
        );
      }

      assert.ok(!run.stderr.includes('🛑'), `no gate banner for a finished gate: ${run.stderr}`);
      assert.ok(
        !run.stderr.includes('codeloop resume'),
        `the operator must not be told to resume: ${run.stderr}`
      );
    });
  }

  test('CLI3: an OPEN PR still reports the TRIAGE directive and keeps the pause', async () => {
    const sandbox = seedSandbox('OPEN');
    sandboxes.push(sandbox.dir);

    const run = await runIn(sandbox, ['next', '--issue', String(ISSUE), '--json']);
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    const payload = JSON.parse(run.stdout);
    assert.strictEqual(payload.currentStage, 'TRIAGE');
    assert.strictEqual(payload.role, 'triage');
    assert.strictEqual(payload.actionType, 'subagent');
    assert.ok(payload.invocationPayload, 'the triage directive carries its payload');

    const persisted = readCheckpoint(sandbox);
    assert.strictEqual(persisted.currentStage, 'TRIAGE');
    assert.strictEqual(persisted.pausedAtGate, 'TRIAGE');
  });

  test('CLI4: the human report names [COMPLETED] and never the triage subagent', async () => {
    const sandbox = seedSandbox('MERGED');
    sandboxes.push(sandbox.dir);

    const run = await runIn(sandbox, ['next', '--issue', String(ISSUE)]);
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    assert.match(run.stdout, /\[COMPLETED\]/);
    assert.match(run.stdout, /Pipeline Completed \/ Idle/);
    assert.ok(
      !run.stdout.includes('Invoke Triage Subagent'),
      `no triage directive may be printed, got:\n${run.stdout}`
    );
    assert.ok(
      run.stdout.includes('Triage gate ended: PR #7 is MERGED.'),
      `the report must say why the gate ended, got:\n${run.stdout}`
    );
    assert.ok(
      !run.stdout.includes('not delivered'),
      `MERGED must not claim a non-delivery, got:\n${run.stdout}`
    );
  });

  test('CLI5: the CLOSED human report names the non-delivery (issue #354)', async () => {
    const sandbox = seedSandbox('CLOSED');
    sandboxes.push(sandbox.dir);

    const run = await runIn(sandbox, ['next', '--issue', String(ISSUE)]);
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    assert.match(run.stdout, /\[COMPLETED\]/);
    assert.ok(
      run.stdout.includes('closed without merging'),
      `the report must say the PR was closed without merging, got:\n${run.stdout}`
    );
    assert.ok(
      run.stdout.includes('not delivered'),
      `the report must say the run was not delivered, got:\n${run.stdout}`
    );
    assert.ok(
      !run.stdout.includes('Invoke Triage Subagent'),
      `no triage directive may be printed, got:\n${run.stdout}`
    );
  });
});
