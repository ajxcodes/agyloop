/**
 * agyloop - `--plan-path` / `--plan-dir` CLI contract (issue #267)
 *
 * T-267.B1: accepted by plan/implement/yolo, refused with an explanatory line by
 *           every other command, and a missing value is a loud error.
 * T-267.B2: a supplied plan creates NO competing plan directory and the message
 *           reflects what happened.
 * T-267.B3: a blank supplied plan is rejected and the implementer directive is
 *           never produced.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

const REAL_PLAN = [
  '# [Implementation] - supplied',
  '',
  '## 3. Implementation Steps',
  '- [ ] **Step 1:** noop'
].join('\n');

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

function planDirectories(dir: string): string[] {
  const plans = path.join(dir, 'artifacts', 'plans');
  if (!fs.existsSync(plans)) return [];
  return fs
    .readdirSync(plans, { withFileTypes: true })
    .filter((entry: any) => entry.isDirectory())
    .map((entry: any) => entry.name);
}

function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-plan-input-'));
  fs.mkdirSync(path.join(dir, 'supplied'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'supplied', 'plan.md'), REAL_PLAN, 'utf8');
  fs.writeFileSync(path.join(dir, 'supplied', 'blank.md'), '', 'utf8');
  return dir;
}

describe('--plan-path / --plan-dir CLI contract (#267)', () => {
  // #382 D4 (amended fail-closed rule): these fixtures run OFFLINE, so the
  // issue lookup fails and the kind cannot be inferred from labels. A first-run
  // `plan --issue <n>` with no --title/--type/--skip-discovery now REFUSES
  // rather than silently skipping DISCOVERY, so each fixture passes
  // `--type implementation` to exercise its stated flag.
  const PLAN_TYPE = ['--type', 'implementation'];

  test('T-267.B1: accepted by plan/implement/yolo and refused by other commands', async () => {
    const dir = makeSandbox();
    try {
      const suppliedPlan = path.join(dir, 'supplied', 'plan.md');

      const plan = await runIn(dir, ['plan', '--issue', '283', ...PLAN_TYPE, '--plan-path', suppliedPlan]);
      assert.strictEqual(plan.code, 0, `${plan.stdout}\n${plan.stderr}`);
      assert.doesNotMatch(plan.stderr, /only supported by/);
      assert.doesNotMatch(plan.stderr, /Unknown flag/);

      const implement = await runIn(dir, ['implement', '--issue', '283', '--plan-dir', path.join(dir, 'supplied')]);
      assert.doesNotMatch(implement.stderr, /only supported by/);
      assert.doesNotMatch(implement.stderr, /Unknown flag/);

      const yolo = await runIn(dir, ['yolo', '--issue', '284', '--plan-path', suppliedPlan]);
      assert.doesNotMatch(yolo.stderr, /only supported by/);
      assert.doesNotMatch(yolo.stderr, /Unknown flag/);

      for (const command of ['status', 'next', 'transition']) {
        const refused = await runIn(dir, [command, '--plan-path', suppliedPlan]);
        assert.strictEqual(refused.code, 1, `${command} must refuse --plan-path`);
        assert.match(refused.stderr, /only supported by plan\/implement\/yolo/);
        assert.doesNotMatch(refused.stderr, /Unknown flag/);
      }

      const missing = await runIn(dir, ['plan', '--plan-path']);
      assert.strictEqual(missing.code, 1);
      assert.match(missing.stderr, /without a value/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T-267.B2: a supplied plan creates no competing directory and prints the supplied path', async () => {
    const dir = makeSandbox();
    try {
      const before = planDirectories(dir).length;
      const result = await runIn(dir, [
        'plan',
        '--issue',
        '283',
        ...PLAN_TYPE,
        '--plan-path',
        path.join(dir, 'supplied', 'plan.md')
      ]);

      assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.strictEqual(planDirectories(dir).length, before, 'no plan directory may be created');
      assert.match(result.stdout, /Using supplied plan/);
      assert.doesNotMatch(result.stdout, /Initialized plan directory/);

      const persisted = JSON.parse(
        fs.readFileSync(path.join(dir, '.agyloop', 'tasks', '283.json'), 'utf8')
      );
      assert.strictEqual(persisted.currentStage, 'PLAN');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T-267.B3: a blank supplied plan is rejected and no directive is produced', async () => {
    const dir = makeSandbox();
    try {
      const result = await runIn(dir, [
        'plan',
        '--issue',
        '283',
        ...PLAN_TYPE,
        '--plan-path',
        path.join(dir, 'supplied', 'blank.md')
      ]);

      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /blank/i);
      assert.ok(result.stderr.includes('blank.md'), result.stderr);
      assert.doesNotMatch(result.stdout, /"Subagents"/, result.stdout);
      assert.doesNotMatch(result.stdout, /invoke_subagent/i, result.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Real-generator end-to-end regressions (review round 1: findings 2, 3, 4)
// ============================================================================

const { execFileSync } = require('node:child_process');

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/** Root-level entries that are NOT the tool's own bookkeeping. */
function rootArtifacts(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name: string) => !['.git', '.agyloop', '.worktrees', '.gitignore', 'artifacts'].includes(name))
    .sort();
}

describe('supplied plan end to end with the real generator (#267)', () => {
  test('finding 2/3: the supplied plan is executed and a second plan pass writes nothing outside the plan directory', async () => {
    const dir = makeSandbox();
    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 'smoke@test');
      git(dir, 'config', 'user.name', 'smoke');
      fs.writeFileSync(path.join(dir, 'README.md'), '# probe\n', 'utf8');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'chore: init');

      fs.writeFileSync(
        path.join(dir, 'myplan.md'),
        [
          '# [Implementation] - SUPPLIED_PLAN',
          '',
          '## 3. Implementation Steps',
          '- [ ] **Step 1:** Edit `src/probe.ts` (SUPPLIED_PLAN_MARKER).'
        ].join('\n'),
        'utf8'
      );

      const before = rootArtifacts(dir);

      const yolo = await runIn(dir, ['yolo', '--issue', '901', '--type', 'implementation', '--plan-path', './myplan.md']);
      assert.strictEqual(yolo.code, 0, `${yolo.stdout}\n${yolo.stderr}`);

      // The supplied plan's DIRECTORY (the repo root) must not receive scaffold
      // artifacts: [Implementation] - …, implementation_plan.md, the summary.
      const afterYolo = rootArtifacts(dir);
      assert.deepStrictEqual(afterYolo, before, 'no files may be added beside the supplied plan');
      assert.ok(!afterYolo.includes('implementation_plan.md'));
      assert.ok(!afterYolo.includes('CodeLoop Summary.md'));
      assert.ok(!afterYolo.some((name) => name.startsWith('[Implementation] - ')));

      // The documented dispatch path resolves the SUPPLIED document, not a
      // lexicographic neighbour such as README.md.
      const nextAfterYolo = JSON.parse(
        (await runIn(dir, ['next', '--issue', '901', '--json'])).stdout
      );
      assert.strictEqual(nextAfterYolo.role, 'implementer');
      assert.strictEqual(nextAfterYolo.planBlank, false);
      assert.ok(
        nextAfterYolo.invocationPayload.Subagents[0].Prompt.includes('myplan.md'),
        nextAfterYolo.invocationPayload.Subagents[0].Prompt
      );
      assert.ok(
        !nextAfterYolo.invocationPayload.Subagents[0].Prompt.includes('README.md'),
        'the implementer must never be pointed at README.md'
      );

      // A second planning pass may create the canonical plan directory, but it
      // must not write ANYTHING into the supplied plan's own directory.
      const plan = await runIn(dir, ['plan', '--issue', '901', '--title', 'second pass']);
      assert.strictEqual(plan.code, 0, `${plan.stdout}\n${plan.stderr}`);
      assert.deepStrictEqual(rootArtifacts(dir), before, 'a second plan pass must not write to the repo root');

      // The supplied plan still wins over the new blank canonical scaffold.
      const nextAfterPlan = JSON.parse(
        (await runIn(dir, ['next', '--issue', '901', '--json'])).stdout
      );
      assert.strictEqual(nextAfterPlan.currentStage, 'PLAN');
      assert.match(nextAfterPlan.description, /myplan\.md/);
      assert.match(nextAfterPlan.description, /non-blank/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finding 4: --plan-dir prints the ACTUAL target directory', async () => {
    const dir = makeSandbox();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-plan-dir-outside-'));
    try {
      const result = await runIn(dir, [
        'plan',
        '--issue',
        '906',
        '--type',
        'implementation',
        '--plan-dir',
        outside
      ]);

      assert.strictEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
      // The line names where the files really are — never a fabricated
      // `artifacts/plans/…` path that does not exist.
      assert.ok(result.stdout.includes(outside), result.stdout);
      assert.doesNotMatch(result.stdout, /Initialized plan directory: artifacts\/plans\//);
      assert.ok(fs.existsSync(path.join(outside, 'implementation_plan.md')));
      assert.ok(!fs.existsSync(path.join(dir, 'artifacts', 'plans', path.basename(outside))));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
