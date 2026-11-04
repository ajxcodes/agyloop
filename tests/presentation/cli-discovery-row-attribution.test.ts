/** The canonical task seed (plan mode) with this suite's merged snapshot shape. */
function seedPlanModeCheckpoint(sandbox: string, issue: number, snapshot: Record<string, unknown>): void {
  const now = new Date().toISOString();
  seedTask(sandbox, {
    mode: 'plan',
    ...snapshot,
    issue,
    createdAt: now,
    updatedAt: now
  });
}

/**
 * agyloop - The Discovery row names the discovery subagent and is terminal
 * (issue #284, AC4; #264 stall regression)
 *
 * The defect: the row was written from the PLANNER's descriptor (so it claimed
 * `planner` / `pro`), and it could stay `IN PROGRESS` on a completed task.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS } = require('../../dist/domain');
const { makeSandbox } = require('../helpers/sandbox.ts');
const { buildCritiqueFreePathShadow, buildPathShadowWithout, checkpointLine } = require('../helpers/render.ts');
const { seedTask, seedCheckpoint, seedRootState, seedCorruptTask, checkpointPath } = require('../helpers/state-seed.ts');
const { runCliInSandbox: runCliInSandboxCanonical } = require('../helpers/cli-harness.ts');

function makeDiscoveryRowSandbox(): string {
  return makeSandbox({
    prefix: 'agyloop-discovery-row-',
    dirName: '',
    gitignore: false,
    seed: (d: string) => {
      fs.writeFileSync(path.join(d, 'README.md'), 'probe\n', 'utf8');
      fs.mkdirSync(path.join(d, '.home'), { recursive: true });
    },
    initialCommit: 'chore: probe init'
  }).dir;
}



const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** A PATH shadow that mirrors every entry but omits `gh` (graceful degradation). */



/** The canonical harness run with this suite's gh-shadowed PATH (and HOME sandbox). */
async function runInLocal(
  sandbox: string,
  args: string[],
  options: { home?: boolean } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    PATH: buildPathShadowWithout(path.join(sandbox, '.shadow-bin'), 'gh'),
    AGY_SUBAGENT: undefined
  };
  if (options.home !== false) {
    env.HOME = path.join(sandbox, '.home');
  }
  const result = await runCliInSandboxCanonical(args, { dir: sandbox, env });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}


function findSummary(dir: string): string | null {
  const plansDir = path.join(dir, 'artifacts', 'plans');
  if (!fs.existsSync(plansDir)) return null;
  for (const entry of fs.readdirSync(plansDir)) {
    const candidate = path.join(plansDir, entry, 'CodeLoop Summary.md');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function discoveryRow(summary: string): string {
  const line = summary.split('\n').find((candidate) => candidate.startsWith('| 1. Discovery |'));
  assert.ok(line, `the summary must contain the Discovery row, got:\n${summary}`);
  return line as string;
}


function seedSummary(planDir: string, discoveryStatus: string): string {
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, 'implementation_plan.md'),
    '# [Implementation] - Probe\n\n- [ ] Step 1\n',
    'utf8'
  );
  const summaryPath = path.join(planDir, 'CodeLoop Summary.md');
  fs.copyFileSync(path.join(REPO_ROOT, 'templates', 'summary-log.md'), summaryPath);
  const content = fs
    .readFileSync(summaryPath, 'utf8')
    .replace(
      /^\| 1\. Discovery \|.*$/m,
      `| 1. Discovery | \`planner\` | \`pro\` | ${discoveryStatus} | - |`
    );
  fs.writeFileSync(summaryPath, content, 'utf8');
  return summaryPath;
}

describe('Discovery row attribution (issue #284, AC4)', () => {
  // T13.4 (#339 AC-5.2 regression): the `--skip-discovery` row keeps its
  // audited shape — `discovery | model | SKIPPED` — unchanged by the E6 rule
  // (which only rewrites rows for runs that performed no RCA without the flag).
  test('plan --skip-discovery names `discovery` and records SKIPPED (terminal)', async () => {
    const sandbox = makeDiscoveryRowSandbox();
    try {
      const run = await runInLocal(sandbox, ['plan', '--issue', '284', '--skip-discovery']);
      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${run.stderr}`);

      const summaryPath = findSummary(sandbox);
      assert.ok(summaryPath, `a summary must be scaffolded, got:\n${run.stdout}`);
      const summary = fs.readFileSync(summaryPath, 'utf8');

      // A fresh INITIALIZED run with --skip-discovery never enters DISCOVERY, so
      // its window is genuinely unmeasurable: `-` is the truth (#315, AC-14).
      assert.match(discoveryRow(summary), /^\| 1\. Discovery \| `discovery` \| `[a-z_]+` \| SKIPPED \| - \|$/m);
      assert.ok(!discoveryRow(summary).includes('planner'), `must never name the planner:\n${summary}`);
      assert.ok(!discoveryRow(summary).includes('IN PROGRESS'), `must be terminal:\n${summary}`);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('a populated RCA re-entry records COMPLETED, still names `discovery`, and survives a later transition', async () => {
    const sandbox = makeDiscoveryRowSandbox();
    try {
      const planDir = path.join(sandbox, 'artifacts', 'plans', '285-probe');
      seedSummary(planDir, 'IN PROGRESS');
      fs.writeFileSync(
        path.join(planDir, '[Discovery] - Probe.md'),
        [
          '# [Discovery] - Probe',
          '',
          '## 1. Problem Statement & Symptoms',
          '- **Observed Behavior:** The discovery row is attributed to the planner and can stall in progress.',
          '- **Expected Behavior:** The row names the discovery subagent and reaches a terminal status.',
          '- **Affected Components / Paths:** `src/application/start-planning.ts`, `templates/summary-log.md`.',
          '',
          '## 2. Root Cause Analysis (RCA)',
          '- **Investigation Steps:** Re-read the four Discovery-row writes and the template that ships COMPLETED.',
          '- **Identified Failure Mode:** The row is written from `plannerDef`, and the completion guard is skipped entirely.',
          '- **Relevant Code References:** `start-planning.ts:376`, `start-planning.ts:384`, `start-planning.ts:400`.',
          '',
          '## 3. Reproduction Steps & Verification Protocol',
          '- **Local Reproduction Command:** `codeloop plan --issue 285 --skip-discovery`',
          '- **Failing Test Target:** `tests/presentation/cli-discovery-row-attribution.test.ts`',
          '',
          '## 4. Remediation Strategy',
          '- **Recommended Fix Approach:** resolve the discovery descriptor and write a terminal status on advance.',
          '- **Potential Regressions / Side Effects:** a scraped `planner` cell changes to `discovery`.'
        ].join('\n'),
        'utf8'
      );
      seedPlanModeCheckpoint(sandbox, 285, {
        currentStage: 'DISCOVERY',
        planDir,
        // Issue #315 (AC-14): the Discovery window is measurable on this path,
        // so it must be written. Seeded 5 minutes back to prove the value is
        // measured, not a constant.
        history: [{ stage: 'DISCOVERY', timestamp: new Date(Date.now() - 300_000).toISOString() }]
      });

      const planRun = await runInLocal(sandbox, ['plan', '--issue', '285']);
      assert.strictEqual(planRun.code, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${planRun.stderr}`);

      let summary = fs.readFileSync(path.join(planDir, 'CodeLoop Summary.md'), 'utf8');
      assert.match(discoveryRow(summary), /^\| 1\. Discovery \| `discovery` \| `[a-z_]+` \| COMPLETED \| 5m \d+s \|$/m);

      const approvalRun = await runInLocal(sandbox, ['transition', 'APPROVAL', '--issue', '285']);
      assert.strictEqual(
        approvalRun.code,
        EXIT_CODE_SUCCESS,
        `exit 0 expected, got:\n${approvalRun.stderr}`
      );

      const transitionRun = await runInLocal(sandbox, ['transition', 'IMPLEMENT', '--issue', '285', '--no-worktree']);
      assert.strictEqual(
        transitionRun.code,
        EXIT_CODE_SUCCESS,
        `exit 0 expected, got:\n${transitionRun.stderr}`
      );

      summary = fs.readFileSync(path.join(planDir, 'CodeLoop Summary.md'), 'utf8');
      assert.match(discoveryRow(summary), /^\| 1\. Discovery \| `discovery` \| `[a-z_]+` \| COMPLETED \| 5m \d+s \|$/m);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('a checkpoint stalled with an IN PROGRESS Discovery row is advanced, not left stalled (#264)', async () => {
    const sandbox = makeDiscoveryRowSandbox();
    try {
      const planDir = path.join(sandbox, 'artifacts', 'plans', '286-probe');
      seedSummary(planDir, 'IN PROGRESS');
      seedPlanModeCheckpoint(sandbox, 286, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runInLocal(sandbox, ['plan', '--issue', '286', '--skip-discovery']);
      assert.strictEqual(run.code, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${run.stderr}`);

      const summary = fs.readFileSync(path.join(planDir, 'CodeLoop Summary.md'), 'utf8');
      assert.ok(
        !discoveryRow(summary).includes('IN PROGRESS'),
        `the stalled row must not survive the advance, got:\n${summary}`
      );
      assert.match(discoveryRow(summary), /SKIPPED/);
      // Issue #315 (AC-14): the `--skip-discovery` advance path still writes the
      // measured Discovery duration — the row is left terminal AND truthful.
      assert.match(
        discoveryRow(summary),
        /^\| 1\. Discovery \| `discovery` \| `[a-z_]+` \| SKIPPED \| \d+s \|$/m
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
