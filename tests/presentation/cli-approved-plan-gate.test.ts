function readApprovedPlanGateCheckpoint(sandbox: Sandbox): any {
  return readCheckpointPath(sandbox.stateFile);
}

/**
 * codeloop - the approved-plan identity is frozen at the APPROVAL gate (#421)
 *
 * CLI-1: a real `transition APPROVAL` records the plan digest and path
 * CLI-2: a real `implement` refuses a plan edited after approval
 * CLI-3: a real `transition IMPLEMENT` refuses identically and writes nothing
 * CLI-4: the documented PLAN -> APPROVAL -> IMPLEMENT recovery works
 * CLI-5: a non-gated `implement` from PLAN still records the digest
 * CLI-6: a real refusal without `--no-worktree` leaves no worktree or branch (#420)
 *
 * Each case drives the real CLI against a git sandbox, not a mock: the defect
 * was that the certification was attached one stage too late, so only the real
 * command surfaces can pin the fix.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { FilePlanGenerator } = require('../../dist/infrastructure');
const { readCheckpoint: readCheckpointPath } = require('../helpers/state-seed.ts');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 421;

const PLAN_CONTENT = [
  '# [Implementation] - approval digest CLI probe',
  '',
  '## 3. Implementation Steps',
  '',
  '- [ ] **Step 1:** hold',
  ''
].join('\n');

const EDITED_MARKER = '\n<!-- silently edited after approval -->\n';

interface Sandbox {
  readonly dir: string;
  readonly binDir: string;
  readonly stateFile: string;
  readonly planPath: string;
}

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A real git repo parked at PLAN for issue #421 with a readable plan. */
function seedSandbox(currentStage: string = 'PLAN', mode: string = 'standard'): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-approved-plan-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });

  const planDir = path.join(dir, 'artifacts', 'plans', `${ISSUE}-gate`);
  fs.mkdirSync(planDir, { recursive: true });
  const planPath = path.join(planDir, 'implementation_plan.md');
  fs.writeFileSync(planPath, PLAN_CONTENT, 'utf8');

  const stateFile = path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage,
        mode,
        issue: ISSUE,
        milestoneTitle: null,
        baseBranch: 'main',
        worktree: null,
        planDir,
        planPath: null,
        approvedPlanDigest: null,
        approvedPlanPath: null,
        triagePayload: null,
        triageDisposition: null,
        createdAt: now,
        updatedAt: now,
        history: [{ stage: currentStage, timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0
      },
      null,
      2
    ) + '\n',
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

  return { dir, binDir, stateFile, planPath };
}

/** Runs `runCli` inside the sandbox with a stubbed `gh` on PATH. */

/** The canonical harness run with this suite's shadow-bin PATH and clean env. */
async function runInLocal(sandbox: Sandbox, args: string[]): Promise<CliRun> {
  const result = await runCliInSandboxCanonical(args, {
    dir: sandbox.dir,
    stripAnsi: true,
    env: {
      PATH: `${sandbox.binDir}${path.delimiter}${process.env.PATH ?? ''}`
    }
  });
  return { ...result };
}


function hashOf(planPath: string): string {
  return new FilePlanGenerator().hashPlanDocument(planPath) as string;
}

describe('approved-plan identity at the APPROVAL gate (#421)', () => {
  let sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    sandboxes = [];
  });

  function sandboxAtPlan(): Sandbox {
    const sandbox = seedSandbox('PLAN');
    sandboxes.push(sandbox.dir);
    return sandbox;
  }

  test('CLI-1: transition APPROVAL records the plan digest and path', async () => {
    const sandbox = sandboxAtPlan();
    const expected = hashOf(sandbox.planPath);

    const run = await runInLocal(sandbox, ['transition', 'APPROVAL', '--issue', String(ISSUE)]);
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    const checkpoint = readApprovedPlanGateCheckpoint(sandbox);
    assert.strictEqual(checkpoint.currentStage, 'APPROVAL');
    assert.strictEqual(checkpoint.approvedPlanDigest, expected);
    assert.strictEqual(checkpoint.approvedPlanPath, sandbox.planPath);
  });

  test('CLI-2: implement refuses a plan edited after approval', async () => {
    const sandbox = sandboxAtPlan();
    const approve = await runInLocal(sandbox, ['transition', 'APPROVAL', '--issue', String(ISSUE)]);
    assert.strictEqual(approve.code, 0, `${approve.stdout}\n${approve.stderr}`);

    const before = readApprovedPlanGateCheckpoint(sandbox);
    const approved = before.approvedPlanDigest;
    assert.ok(approved, 'the gate must have recorded a digest');

    fs.appendFileSync(sandbox.planPath, EDITED_MARKER, 'utf8');
    const edited = hashOf(sandbox.planPath);
    assert.notStrictEqual(edited, approved);

    const run = await runInLocal(sandbox, ['implement', '--issue', String(ISSUE), '--no-worktree']);
    assert.notStrictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const output = `${run.stdout}\n${run.stderr}`;
    assert.ok(output.includes("Validation failed for field 'approvedPlanDigest'"), output);
    assert.ok(output.includes(approved), output);
    assert.ok(output.includes(edited), output);
    assert.ok(output.includes(sandbox.planPath), output);
    assert.match(output, /changed after approval/);

    const after = readApprovedPlanGateCheckpoint(sandbox);
    assert.strictEqual(after.currentStage, 'APPROVAL');
    assert.strictEqual(after.approvedPlanDigest, approved);
    assert.strictEqual(after.approvedPlanPath, before.approvedPlanPath);
    // Issue #420: this assertion is VACUOUS — `--no-worktree` disables
    // provisioning outright, so it would stay green even when implement
    // provisions an orphan before the guard refuses. CLI-6 covers the real
    // path (no `--no-worktree`) and is the pin for that defect.
    assert.ok(
      !fs.existsSync(path.join(sandbox.dir, '.worktrees', String(ISSUE))),
      'a refusal must not provision a worktree'
    );
  });

  test('CLI-3: transition IMPLEMENT refuses identically and writes nothing', async () => {
    const sandbox = sandboxAtPlan();
    const approve = await runInLocal(sandbox, ['transition', 'APPROVAL', '--issue', String(ISSUE)]);
    assert.strictEqual(approve.code, 0, `${approve.stdout}\n${approve.stderr}`);

    const beforeText = fs.readFileSync(sandbox.stateFile, 'utf8');
    const approved = JSON.parse(beforeText).approvedPlanDigest;

    fs.appendFileSync(sandbox.planPath, EDITED_MARKER, 'utf8');
    const edited = hashOf(sandbox.planPath);

    const run = await runInLocal(sandbox, [
      'transition',
      'IMPLEMENT',
      '--issue',
      String(ISSUE),
      '--no-worktree'
    ]);
    assert.notStrictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const output = `${run.stdout}\n${run.stderr}`;
    assert.ok(output.includes("Validation failed for field 'approvedPlanDigest'"), output);
    assert.ok(output.includes(approved), output);
    assert.ok(output.includes(edited), output);
    assert.ok(output.includes(sandbox.planPath), output);
    assert.match(output, /changed after approval/);

    assert.strictEqual(
      fs.readFileSync(sandbox.stateFile, 'utf8'),
      beforeText,
      'a refusal must leave the checkpoint byte-identical'
    );
  });

  test('CLI-4: the PLAN -> APPROVAL -> IMPLEMENT recovery records the corrected bytes', async () => {
    const sandbox = sandboxAtPlan();
    const approve = await runInLocal(sandbox, ['transition', 'APPROVAL', '--issue', String(ISSUE)]);
    assert.strictEqual(approve.code, 0, `${approve.stdout}\n${approve.stderr}`);

    fs.appendFileSync(sandbox.planPath, EDITED_MARKER, 'utf8');
    const refused = await runInLocal(sandbox, [
      'implement',
      '--issue',
      String(ISSUE),
      '--no-worktree'
    ]);
    assert.notStrictEqual(refused.code, 0, `${refused.stdout}\n${refused.stderr}`);

    // The documented recovery: re-plan, re-approve, implement.
    const replan = await runInLocal(sandbox, ['transition', 'PLAN', '--issue', String(ISSUE)]);
    assert.strictEqual(replan.code, 0, `${replan.stdout}\n${replan.stderr}`);
    const reapprove = await runInLocal(sandbox, ['transition', 'APPROVAL', '--issue', String(ISSUE)]);
    assert.strictEqual(reapprove.code, 0, `${reapprove.stdout}\n${reapprove.stderr}`);

    const corrected = hashOf(sandbox.planPath);
    const implemented = await runInLocal(sandbox, [
      'implement',
      '--issue',
      String(ISSUE),
      '--no-worktree'
    ]);
    assert.strictEqual(implemented.code, 0, `${implemented.stdout}\n${implemented.stderr}`);

    const checkpoint = readApprovedPlanGateCheckpoint(sandbox);
    assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT');
    assert.strictEqual(checkpoint.approvedPlanDigest, corrected);
    assert.strictEqual(checkpoint.approvedPlanPath, sandbox.planPath);
  });

  test('CLI-5: a non-gated implement from PLAN still records the digest', async () => {
    const sandbox = sandboxAtPlan();
    const expected = hashOf(sandbox.planPath);

    const run = await runInLocal(sandbox, ['implement', '--issue', String(ISSUE), '--no-worktree']);
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    const checkpoint = readApprovedPlanGateCheckpoint(sandbox);
    assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT');
    assert.strictEqual(checkpoint.approvedPlanDigest, expected);
    assert.strictEqual(checkpoint.approvedPlanPath, sandbox.planPath);
  });

  test('CLI-6: a real refusal without --no-worktree leaves no worktree, no branch and the APPROVAL checkpoint (#420)', async () => {
    const sandbox = sandboxAtPlan();
    const approve = await runInLocal(sandbox, ['transition', 'APPROVAL', '--issue', String(ISSUE)]);
    assert.strictEqual(approve.code, 0, `${approve.stdout}\n${approve.stderr}`);

    const approved = readApprovedPlanGateCheckpoint(sandbox);
    assert.ok(approved.approvedPlanDigest, 'the gate must have recorded a digest');

    fs.appendFileSync(sandbox.planPath, EDITED_MARKER, 'utf8');

    // No `--no-worktree`: implement provisions first, then the guard refuses.
    const run = await runInLocal(sandbox, ['implement', '--issue', String(ISSUE)]);
    assert.notStrictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);
    const output = `${run.stdout}\n${run.stderr}`;
    assert.ok(output.includes("Validation failed for field 'approvedPlanDigest'"), output);

    assert.ok(
      !fs.existsSync(path.join(sandbox.dir, '.worktrees', String(ISSUE))),
      'a refused implement must discard the worktree it created'
    );
    const branches = execFileSync('git', ['branch', '--list', `task/${ISSUE}`], {
      cwd: sandbox.dir,
      encoding: 'utf8'
    });
    assert.strictEqual(branches.trim(), '', 'a refused implement must delete the branch it created');
    const worktreeList = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: sandbox.dir,
      encoding: 'utf8'
    });
    assert.strictEqual(
      worktreeList.split('\n').filter((line: string) => line.startsWith('worktree ')).length,
      1,
      `only the root worktree may remain:\n${worktreeList}`
    );

    const after = readApprovedPlanGateCheckpoint(sandbox);
    assert.strictEqual(after.currentStage, 'APPROVAL');
    assert.strictEqual(after.worktree, null);
    assert.strictEqual(after.approvedPlanDigest, approved.approvedPlanDigest);
  });
});
