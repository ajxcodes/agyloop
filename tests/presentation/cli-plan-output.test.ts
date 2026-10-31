/**
 * agyloop - `plan` output names what actually happened (issue #339, items 1/2/3
 * + audit extras E1/E4)
 *
 * T1.1  `--skip-discovery` never names the Discovery subagent (the attribution
 *       block is omitted), while advancing to PLAN.
 * T1.2  an advance out of a populated DISCOVERY note names NO subagent (issue
 *       #400, D1: the block advertises the NEXT dispatch, and the planner is
 *       what `next` dispatches after the advance).
 * T1.3  (control) a blank report park still prints the Discovery attribution
 *       and `Parked at DISCOVERY`.
 * T1.4  a dry-run populated advance prints no attribution and writes nothing.
 * T2.1  a dry-run park prints the dry-run disclaimer, never claims
 *       "State is checkpointed", and leaves the checkpoint byte-identical.
 * T2.2  (same run) no `Would scaffold` line at a park.
 * T2.3  (same run) prints `Would park at DISCOVERY`.
 * T2.4  the preview mirrors the real run: reuse / scaffold / supplied-plan.
 * T3.1  a title-rejected report is reported as a TITLE problem, not as missing
 *       RCA content, and prints no content breakdown.
 * T3.2  (control) the same bytes + the scaffold H1 advance to PLAN.
 * T3.3  a content park keeps the generic headline + full breakdown.
 * T3.4  the two park reasons are distinguishable at the headline.
 * T14.1 the adoption-path scaffold summary names `implementation_plan.md`
 *       exactly once (E4: no `Canonical Mirror` duplicate).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

/** A discovery report `DiscoveryReport.isPopulated` accepts (H1 + 4 sections). */
const POPULATED_RCA = [
  '# [Discovery] - plan output truthfulness',
  '',
  '## 1. Problem Statement & Symptoms',
  '- **Observed Behavior:** the plan block names a subagent that never ran.',
  '- **Expected Behavior:** the block names the stage the run actually lands on.',
  '- **Affected Components / Paths:** `src/presentation/cli.ts`.',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '- **Investigation Steps:** re-read the plan case and its attribution legs.',
  '- **Identified Failure Mode:** the leg was keyed on `previousStage` alone.',
  '- **Relevant Code References:** `cli.ts:3664`.',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '- **Local Reproduction Command:** `codeloop plan --issue 339 --dry-run`',
  '- **Failing Test Target:** `tests/presentation/cli-plan-output.test.ts`',
  '',
  '## 4. Remediation Strategy',
  '- **Recommended Fix Approach:** gate the attribution on `--skip-discovery`.',
  '- **Potential Regressions / Side Effects:** none'
].join('\n');

/**
 * The substantive 4-section report whose FIRST LINE is not the scaffold title:
 * every key value clears the `DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS` floor,
 * so the ONLY thing rejecting it is the #320 kind gate (its title).
 */
const FOREIGN_TITLE_RCA = [
  '## Problem Statement & Symptoms',
  '',
  '- **Observed Behavior:** the plan block names a subagent that never ran for a flag whose purpose was to skip it.',
  '- **Expected Behavior:** the block names the stage the run actually lands on, or is omitted entirely.',
  '- **Affected Components / Paths:** `src/presentation/cli.ts` attribution legs and park messages.',
  '',
  '## 2. Root Cause Analysis (RCA)',
  '',
  '- **Investigation Steps:** re-read the plan case, the re-entry policy and the kind gate in sequence.',
  '- **Identified Failure Mode:** the attribution leg was keyed on `previousStage` alone with no skip guard.',
  '- **Relevant Code References:** `src/presentation/cli.ts:3664`, `src/application/start-planning.ts:612`.',
  '',
  '## 3. Reproduction Steps & Verification Protocol',
  '',
  '- **Local Reproduction Command:** `codeloop plan --skip-discovery --issue 339` from a DISCOVERY checkpoint.',
  '- **Failing Test Target:** `tests/presentation/cli-plan-output.test.ts` T1.1 and T3.1 cases.',
  '',
  '## 4. Remediation Strategy',
  '',
  '- **Recommended Fix Approach:** guard the attribution leg on skipDiscovery and thread the kind reason into the park message.',
  '- **Potential Regressions / Side Effects:** none for a populated-report advance or a content park.'
].join('\n');

/** Valid H1, zero content: a pure CONTENT park (kind gate passes). */
const BLANK_DISCOVERY = '# [Discovery] - plan output truthfulness';

function makeSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-plan-output-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: seed'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  return dir;
}

/**
 * Runs the CLI in `dir`, in-process, capturing both streams. stdout is forced
 * non-TTY so the colour policy renders deterministically plain (the colour
 * policy itself is owned by `cli-color-policy.test.ts`).
 */
async function runCliIn(dir: string, args: readonly string[]) {
  const { runCli } = require('../../dist/presentation/cli');
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(dir);
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    console.log = (...a: unknown[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: unknown[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const code = await runCli(args);
    return { code, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
  } finally {
    process.chdir(prevCwd);
    console.log = originalLog;
    console.error = originalError;
    process.stdin.isTTY = originalStdinTTY;
    process.stdout.isTTY = originalStdoutTTY;
  }
}

function seedCheckpoint(dir: string, issue: number, snapshot: Record<string, unknown>): void {
  const tasksDir = path.join(dir, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(tasksDir, `${issue}.json`),
    JSON.stringify(
      {
        version: '1.0.0',
        mode: 'standard',
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

/**
 * Seeds a plan directory for the issue. `discoveryContent` writes the
 * `[Discovery] - <title>.md` artifact (named so DISCOVERY resolution finds it);
 * `populatedRca` is the shorthand for the accepted report.
 */
function seedPlanDir(
  dir: string,
  issue: number,
  options: {
    readonly populatedRca?: boolean;
    readonly discoveryContent?: string;
  } = {}
): string {
  const planDir = path.join(dir, 'artifacts', 'plans', `${issue}-smoke`);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(
    path.join(planDir, 'implementation_plan.md'),
    [
      '# [Implementation] - plan output truthfulness',
      '',
      '## 3. Implementation Steps',
      '- [ ] Step 1: gate the attribution leg',
      '- [ ] Step 2: put the dry-run leg first',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, 'templates', 'summary-log.md'),
    path.join(planDir, 'CodeLoop Summary.md')
  );
  const content =
    options.discoveryContent !== undefined
      ? options.discoveryContent
      : options.populatedRca
        ? POPULATED_RCA
        : undefined;
  if (content !== undefined) {
    fs.writeFileSync(
      path.join(planDir, '[Discovery] - plan output truthfulness.md'),
      content,
      'utf8'
    );
  }
  return planDir;
}

function checkpointBytes(dir: string, issue: number): string {
  return fs.readFileSync(path.join(dir, '.agyloop', 'tasks', `${issue}.json`), 'utf8');
}

function discoveryDiscoveryRun(
  dir: string,
  issue: number,
  content: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  seedPlanDir(dir, issue, { discoveryContent: content });
  seedCheckpoint(dir, issue, {
    currentStage: 'DISCOVERY',
    planDir: path.join(dir, 'artifacts', 'plans', `${issue}-smoke`),
    history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
  });
  return runCliIn(dir, ['plan', '--issue', String(issue)]);
}

describe('item 1: `plan` attribution names the work that ran (AC-1.1)', () => {
  test('T1.1: plan --skip-discovery renders no Discovery attribution while advancing to PLAN', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, 33911, { populatedRca: true });
      seedCheckpoint(dir, 33911, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runCliIn(dir, ['plan', '--issue', '33911', '--skip-discovery']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Pipeline advanced to/, run.stdout);
      assert.match(run.stdout, /\[PLAN\]/, run.stdout);
      assert.ok(!/Subagent/.test(run.stdout), `no Subagent line, got:\n${run.stdout}`);
      assert.ok(!/Model Tier/.test(run.stdout), `no Model Tier line, got:\n${run.stdout}`);
      assert.ok(
        !/Discovery Subagent/.test(run.stdout),
        `the skipped role must not be named, got:\n${run.stdout}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T1.2: an advance out of a populated DISCOVERY note names no subagent (issue #400, D1)', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, 33912, { populatedRca: true });
      seedCheckpoint(dir, 33912, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runCliIn(dir, ['plan', '--issue', '33912']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Pipeline advanced to \[PLAN\]/, run.stdout);
      // Nothing was dispatched by this run, and the next dispatch is the
      // planner: the Discovery attribution is a lie about the NEXT actor.
      assert.ok(!/Subagent\s*:/.test(run.stdout), `no Subagent line, got:\n${run.stdout}`);
      assert.ok(!/Model Tier\s*:/.test(run.stdout), `no Model Tier line, got:\n${run.stdout}`);
      assert.ok(
        !/Discovery Subagent/.test(run.stdout),
        `discovery must not be named after leaving its stage, got:\n${run.stdout}`
      );

      // Blank the plan so PLAN is dispatchable, then ask who is next: it is the
      // planner at PLAN, which is exactly what the block must not have promised
      // at DISCOVERY time.
      fs.writeFileSync(
        path.join(planDir, 'implementation_plan.md'),
        [
          '# [Implementation] - plan output truthfulness',
          '',
          '## 3. Implementation Steps',
          '- [ ] **Step 1:**',
          ''
        ].join('\n'),
        'utf8'
      );
      const next = await runCliIn(dir, ['next', '--issue', '33912', '--json']);
      assert.strictEqual(next.code, 0, next.stderr);
      const directive = JSON.parse(next.stdout);
      assert.strictEqual(directive.actionType, 'subagent', next.stdout);
      assert.strictEqual(directive.currentStage, 'PLAN', next.stdout);
      assert.strictEqual(directive.role, 'planner', next.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T1.4: a dry-run populated advance names nothing and writes nothing (issue #400)', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, 33914, { populatedRca: true });
      seedCheckpoint(dir, 33914, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });
      const before = checkpointBytes(dir, 33914);

      const run = await runCliIn(dir, ['plan', '--issue', '33914', '--dry-run']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /\[DRY RUN\] Stage unchanged/, run.stdout);
      assert.match(run.stdout, /Would reuse existing plan directory/, run.stdout);
      assert.ok(!/Subagent\s*:/.test(run.stdout), `no Subagent line, got:\n${run.stdout}`);
      assert.ok(!/Model Tier\s*:/.test(run.stdout), `no Model Tier line, got:\n${run.stdout}`);
      assert.strictEqual(checkpointBytes(dir, 33914), before, 'checkpoint must be byte-identical');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T1.3: a blank-report park prints the Discovery attribution (control)', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, 33913, { discoveryContent: BLANK_DISCOVERY });
      seedCheckpoint(dir, 33913, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });

      const run = await runCliIn(dir, ['plan', '--issue', '33913']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Parked at DISCOVERY/, run.stdout);
      assert.match(run.stdout, /Subagent\s*:\s*discovery/, run.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('item 2: a dry-run park tells the dry-run truth (AC-1.2)', () => {
  test('T2.1/T2.2/T2.3: disclaimer first, no checkpoint claim, no scaffold claim, would-park line', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, 33921, { discoveryContent: BLANK_DISCOVERY });
      seedCheckpoint(dir, 33921, {
        currentStage: 'DISCOVERY',
        planDir,
        history: [{ stage: 'DISCOVERY', timestamp: new Date().toISOString() }]
      });
      const before = checkpointBytes(dir, 33921);

      const run = await runCliIn(dir, ['plan', '--issue', '33921', '--dry-run']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /\[DRY RUN\]/, run.stdout);
      assert.match(run.stdout, /Stage unchanged/, run.stdout);
      assert.match(run.stdout, /No checkpoint was written/, run.stdout);
      // The park note asserts a checkpoint that was never written on this path.
      assert.ok(
        !/State is checkpointed/.test(run.stdout),
        `a dry run must never claim a checkpoint, got:\n${run.stdout}`
      );
      // T2.2: the real run parks — it scaffolds nothing to preview (E1).
      assert.ok(!/Would scaffold/.test(run.stdout), `E1 violation:\n${run.stdout}`);
      // T2.3: the would-statement mirrors the real run's branch.
      assert.match(run.stdout, /Would park at DISCOVERY/, run.stdout);
      // AC-1.2: no mutation whatsoever.
      assert.strictEqual(checkpointBytes(dir, 33921), before, 'checkpoint must be byte-identical');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T2.4a: a dry run over an existing plan directory promises reuse, not a scaffold (E1)', async () => {
    const dir = makeSandbox();
    try {
      const planDir = seedPlanDir(dir, 33924);
      seedCheckpoint(dir, 33924, {
        currentStage: 'PLAN',
        planDir,
        history: [{ stage: 'PLAN', timestamp: new Date().toISOString() }]
      });
      const before = checkpointBytes(dir, 33924);

      const run = await runCliIn(dir, ['plan', '--issue', '33924', '--dry-run']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Would reuse existing plan directory/, run.stdout);
      assert.ok(!/Would scaffold/.test(run.stdout), `E1 violation:\n${run.stdout}`);
      assert.match(run.stdout, /No checkpoint was written/, run.stdout);
      assert.strictEqual(checkpointBytes(dir, 33924), before, 'checkpoint must be byte-identical');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T2.4b: a dry run with no plan directory names the RESOLVED title on its scaffold line', async () => {
    const dir = makeSandbox();
    try {
      const run = await runCliIn(dir, [
        'plan',
        '--dry-run',
        '--title',
        'WouldScaffold339',
        '--type',
        'implementation'
      ]);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Would scaffold/, run.stdout);
      assert.match(run.stdout, /"WouldScaffold339"/, run.stdout);
      assert.match(run.stdout, /No checkpoint was written/, run.stdout);
      assert.ok(
        !fs.existsSync(path.join(dir, 'artifacts')),
        'a dry run must not create the plan directory'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T2.4c: a dry run with --plan-path promises the supplied plan', async () => {
    const dir = makeSandbox();
    try {
      fs.writeFileSync(
        path.join(dir, 'supplied_plan.md'),
        [
          '# [Implementation] - Supplied plan',
          '',
          '## 3. Implementation Steps',
          '- [ ] Step 1: do the thing',
          ''
        ].join('\n'),
        'utf8'
      );

      const run = await runCliIn(dir, ['plan', '--dry-run', '--plan-path', 'supplied_plan.md']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Would use supplied plan/, run.stdout);
      assert.match(run.stdout, /supplied_plan\.md/, run.stdout);
      assert.ok(!/Would scaffold/.test(run.stdout), `E1 violation:\n${run.stdout}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('item 3: a title rejection is reported as a title problem (AC-1.3/1.4)', () => {
  test('T3.1: a foreign-H1 report parks with the KIND headline and no content breakdown', async () => {
    const dir = makeSandbox();
    try {
      const run = await discoveryDiscoveryRun(dir, 33931, FOREIGN_TITLE_RCA);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Parked at DISCOVERY/, run.stdout);
      assert.match(run.stdout, /first line/i, run.stdout);
      assert.match(run.stdout, /\[Discovery\]/, run.stdout);
      assert.ok(
        !/does not yet contain RCA evidence/.test(run.stdout),
        `the kind gate's reason must not be reported as missing content:\n${run.stdout}`
      );
      assert.ok(
        !/Missing evidence in/.test(run.stdout),
        `no content breakdown for a title-only rejection:\n${run.stdout}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T3.2: the same bytes with the scaffold H1 prepended advance to PLAN (control)', async () => {
    const dir = makeSandbox();
    try {
      const run1 = await discoveryDiscoveryRun(dir, 33932, FOREIGN_TITLE_RCA);
      assert.match(run1.stdout, /Parked at DISCOVERY/, run1.stdout);

      // The ONLY change: line 1 becomes the discovery title.
      const file = path.join(dir, 'artifacts', 'plans', '33932-smoke', '[Discovery] - plan output truthfulness.md');
      fs.writeFileSync(
        file,
        `# [Discovery] - plan output truthfulness\n\n${FOREIGN_TITLE_RCA}\n`,
        'utf8'
      );

      const run2 = await runCliIn(dir, ['plan', '--issue', '33932']);
      assert.strictEqual(run2.code, 0, run2.stderr);
      assert.match(run2.stdout, /Pipeline advanced to/, run2.stdout);
      assert.match(run2.stdout, /\[PLAN\]/, run2.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T3.3: a content park keeps the generic headline and the full breakdown (control)', async () => {
    const dir = makeSandbox();
    try {
      const run = await discoveryDiscoveryRun(dir, 33933, BLANK_DISCOVERY);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Parked at DISCOVERY/, run.stdout);
      assert.match(run.stdout, /does not yet contain RCA evidence/, run.stdout);
      assert.match(run.stdout, /Missing evidence in/, run.stdout);
      assert.ok(
        !/first line must be/.test(run.stdout),
        `kind wording on a content park:\n${run.stdout}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T3.4: the two park reasons are distinguishable at the headline', async () => {
    const kindSandbox = makeSandbox();
    const contentSandbox = makeSandbox();
    try {
      const kindRun = await discoveryDiscoveryRun(kindSandbox, 33934, FOREIGN_TITLE_RCA);
      const contentRun = await discoveryDiscoveryRun(contentSandbox, 339341, BLANK_DISCOVERY);

      const kindHeadline = /the discovery report's first line must be/;
      const contentHeadline = /does not yet contain RCA evidence/;

      assert.match(kindRun.stdout, kindHeadline, kindRun.stdout);
      assert.doesNotMatch(kindRun.stdout, contentHeadline, kindRun.stdout);

      assert.match(contentRun.stdout, contentHeadline, contentRun.stdout);
      assert.doesNotMatch(contentRun.stdout, kindHeadline, contentRun.stdout);
    } finally {
      fs.rmSync(kindSandbox, { recursive: true, force: true });
      fs.rmSync(contentSandbox, { recursive: true, force: true });
    }
  });
});

describe('audit extra E4: one path, one label', () => {
  test('T14.1: the adoption-path scaffold summary names implementation_plan.md exactly once', async () => {
    const dir = makeSandbox();
    try {
      // Run 1 scaffolds a discovery directory; run 2 ADOPTS it (auto type
      // resolves to implementation), which is the shape the audit saw printing
      // `implementation_plan.md` under both `Specification` and `Canonical Mirror`.
      const first = await runCliIn(dir, ['plan', '--title', 'Adopt339', '--type', 'discovery']);
      assert.strictEqual(first.code, 0, first.stderr);
      assert.match(first.stdout, /Initialized plan directory/, first.stdout);

      const second = await runCliIn(dir, ['plan', '--skip-discovery', '--title', 'Adopt339']);
      assert.strictEqual(second.code, 0, second.stderr);
      assert.match(second.stdout, /Using existing plan directory/, second.stdout);

      const occurrences = second.stdout.split('implementation_plan.md').length - 1;
      assert.strictEqual(
        occurrences,
        1,
        `implementation_plan.md must be named once, got ${occurrences}:\n${second.stdout}`
      );
      assert.ok(
        !/Canonical Mirror/.test(second.stdout),
        `the duplicate label must be gone:\n${second.stdout}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
