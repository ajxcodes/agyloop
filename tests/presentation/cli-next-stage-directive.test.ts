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

const SUBSTANTIVE_IMPLEMENTATION = [
  '# [Implementation] - probe',
  '',
  '## 1. Context & Objectives',
  '- **Feature Overview:** substantive implementation content that must never satisfy the RCA gate.',
  '- **Acceptance Criteria:** the RCA gate holds at DISCOVERY.',
  '',
  '## 2. Architectural Design & Impact',
  '- **Component Breakdown:** the gate and the directive.',
  '- **Data Flow / Model Invariants:** kind is checked before content.',
  '- **Dependencies & Imports:** domain predicates only.',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** add the discovery-shape filter before DiscoveryReport scoring.',
  '',
  '## 4. Quality Gate & Test Verification',
  '- **Target 1:** npm run lint'
].join('\n');

function taskStateFileFor(dir: string, issue: number | string): string {
  return path.join(dir, '.agyloop', 'tasks', `${issue}.json`);
}

function taskStateFile(dir: string): string {
  return taskStateFileFor(dir, ISSUE);
}

function readStateFor(dir: string, issue: number | string): any {
  try {
    return JSON.parse(fs.readFileSync(taskStateFileFor(dir, issue), 'utf8'));
  } catch {
    return null;
  }
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

  test('T-320.11: the DISCOVERY directive reports blank then populated, and never advances', async () => {
    const dir = makeSandbox();
    try {
      const transition = await runIn(dir, [
        'transition',
        'DISCOVERY',
        '--issue',
        String(ISSUE),
        '--title',
        '[Bug] probe'
      ]);
      assert.strictEqual(transition.code, 0, transition.stderr);

      const read1 = JSON.parse(
        (await runIn(dir, ['next', '--issue', String(ISSUE), '--json'])).stdout
      );
      assert.strictEqual(read1.discoveryReportPopulated, false);
      assert.ok(
        String(read1.discoveryReportPath).endsWith('[Discovery] - [Bug] probe.md'),
        `unexpected path: ${String(read1.discoveryReportPath)}`
      );
      assert.match(read1.description, /still blank/);
      assert.match(read1.description, /Missing evidence/);

      fs.writeFileSync(read1.discoveryReportPath, POPULATED_REPORT, 'utf8');

      const read2 = JSON.parse(
        (await runIn(dir, ['next', '--issue', String(ISSUE), '--json'])).stdout
      );
      assert.strictEqual(read2.discoveryReportPopulated, true);
      assert.strictEqual(read2.discoveryReportPath, read1.discoveryReportPath);
      assert.strictEqual(read2.discoveryReportMissingEvidence, null);
      assert.notStrictEqual(read2.description, read1.description);
      assert.match(read2.description, /completion condition is met/);
      assert.ok(read2.description.includes('codeloop plan --issue 41'));
      assert.doesNotMatch(read2.description, /still blank/);

      // `next` is a query: the stage must not have advanced.
      assert.strictEqual(readState(dir)?.currentStage, 'DISCOVERY');

      const plan = await runIn(dir, ['plan', '--issue', String(ISSUE)]);
      assert.strictEqual(plan.code, 0, `${plan.stdout}\n${plan.stderr}`);
      assert.strictEqual(readState(dir)?.currentStage, 'PLAN');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T-320.12: `plan` parks on a blank RCA beside a substantive implementation plan', async () => {
    const dir = makeSandbox();
    const issue = 42;
    try {
      const transition = await runIn(dir, [
        'transition',
        'DISCOVERY',
        '--issue',
        String(issue),
        '--title',
        'probe'
      ]);
      assert.strictEqual(transition.code, 0, transition.stderr);

      const plansDir = path.join(dir, 'artifacts', 'plans');
      const [planDirName] = fs.readdirSync(plansDir);
      const planDir = path.join(plansDir, planDirName);
      fs.writeFileSync(
        path.join(planDir, 'implementation_plan.md'),
        SUBSTANTIVE_IMPLEMENTATION,
        'utf8'
      );

      const plan = await runIn(dir, ['plan', '--issue', String(issue), '--title', 'feature probe']);
      const output = `${plan.stdout}\n${plan.stderr}`;
      assert.strictEqual(plan.code, 0, output);
      assert.match(output, /Parked at DISCOVERY/);
      assert.match(output, /\[Discovery\] - probe\.md/);
      assert.match(output, /Missing evidence/);
      assert.doesNotMatch(output, /Pipeline advanced to \[PLAN\]/);
      assert.strictEqual(readStateFor(dir, issue)?.currentStage, 'DISCOVERY');
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
