/**
 * agyloop - `--workspace` rebinds the WHOLE run, at every lifecycle entry point (#425)
 *
 * The defect: `--workspace` rebound the checkpoint (`FileStateRepository` got
 * `workspaceDir`), but every lifecycle entry point called
 * `RunLifecycleUseCase.execute({ … })` WITHOUT `workspaceDir`, so `execute()`
 * fell back to `process.cwd()`. The checkpoint was read from the workspace while
 * the worktree, the baseline measurement and the branch were created in whatever
 * directory the operator happened to be in.
 *
 * Each case drives the real CLI against real git sandboxes, not a mock — only
 * the real command surfaces can pin "which repository did this command write to".
 *
 *   WS-1  two-repo `implement` provisions under `--workspace`, never in the cwd
 *   WS-2  `plan --workspace` scaffolds under the workspace
 *   WS-3  the bare default command scaffolds under the workspace
 *   WS-4  a non-git invocation cwd is ignored and stays empty
 *   WS-5  a non-git *workspace* is refused before anything is written
 *   WS-6  every lifecycle call site threads the workspace
 *   WS-7  the flag is documented truthfully
 *   WS-8  a bare workspace is refused before any write (#428)
 *   WS-9  a plain non-git workspace is refused before state init (#428)
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli, printHelp } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 425;
const TASK = String(ISSUE);

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const PLAN_CONTENT = [
  '# [Implementation] - workspace scope probe',
  '',
  '## 3. Implementation Steps',
  '',
  '- [ ] **Step 1:** no-op',
  '',
  '### Quality Gate Targets',
  '',
  '```bash',
  'node -e "process.exit(0)"',
  '```',
  '',
  '### Manual Smoke Test Protocol',
  '',
  '```bash',
  "node -e 'process.exit(0)'",
  '```',
  '',
  '### Baseline Evidence',
  '',
  '#### BL-1',
  '',
  '- **Declared:** 0',
  "- **Command:** `node -e 'console.log(0)'`",
  '- **Output:** 0',
  ''
].join('\n');

/** A real git repository (branch `main`) with one commit. */
function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'chore: seed'], { cwd: dir });
}

/** Writes an implementable plan under `<workspace>/artifacts/plans/425-task/`. */
function writeImplementablePlan(workspace: string): string {
  const planDir = path.join(workspace, 'artifacts', 'plans', `${TASK}-task`);
  fs.mkdirSync(planDir, { recursive: true });
  const planPath = path.join(planDir, 'implementation_plan.md');
  fs.writeFileSync(planPath, PLAN_CONTENT, 'utf8');
  return planPath;
}

/** Seeds `.agyloop/tasks/425.json` at the APPROVAL gate inside `workspace`. */
function seedApprovedCheckpoint(workspace: string, planDir: string | null): string {
  const stateFile = path.join(workspace, '.agyloop', 'tasks', `${TASK}.json`);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const now = '2026-11-01T00:00:00.000Z';
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'APPROVAL',
        mode: 'implement',
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
        history: [{ stage: 'APPROVAL', timestamp: now }],
        pausedAtGate: 'APPROVAL',
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  return stateFile;
}

/** A `gh` stub: PR listings are empty, everything else fails (non-blocking). */
function ghStub(dir: string): string {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const gh = path.join(binDir, 'gh');
  fs.writeFileSync(
    gh,
    ['#!/bin/sh', 'case "$*" in', '  *"pr list"*) echo \'[]\' ;;', '  *) exit 1 ;;', 'esac', ''].join(
      '\n'
    ),
    'utf8'
  );
  fs.chmodSync(gh, 0o755);
  return binDir;
}

/**
 * Runs `runCli` from `cwd` with a stubbed `gh` on PATH and no AGY_SUBAGENT
 * marker (the subagent guard would mask the behaviour under test).
 */
async function runIn(cwd: string, args: string[], binDir: string): Promise<CliRun> {
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalPath = process.env.PATH;
  const originalSubagent = process.env.AGY_SUBAGENT;

  let stdout = '';
  let stderr = '';

  try {
    process.chdir(cwd);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
    delete process.env.AGY_SUBAGENT;

    console.log = (...argsOut: unknown[]) => {
      stdout += argsOut.map(String).join(' ') + '\n';
    };
    console.error = (...argsOut: unknown[]) => {
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

function readCheckpoint(stateFile: string): any {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function gitBranches(repo: string): string {
  return execFileSync('git', ['branch', '--format=%(refname:short)'], {
    cwd: repo,
    encoding: 'utf8'
  });
}

function gitStatus(repo: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
}

describe('`--workspace` scoping of lifecycle entry points (#425)', () => {
  let sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    sandboxes = [];
  });

  function sandbox(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-workspace-scoping-'));
    sandboxes.push(dir);
    return dir;
  }

  test('WS-1: a two-repo `implement` provisions under --workspace and nowhere else', async () => {
    const base = sandbox();
    const ws = path.join(base, 'ws');
    const other = path.join(base, 'other');
    makeRepo(ws);
    makeRepo(other);

    const planPath = writeImplementablePlan(ws);
    const stateFile = seedApprovedCheckpoint(ws, path.dirname(planPath));
    execFileSync('git', ['add', '-A'], { cwd: ws });
    execFileSync('git', ['commit', '-qm', 'chore: seed approved checkpoint'], { cwd: ws });

    const otherStatusBefore = gitStatus(other);
    const binDir = ghStub(base);

    const run = await runIn(other, ['implement', '--issue', TASK, '--workspace', ws], binDir);
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    assert.ok(
      fs.existsSync(path.join(ws, '.worktrees', TASK)),
      'the worktree must land under --workspace'
    );
    assert.match(
      gitBranches(ws),
      new RegExp(`^(task|fix)/${TASK}$`, 'm'),
      'the task branch must live in --workspace'
    );

    assert.ok(!fs.existsSync(path.join(other, '.worktrees')), 'nothing may be provisioned in the invocation cwd');
    assert.ok(!fs.existsSync(path.join(other, 'artifacts')), 'the invocation cwd must not receive plan artifacts');
    assert.doesNotMatch(gitBranches(other), new RegExp(`^(task|fix)/${TASK}$`, 'm'), 'no task branch in the invocation cwd');
    assert.strictEqual(gitStatus(other), otherStatusBefore, 'the invocation cwd must be untouched');

    const checkpoint = readCheckpoint(stateFile);
    assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT', 'the checkpoint must reach IMPLEMENT');
    assert.ok(checkpoint.worktree, 'the checkpoint must record the provisioned worktree');
    assert.strictEqual(
      path.resolve(checkpoint.worktree.worktreePath),
      path.resolve(ws, '.worktrees', TASK),
      'the recorded worktree must live under --workspace'
    );
  });

  test('WS-2: `plan --workspace` scaffolds under the workspace, not the invocation cwd', async () => {
    const base = sandbox();
    const ws = path.join(base, 'ws');
    const other = path.join(base, 'other');
    makeRepo(ws);
    makeRepo(other);

    const otherStatusBefore = gitStatus(other);
    const binDir = ghStub(base);

    const run = await runIn(
      other,
      [
        'plan',
        '--issue',
        TASK,
        '--workspace',
        ws,
        '--title',
        'Workspace scope probe',
        '--type',
        'implementation',
        '--skip-discovery'
      ],
      binDir
    );
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    const plansDir = path.join(ws, 'artifacts', 'plans');
    assert.ok(fs.existsSync(plansDir), 'the plan directory must be scaffolded under --workspace');
    assert.ok(
      fs.readdirSync(plansDir).some((name: string) => name.startsWith(`${TASK}-`)),
      `the plan folder must be named for issue ${TASK} under --workspace`
    );

    assert.ok(!fs.existsSync(path.join(other, 'artifacts')), 'the invocation cwd must not receive plan artifacts');
    assert.ok(!fs.existsSync(path.join(other, '.agyloop')), 'the invocation cwd must not receive a checkpoint');
    assert.ok(
      fs.existsSync(path.join(ws, '.agyloop', 'tasks', `${TASK}.json`)),
      'the checkpoint must be written under --workspace'
    );
    assert.strictEqual(gitStatus(other), otherStatusBefore, 'the invocation cwd must be untouched');
  });

  test('WS-3: the bare default command scaffolds under the workspace', async () => {
    const base = sandbox();
    const ws = path.join(base, 'ws');
    const other = path.join(base, 'other');
    makeRepo(ws);
    makeRepo(other);

    const otherStatusBefore = gitStatus(other);
    const binDir = ghStub(base);

    const run = await runIn(
      other,
      [
        '--issue',
        TASK,
        '--workspace',
        ws,
        '--title',
        'Workspace scope probe',
        '--type',
        'implementation',
        '--skip-discovery'
      ],
      binDir
    );
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    const plansDir = path.join(ws, 'artifacts', 'plans');
    assert.ok(fs.existsSync(plansDir), 'the plan directory must be scaffolded under --workspace');
    assert.ok(
      fs.readdirSync(plansDir).some((name: string) => name.startsWith(`${TASK}-`)),
      `the plan folder must be named for issue ${TASK} under --workspace`
    );

    assert.ok(!fs.existsSync(path.join(other, 'artifacts')), 'the invocation cwd must not receive plan artifacts');
    assert.ok(!fs.existsSync(path.join(other, '.agyloop')), 'the invocation cwd must not receive a checkpoint');
    assert.ok(
      fs.existsSync(path.join(ws, '.agyloop', 'tasks', `${TASK}.json`)),
      'the checkpoint must be written under --workspace'
    );
    assert.strictEqual(gitStatus(other), otherStatusBefore, 'the invocation cwd must be untouched');
  });

  test('WS-4: a non-git invocation cwd is ignored and stays empty', async () => {
    const base = sandbox();
    const ws = path.join(base, 'ws');
    const nowhere = path.join(base, 'nowhere');
    makeRepo(ws);
    fs.mkdirSync(nowhere, { recursive: true });

    const planPath = writeImplementablePlan(ws);
    const stateFile = seedApprovedCheckpoint(ws, path.dirname(planPath));
    execFileSync('git', ['add', '-A'], { cwd: ws });
    execFileSync('git', ['commit', '-qm', 'chore: seed approved checkpoint'], { cwd: ws });

    const binDir = ghStub(base);

    const run = await runIn(nowhere, ['implement', '--issue', TASK, '--workspace', ws], binDir);
    assert.strictEqual(run.code, 0, `${run.stdout}\n${run.stderr}`);

    assert.ok(
      fs.existsSync(path.join(ws, '.worktrees', TASK)),
      'the worktree must land under --workspace'
    );
    assert.ok(!fs.existsSync(path.join(nowhere, '.worktrees')), 'the non-git cwd must not be littered with .worktrees');
    assert.ok(!fs.existsSync(path.join(nowhere, '.gitignore')), 'the non-git cwd must not receive a .gitignore');
    assert.deepStrictEqual(fs.readdirSync(nowhere), [], 'the non-git cwd must stay empty');

    assert.strictEqual(readCheckpoint(stateFile).currentStage, 'IMPLEMENT');
  });

  test('WS-5: a non-git workspace is refused before anything is written', async () => {
    const base = sandbox();
    const other = path.join(base, 'other');
    const plain = path.join(base, 'plain');
    makeRepo(other);
    fs.mkdirSync(plain, { recursive: true });
    seedApprovedCheckpoint(plain, null);

    const otherStatusBefore = gitStatus(other);
    const binDir = ghStub(base);

    const run = await runIn(other, ['implement', '--issue', TASK, '--workspace', plain], binDir);
    assert.notStrictEqual(run.code, 0, `a non-git workspace must be refused: ${run.stdout}\n${run.stderr}`);

    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /not inside a git work tree|not a git repository/i);
    assert.ok(output.includes(plain), `the refusal must name the workspace:\n${output}`);

    assert.ok(!fs.existsSync(path.join(plain, '.worktrees')), 'a refused provisioning must not leave .worktrees');
    assert.ok(!fs.existsSync(path.join(plain, '.gitignore')), 'a refused provisioning must not write .gitignore');
    assert.ok(!fs.existsSync(path.join(other, '.worktrees')), 'the invocation cwd must not be provisioned');
    assert.strictEqual(gitStatus(other), otherStatusBefore, 'the invocation cwd must be untouched');
  });

  test('WS-8: a bare workspace is refused, names the real reason, and receives no write (AC1, AC2)', async () => {
    const base = sandbox();
    const bare = path.join(base, 'bare');
    const other = path.join(base, 'other');
    fs.mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
    makeRepo(other);

    const stateFile = seedApprovedCheckpoint(bare, null);
    const checkpointBefore = fs.readFileSync(stateFile);
    const otherStatusBefore = gitStatus(other);
    const binDir = ghStub(base);

    const run = await runIn(other, ['implement', '--issue', TASK, '--workspace', bare], binDir);
    assert.notStrictEqual(run.code, 0, `a bare workspace must be refused: ${run.stdout}\n${run.stderr}`);

    const output = `${run.stdout}\n${run.stderr}`;
    assert.ok(output.includes(bare), `the refusal must name the bare workspace:\n${output}`);
    assert.match(output, /bare repository, not a work tree/);
    assert.ok(output.includes('--no-worktree'), `the refusal must keep the --no-worktree remedy:\n${output}`);
    assert.doesNotMatch(output, /invalid reference/, 'the late git error must not surface');

    assert.ok(!fs.existsSync(path.join(bare, '.gitignore')), 'a refused bare workspace must not receive .gitignore');
    assert.ok(!fs.existsSync(path.join(bare, '.worktrees')), 'a refused bare workspace must not receive .worktrees');
    assert.deepStrictEqual(
      fs.readFileSync(stateFile),
      checkpointBefore,
      'the refused run must keep the checkpoint byte-identical'
    );
    assert.strictEqual(gitStatus(other), otherStatusBefore, 'the invocation cwd must be untouched');
  });

  test('WS-9: a plain non-git workspace with no checkpoint is refused before state initialization (AC5)', async () => {
    const base = sandbox();
    const plain = path.join(base, 'plain');
    const other = path.join(base, 'other');
    makeRepo(other);
    fs.mkdirSync(plain, { recursive: true });

    const binDir = ghStub(base);
    const run = await runIn(other, ['implement', '--issue', TASK, '--workspace', plain], binDir);
    assert.notStrictEqual(run.code, 0, `a plain non-git workspace must be refused: ${run.stdout}\n${run.stderr}`);

    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /not inside a git work tree/);
    assert.ok(output.includes(plain), `the refusal must name the plain workspace:\n${output}`);
    assert.deepStrictEqual(
      fs.readdirSync(plain),
      [],
      'a refused workspace must receive no .agyloop, .gitignore or .worktrees'
    );
  });

  test('WS-6: every lifecycle call site threads the workspace', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'presentation', 'cli.ts'),
      'utf8'
    );

    const blocks = source.split('makeLifecycleUseCase(scope.repo).execute({').slice(1);
    assert.strictEqual(blocks.length, 4, 'expected four lifecycle call sites (plan, implement, yolo, default)');

    for (const block of blocks) {
      const call = block.split('\n        });')[0];
      assert.match(
        call,
        /workspaceDir:/,
        `every lifecycle call site must thread the workspace:\n${call.slice(0, 240)}`
      );
      assert.doesNotMatch(
        call,
        /workspaceDir:\s*process\.cwd\(\)/,
        'a call site must never pin the provisioning root to the process cwd'
      );
    }
  });

  test('WS-7: the flag is documented truthfully', () => {
    const originalLog = console.log;
    let help = '';
    try {
      console.log = (...argsOut: unknown[]) => {
        help += argsOut.map(String).join(' ') + '\n';
      };
      printHelp();
    } finally {
      console.log = originalLog;
    }

    const line = help
      .split('\n')
      .find((candidate: string) => candidate.trimStart().startsWith('--workspace'));
    assert.ok(line, 'the help must document --workspace');
    assert.match(line as string, /checkpoint/i, 'the flag must say it rebinds the checkpoint');
    assert.match(line as string, /repositor|worktree/i, 'the flag must say it rebinds the repository/worktree');

    assert.ok(
      help.includes(
        '      --dry-run      Simulate execution without modifying state (mutating commands only; read-only commands refuse it — see the command table above)'
      ),
      'the --dry-run help line must be unchanged'
    );
  });
});
