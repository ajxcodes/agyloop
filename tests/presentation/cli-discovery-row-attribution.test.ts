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

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** A PATH shadow that mirrors every entry but omits `gh` (graceful degradation). */
function buildPathShadowWithout(shadowRoot: string, excluded: string): string {
  fs.mkdirSync(shadowRoot, { recursive: true });
  const seen = new Set<string>();
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const shadowEntries: string[] = [];
  let idx = 0;

  for (const dir of parts) {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    let entries: string[];
    try {
      entries = fs.readdirSync(real);
    } catch {
      continue;
    }

    const target = path.join(shadowRoot, `d${idx++}`);
    if (!entries.includes(excluded)) {
      try {
        fs.symlinkSync(real, target, 'dir');
        shadowEntries.push(target);
        continue;
      } catch {
        // fall through
      }
    }
    fs.mkdirSync(target, { recursive: true });
    for (const entry of entries) {
      if (entry === excluded || entry.startsWith(`${excluded}.`)) continue;
      try {
        fs.symlinkSync(fs.realpathSync(path.join(real, entry)), path.join(target, entry));
      } catch {
        // skip
      }
    }
    shadowEntries.push(target);
  }

  return shadowEntries.join(path.delimiter);
}

function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-discovery-row-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  return dir;
}

async function runIn(
  sandbox: string,
  args: string[],
  options: { home?: boolean } = {}
): Promise<{ code: any; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGY_SUBAGENT: process.env.AGY_SUBAGENT
  };
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(sandbox);
    process.env.PATH = buildPathShadowWithout(path.join(sandbox, '.shadow-bin'), 'gh');
    if (options.home !== false) {
      process.env.HOME = path.join(sandbox, '.home');
    }
    delete process.env.AGY_SUBAGENT;
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

function seedCheckpoint(
  sandbox: string,
  issue: number,
  snapshot: Record<string, unknown>
): void {
  const tasksDir = path.join(sandbox, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(tasksDir, `${issue}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        mode: 'plan',
        issue,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        pausedAtGate: null,
        pausedAtTimestamp: null,
        totalHumanWaitMs: 0,
        ...snapshot
      },
      null,
      2
    ),
    'utf8'
  );
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
  test('plan --skip-discovery names `discovery` and records SKIPPED (terminal)', async () => {
    const sandbox = makeSandbox();
    try {
      const run = await runIn(sandbox, ['plan', '--issue', '284', '--skip-discovery']);
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
    const sandbox = makeSandbox();
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
      seedCheckpoint(sandbox, 285, {
        currentStage: 'DISCOVERY',
        planDir,
        // Issue #315 (AC-14): the Discovery window is measurable on this path,
        // so it must be written. Seeded 5 minutes back to prove the value is
        // measured, not a constant.
        history: [{ stage: 'DISCOVERY', timestamp: new Date(Date.now() - 300_000).toISOString() }]
      });

      const planRun = await runIn(sandbox, ['plan', '--issue', '285']);
      assert.strictEqual(planRun.code, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${planRun.stderr}`);

      let summary = fs.readFileSync(path.join(planDir, 'CodeLoop Summary.md'), 'utf8');
      assert.match(discoveryRow(summary), /^\| 1\. Discovery \| `discovery` \| `[a-z_]+` \| COMPLETED \| 5m \d+s \|$/m);

      const approvalRun = await runIn(sandbox, ['transition', 'APPROVAL', '--issue', '285']);
      assert.strictEqual(
        approvalRun.code,
        EXIT_CODE_SUCCESS,
        `exit 0 expected, got:\n${approvalRun.stderr}`
      );

      const transitionRun = await runIn(sandbox, ['transition', 'IMPLEMENT', '--issue', '285', '--no-worktree']);
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
    const sandbox = makeSandbox();
    try {
      const planDir = path.join(sandbox, 'artifacts', 'plans', '286-probe');
      seedSummary(planDir, 'IN PROGRESS');
      seedCheckpoint(sandbox, 286, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runIn(sandbox, ['plan', '--issue', '286', '--skip-discovery']);
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
