/**
 * agyloop - `next` at IMPLEMENT, terminal render + real worktree (issue #327)
 *
 * CB1 - `codeloop next` (NOT --json) names the advancing command and the
 *       completion condition, so an operator reading the terminal can act.
 * CB2 - in a REAL git worktree the same checkpoint flips absent -> present; the
 *       met condition is `advance` (no payload, no write), so the recorded
 *       re-dispatch stays where the clean read left it (issue #337)
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 327;

const REAL_PLAN = [
  '# [Implementation] - boundary probe',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** name the advancing command'
].join('\n');

const ADVANCE = `codeloop transition QUALITY_GATE --issue ${ISSUE}`;
const CONDITION = 'This stage ends when an implementation diff exists in the task worktree.';

async function runIn(dir: string, args: readonly string[]): Promise<any> {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(dir);
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function git(dir: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/** A real repository whose task worktree is a real linked git worktree. */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-implement-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test']);
  git(dir, ['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-qm', 'chore: base']);

  const worktreePath = path.join(dir, '.worktrees', String(ISSUE));
  git(dir, ['worktree', 'add', '-q', '-b', `task/${ISSUE}-boundary`, worktreePath, 'main']);

  const planDir = path.join(dir, 'artifacts', 'plans', `${ISSUE}-task`);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, 'implementation_plan.md'), REAL_PLAN, 'utf8');

  const now = new Date().toISOString();
  fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: 'IMPLEMENT',
        mode: 'standard',
        issue: ISSUE,
        planDir,
        baseBranch: 'main',
        worktree: {
          taskId: String(ISSUE),
          worktreePath,
          branch: `task/${ISSUE}-boundary`,
          baseBranch: 'main',
          isIsolated: true
        },
        createdAt: now,
        updatedAt: now,
        history: [{ stage: 'IMPLEMENT', timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0
      },
      null,
      2
    ),
    'utf8'
  );

  return { dir, worktreePath, checkpointPath: path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`) };
}

function readCheckpoint(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Adds one untracked source file to the task worktree. */
function implementInWorktree(worktreePath: string): void {
  fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, 'src', 'probe.ts'), 'export const probe = 1;\n', 'utf8');
}

describe('codeloop next at IMPLEMENT (issue #327)', () => {
  test('CB1/CB2: terminal render names the command; a real diff flips the condition and the count', async () => {
    const sandbox = makeSandbox();
    try {
      // --- clean worktree -------------------------------------------------
      const cleanJson = await runIn(sandbox.dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(cleanJson.code, 0, cleanJson.stderr);
      const clean = JSON.parse(cleanJson.stdout);

      assert.strictEqual(clean.role, 'implementer');
      assert.strictEqual(clean.implementationPresent, false);
      assert.ok(`${clean.description}\n${clean.humanSummary}`.includes(ADVANCE));
      assert.ok(`${clean.description}\n${clean.humanSummary}`.includes(CONDITION));
      assert.strictEqual(readCheckpoint(sandbox.checkpointPath).implementationDispatchCount, 1);
      assert.strictEqual(readCheckpoint(sandbox.checkpointPath).currentStage, 'IMPLEMENT');

      // CB1: the TERMINAL render (no --json) carries the same instruction.
      const terminal = await runIn(sandbox.dir, ['next', '--issue', String(ISSUE)]);
      assert.strictEqual(terminal.code, 0, terminal.stderr);
      assert.ok(
        terminal.stdout.includes('Description   :'),
        `the terminal render prints the directive, got:\n${terminal.stdout}`
      );
      assert.ok(terminal.stdout.includes(ADVANCE), `the terminal must name the command:\n${terminal.stdout}`);
      assert.ok(terminal.stdout.includes(CONDITION), `the terminal must name the condition:\n${terminal.stdout}`);
      assert.ok(
        terminal.stdout.includes('Implementation not present:'),
        `the terminal must report the state:\n${terminal.stdout}`
      );
      assert.ok(terminal.stdout.includes('Implementer dispatch 2 for this stage.'), terminal.stdout);

      // --- implemented worktree -------------------------------------------
      implementInWorktree(sandbox.worktreePath);

      const presentJson = await runIn(sandbox.dir, ['next', '--issue', String(ISSUE), '--json']);
      assert.strictEqual(presentJson.code, 0, presentJson.stderr);
      const present = JSON.parse(presentJson.stdout);
      const text = `${present.description}\n${present.humanSummary}`;

      // Issue #337: a present diff with no pending remediation is the met
      // completion condition — nothing to dispatch, nothing to write.
      assert.strictEqual(present.implementationPresent, true);
      assert.strictEqual(present.actionType, 'advance');
      assert.strictEqual(present.actionable, false);
      assert.strictEqual('invocationPayload' in present, false);
      assert.strictEqual('role' in present, false);
      assert.ok(text.includes(ADVANCE), text);
      assert.ok(text.includes(CONDITION), text);
      assert.ok(text.includes('Implementation present:'), text);
      assert.ok(text.includes('do not re-dispatch the implementer'), text);
      // The clean read left the counter at 2; the met read must not move it.
      assert.strictEqual(present.implementationDispatchCount, 2);

      const checkpoint = readCheckpoint(sandbox.checkpointPath);
      assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT', 'next never advances a stage');
      assert.strictEqual(checkpoint.implementationDispatchCount, 2);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
