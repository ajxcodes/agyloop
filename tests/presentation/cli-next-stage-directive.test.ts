/**
 * agyloop - `next` stage directives (issues #292, #267)
 *
 * T-292.1/.2/.4: the terminal render names the ADVANCING command and the
 *                completion condition at DISCOVERY and PLAN.
 * T-267.A1/A2: at IMPLEMENT with a blank plan, `next` offers the PLANNER; once
 *              the plan is real it offers the implementer.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const ISSUE = 41;

const POPULATED_REPORT = [
  '# [Discovery] - probe',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:** next never named the advancing command',
  '- **Expected Behavior:** the directive names it',
  '- **Affected Components / Paths:** src/application/get-next-action.ts',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:** read the directive',
  '- **Identified Failure Mode:** static descriptions',
  '- **Relevant Code References:** get-next-action.ts',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '- **Local Reproduction Command:** codeloop next --issue 41',
  '- **Failing Test Target:** tests/application/get-next-action.test.ts',
  '',
  '## 4. Remediation Strategy',
  '- **Recommended Fix Approach:** name the command and the condition',
  '- **Potential Regressions / Side Effects:** none'
].join('\n');

const REAL_PLAN = [
  '# [Implementation] - probe',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** do the probe'
].join('\n');

function taskStateFile(dir: string): string {
  return path.join(dir, '.agyloop', 'tasks', `${ISSUE}.json`);
}

function readState(dir: string): any {
  try {
    return JSON.parse(fs.readFileSync(taskStateFile(dir), 'utf8'));
  } catch {
    return null;
  }
}

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
    return {
      code,
      stdout: stdout.replace(ANSI_ESCAPE, ''),
      stderr: stderr.replace(ANSI_ESCAPE, '')
    };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function makeSandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-next-directive-'));
}

describe('codeloop next stage directives (#292, #267)', () => {
  test('T-292.4: the terminal DISCOVERY directive names codeloop plan and the condition', async () => {
    const dir = makeSandbox();
    try {
      const transition = await runIn(dir, ['transition', 'DISCOVERY', '--issue', String(ISSUE), '--title', '[Bug] probe']);
      assert.strictEqual(transition.code, 0, transition.stderr);

      const result = await runIn(dir, ['next', '--issue', String(ISSUE)]);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.match(result.stdout, /codeloop plan --issue 41/);
      assert.match(result.stdout, /populated RCA report/);
      assert.strictEqual(readState(dir)?.discoveryDispatchCount, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T-292.2/.4: the terminal PLAN directive names transition APPROVAL and the condition', async () => {
    const dir = makeSandbox();
    try {
      await runIn(dir, ['transition', 'DISCOVERY', '--issue', String(ISSUE), '--title', '[Bug] probe']);
      const plansDir = path.join(dir, 'artifacts', 'plans');
      const [planDirName] = fs.readdirSync(plansDir);
      const planDir = path.join(plansDir, planDirName);
      const report = fs.readdirSync(planDir).find((f: string) => f.startsWith('[Discovery] - '));
      fs.writeFileSync(path.join(planDir, report), POPULATED_REPORT, 'utf8');

      const plan = await runIn(dir, ['plan', '--issue', String(ISSUE), '--title', '[Bug] probe']);
      assert.strictEqual(plan.code, 0, `${plan.stdout}\n${plan.stderr}`);
      assert.strictEqual(readState(dir)?.currentStage, 'PLAN');

      const result = await runIn(dir, ['next', '--issue', String(ISSUE)]);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.match(result.stdout, /codeloop transition APPROVAL --issue 41/);
      assert.match(result.stdout, /plan file is non-blank/);
      assert.match(result.stdout, /implementation_plan\.md/);
      assert.strictEqual(readState(dir)?.planDispatchCount, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T-267.A1/A2: a blank plan at IMPLEMENT offers the planner, then the implementer', async () => {
    const dir = makeSandbox();
    try {
      // Seed a blank implementation plan and an IMPLEMENT checkpoint.
      const planDir = path.join(dir, 'artifacts', 'plans', '41-bug-probe');
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, 'implementation_plan.md'),
        '# [Implementation] - probe\n\n## 3. Implementation Steps\n- [ ] **Step 1:**\n',
        'utf8'
      );
      fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        taskStateFile(dir),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'IMPLEMENT',
          mode: 'standard',
          issue: ISSUE,
          planDir,
          baseBranch: 'main',
          worktree: {
            taskId: '41',
            worktreePath: path.join(dir, '.worktrees', '41'),
            branch: 'task/41',
            baseBranch: 'main'
          },
          createdAt: now,
          updatedAt: now,
          history: [{ stage: 'IMPLEMENT', timestamp: now }]
        }),
        'utf8'
      );

      const planner = JSON.parse(
        (await runIn(dir, ['next', '--issue', String(ISSUE), '--json'])).stdout
      );
      assert.strictEqual(planner.role, 'planner');
      assert.strictEqual(planner.nextStage, 'PLAN');
      assert.strictEqual(planner.planBlank, true);
      assert.strictEqual(readState(dir)?.currentStage, 'IMPLEMENT', 'next never advances');

      fs.writeFileSync(path.join(planDir, 'implementation_plan.md'), REAL_PLAN, 'utf8');

      const implementer = JSON.parse(
        (await runIn(dir, ['next', '--issue', String(ISSUE), '--json'])).stdout
      );
      assert.strictEqual(implementer.role, 'implementer');
      assert.strictEqual(implementer.planBlank, false);
      assert.strictEqual(readState(dir)?.currentStage, 'IMPLEMENT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finding 5: `status` surfaces the three new counters through their labels', async () => {
    const dir = makeSandbox();
    try {
      fs.mkdirSync(path.join(dir, '.agyloop', 'tasks'), { recursive: true });
      const now = new Date().toISOString();
      fs.writeFileSync(
        taskStateFile(dir),
        JSON.stringify({
          version: '1.0.0',
          currentStage: 'DISCOVERY',
          mode: 'standard',
          issue: ISSUE,
          baseBranch: 'main',
          createdAt: now,
          updatedAt: now,
          history: [{ stage: 'DISCOVERY', timestamp: now }],
          discoveryDispatchCount: 3,
          planDispatchCount: 2,
          planEmptyParkCount: 1
        }),
        'utf8'
      );

      const result = await runIn(dir, ['status', '--issue', String(ISSUE)]);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.match(result.stdout, /Discovery Dispatches : 3/);
      assert.match(result.stdout, /Planner Dispatches : 2/);
      assert.match(result.stdout, /Blank-Plan Parks : 1/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
