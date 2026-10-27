/**
 * agyloop - YOLO implementation park e2e through runCli (issue #259, P1-P6)
 *
 * The canonical repro of the issue: `codeloop yolo` prepares an implementation
 * but never dispatches the implementer, so the gates used to certify the
 * untouched baseline and the pipeline advanced to the COMMIT gate with an
 * empty diff.
 *
 * P1: the canonical repro prints the non-green park block and NO quality gate
 *     report.
 * P2: the persisted state stage is IMPLEMENT, not COMMIT.
 * P3: the park prints the invoke_subagent JSON payload for the implementer.
 * P4: the output contains no "Paused at COMMIT gate" and no "Quality gates
 *     passed".
 * P5: after a source change exists, a re-run reaches the COMMIT gate.
 * P6: a re-run over a tree whose implementation is wrong FAILS the gates —
 *     the gates validate the implementation, not the baseline.
 *
 * Harness: in-process `runCli` sandbox copied from cli-yolo-discovery.test.ts
 * (#234) and cli-yolo-review-skipped.test.ts (#236):
 *   - a disposable git repository on branch `main` (the probe's base ref),
 *   - a stub package.json whose `test` script really runs the suite,
 *   - an environment sanitation pass (HOME/XDG/AGY_SUBAGENT scrub + a shadow
 *     PATH with no `critique` executable) so the AI review is deterministically
 *     SKIPPED,
 *   - a hard precondition probe: if critique still resolves to anything other
 *     than `source: 'none'` the test SKIPS with an explicit message.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const {
  EXIT_CODE_SUCCESS,
  EXIT_CODE_FAILURE,
  NOTE_IMPLEMENTATION_EVIDENCE_MISSING,
  NOTE_IMPLEMENTATION_PARK_UNCHANGED,
  NOTE_IMPLEMENTATION_PARK_DISPATCH,
  NOTE_IMPLEMENTATION_PARK_NEXT,
  NOTE_IMPLEMENTATION_PLAN_EMPTY,
  NOTE_IMPLEMENTATION_PLAN_EMPTY_NEXT,
  // Issue #259: the VACUOUS refusal messages. The CLI must print the domain
  // constant — never a hand-typed copy of it.
  NOTE_GATES_VACUOUS_STANDARD,
  NOTE_GATES_VACUOUS_YOLO,
  HEADER_QUALITY_GATE_REPORT,
  LABEL_OVERALL_VERDICT
} = require('../../dist/domain');
const { CliCritiqueGateway } = require('../../dist/infrastructure');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const CRITIQUE_BINARY = 'critique';
/** The presentation source, inspected by the no-magic-string guard (P8). */
const CLI_SOURCE_PATH = path.join(__dirname, '..', '..', 'src', 'presentation', 'cli.ts');

/** The plan directory an adhoc `codeloop yolo --title 'repro task'` scaffolds. */
const ADHOC_PLAN_DIR = path.join('artifacts', 'plans', 'adhoc-repro-task');
/** The canonical plan mirror inside that directory. */
const ADHOC_PLAN_FILE = path.join(ADHOC_PLAN_DIR, 'implementation_plan.md');

/**
 * A plan a planner subagent (or the operator) actually wrote.
 *
 * The fast-path never dispatches the PLANNER, so the plan it holds is the
 * tool's own blank scaffold — and a directive that points at an empty plan is
 * a false instruction (issue #259, S10). This fixture stands in for the
 * planner's output: the plan the implementer would actually receive.
 */
const POPULATED_PLAN = [
  '# Implementation Plan — repro-task',
  '',
  '## Objective',
  'Change `answer()` in `src-target.js` to return `7` instead of `42`.',
  '',
  '## Steps',
  '1. Edit `src-target.js` so `answer()` returns `7`.',
  '2. Update `index.test.js` so the test expects `7`.',
  ''
].join('\n');

const SOURCE_WITH_42 = 'export function answer() { return 42; }\n';
const SOURCE_WITH_7 = 'export function answer() { return 7; }\n';
const TEST_EXPECTING_42 = "import { answer } from './src-target.js';\nif (answer() !== 42) { throw new Error('bad'); }\n";
const TEST_EXPECTING_7 = "import { answer } from './src-target.js';\nif (answer() !== 7) { throw new Error('bad'); }\n";

function stateFilePath(dir: string): string {
  return path.join(dir, '.agyloop', 'state.json');
}

function readState(dir: string): any {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(dir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The tree the pipeline actually measures (issue #301).
 *
 * The YOLO fast-path provisions its worktree when it enters the implementation
 * leg, so a re-entry at IMPLEMENT executes INSIDE that worktree. An
 * implementation written into the root would be invisible to the gates — the
 * run honours the descriptor it already has instead of re-provisioning (and no
 * longer silently falls back to the root).
 */
function implementationDir(sandbox: string): string {
  const worktreePath = readState(sandbox)?.worktree?.worktreePath;
  return typeof worktreePath === 'string' && worktreePath.length > 0 ? worktreePath : sandbox;
}

/**
 * Builds a disposable git repository on branch `main` with a REAL test suite:
 * the gate command is `npm test`, and the suite fails when the source and the
 * test disagree.
 */
function setupRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'repro@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'repro'], { cwd: dir, stdio: 'ignore' });

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'repro',
      version: '1.0.0',
      type: 'module',
      // `env -u NODE_TEST_CONTEXT` keeps the child suite from inheriting the
      // OUTER `node --test` marker: with it set, `node --test` believes it is
      // a nested test-runner child and silently skips every file (exit 0), which
      // would make the gate certify anything.
      scripts: { test: 'env -u NODE_TEST_CONTEXT node --test' }
    }),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'src-target.js'), SOURCE_WITH_42, 'utf8');
  fs.writeFileSync(path.join(dir, 'index.test.js'), TEST_EXPECTING_42, 'utf8');

  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: repro init'], { cwd: dir, stdio: 'ignore' });
}

/**
 * Builds a shadow directory mirroring every PATH entry, excluding any file
 * named `critique` (CliCritiqueGateway.findInSystemPath resolves it by
 * existence, not by executable bit).
 */
function buildCritiqueFreePathShadow(shadowRoot: string): string {
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
    if (!entries.includes(CRITIQUE_BINARY)) {
      try {
        fs.symlinkSync(real, target, 'dir');
        shadowEntries.push(target);
        continue;
      } catch {
        // Fall through to entry-by-entry copy on symlink failure
      }
    }

    fs.mkdirSync(target, { recursive: true });
    for (const entry of entries) {
      if (entry === CRITIQUE_BINARY || entry.startsWith(`${CRITIQUE_BINARY}.`)) continue;
      try {
        fs.symlinkSync(fs.realpathSync(path.join(real, entry)), path.join(target, entry));
      } catch {
        // Skip entries that cannot be resolved
      }
    }
    shadowEntries.push(target);
  }

  return shadowEntries.join(path.delimiter);
}

/**
 * Runs `fn` with the sanitized environment applied (HOME/XDG/AGY_SUBAGENT scrub
 * + critique-free shadow PATH), restoring cwd/env/console afterwards.
 *
 * The shadow and the fake HOME live OUTSIDE the repository sandbox: anything
 * created inside the sandbox would show up in `git status` and would be
 * mistaken for an implementation.
 */
async function withSanitizedEnv(
  sandbox: string,
  supportDir: string,
  shadowPath: string,
  fn: () => Promise<any>
): Promise<{ value: any; stdout: string; stderr: string }> {
  const prevCwd = process.cwd();
  const envBackup: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    AGY_SUBAGENT: process.env.AGY_SUBAGENT
  };
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';

  try {
    process.chdir(sandbox);
    process.env.PATH = shadowPath;
    process.env.HOME = path.join(supportDir, '.home');
    delete process.env.XDG_DATA_HOME;
    delete process.env.AGY_SUBAGENT;
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const value = await fn();
    return { value, stdout: stdout.replace(ANSI_ESCAPE, ''), stderr: stderr.replace(ANSI_ESCAPE, '') };
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

/**
 * Creates the sandbox + support directories and returns the sanitized
 * environment description used by every run.
 */
function createSandbox(): { sandbox: string; supportDir: string; shadowPath: string } {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-yolo-implementation-park-'));
  const supportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-yolo-implementation-park-support-'));

  setupRepo(sandbox);

  fs.mkdirSync(path.join(supportDir, '.home'), { recursive: true });
  fs.mkdirSync(path.join(supportDir, '.xdg'), { recursive: true });

  const shadowPath = buildCritiqueFreePathShadow(path.join(supportDir, '.shadow-bin'));

  return { sandbox, supportDir, shadowPath };
}

function destroySandbox(sandbox: string, supportDir: string): void {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(supportDir, { recursive: true, force: true });
}

/**
 * Writes a REAL plan into the plan directory the fast-path scaffolds, standing
 * in for the planner subagent the fast-path never dispatches (issue #259, S10).
 *
 * The scaffold does not overwrite an existing plan file, so the written plan
 * survives the run and is the document the implementer directive points at.
 */
function writePopulatedPlan(sandbox: string): string {
  const planFile = path.join(sandbox, ADHOC_PLAN_FILE);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, POPULATED_PLAN, 'utf8');
  return planFile;
}

/** Runs `codeloop yolo` inside the sandbox and captures both streams. */
async function runYolo(
  env: { sandbox: string; supportDir: string; shadowPath: string },
  args: readonly string[] = ['yolo', '--title', 'repro task', '--type', 'implementation']
): Promise<{ code: number; stdout: string; stderr: string; output: string }> {
  const run = await withSanitizedEnv(env.sandbox, env.supportDir, env.shadowPath, async () => {
    return { code: await runCli(args) };
  });

  const stdout = run.stdout;
  const stderr = run.stderr;

  return { code: run.value.code, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/**
 * Runs `codeloop <args>` (the STANDARD loop) inside the sandbox and captures
 * both streams.
 */
async function runStandard(
  env: { sandbox: string; supportDir: string; shadowPath: string },
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string; output: string }> {
  const run = await withSanitizedEnv(env.sandbox, env.supportDir, env.shadowPath, async () => {
    return { code: await runCli(args) };
  });

  const stdout = run.stdout;
  const stderr = run.stderr;

  return { code: run.value.code, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/**
 * Precondition: the AI review must be deterministically SKIPPED, otherwise the
 * COMMIT-gate assertions of P5 would depend on the machine's critique
 * installation.
 */
async function assertCritiqueAbsent(t: any, env: { sandbox: string; supportDir: string; shadowPath: string }): Promise<boolean> {
  const probe = await withSanitizedEnv(env.sandbox, env.supportDir, env.shadowPath, async () => {
    return new CliCritiqueGateway().resolveReviewer(env.sandbox);
  });

  const resolution: any = probe.value;
  if (!resolution || resolution.source !== 'none') {
    t.skip(
      `environment cannot guarantee critique absence: resolveReviewer => ${JSON.stringify(resolution)}`
    );
    return false;
  }
  return true;
}

/** The operator-facing park block, built from the shared domain constants. */
function expectedParkBlock(baseRef: string): string[] {
  return [
    `⚠ ${NOTE_IMPLEMENTATION_EVIDENCE_MISSING}.`,
    `   ${NOTE_IMPLEMENTATION_PARK_UNCHANGED.replace('{baseRef}', baseRef)}`,
    `   ${NOTE_IMPLEMENTATION_PARK_DISPATCH}`,
    `   ${NOTE_IMPLEMENTATION_PARK_NEXT}`
  ];
}

/**
 * The operator-facing park block of a run whose plan is still the blank
 * scaffold (issue #259, S10): the ordinary continuation line is REPLACED by
 * the plan-empty advisory — printing both would tell the operator to dispatch
 * an implementer that has nothing to execute.
 */
function expectedPlanEmptyParkBlock(baseRef: string): string[] {
  return [
    `⚠ ${NOTE_IMPLEMENTATION_EVIDENCE_MISSING}.`,
    `   ${NOTE_IMPLEMENTATION_PARK_UNCHANGED.replace('{baseRef}', baseRef)}`,
    `   ${NOTE_IMPLEMENTATION_PARK_DISPATCH}`,
    `   ${NOTE_IMPLEMENTATION_PLAN_EMPTY_NEXT}`
  ];
}

describe('codeloop yolo implementation park (issue #259)', () => {
  test('P1 (AC1): the canonical yolo repro prints the non-green park block and no quality gate report', async (t: any) => {
    const env = createSandbox();

    try {
      if (!(await assertCritiqueAbsent(t, env))) return;

      const run = await runYolo(env);

      assert.strictEqual(
        run.code,
        EXIT_CODE_SUCCESS,
        `the park is a deliberate, checkpointed stop (exit 0 expected); stdout=${run.stdout} stderr=${run.stderr}`
      );

      for (const line of expectedPlanEmptyParkBlock('main')) {
        assert.ok(run.stderr.includes(line), `expected the park line '${line}' on stderr, got:\n${run.stderr}`);
      }

      // The canonical repro runs over the tool's own blank scaffold (the
      // fast-path never dispatches the planner), so the park names the empty
      // plan instead of emitting a directive that points at it.
      assert.ok(
        run.stderr.includes('blank scaffold'),
        `the park must say the plan is the blank scaffold, got:\n${run.stderr}`
      );

      assert.ok(
        !run.output.includes(HEADER_QUALITY_GATE_REPORT),
        `no quality gate report may be produced, got:\n${run.output}`
      );
      assert.ok(
        !run.output.includes(`${LABEL_OVERALL_VERDICT} : PASSED`),
        `the gates must never certify an unimplemented tree, got:\n${run.output}`
      );
      assert.ok(
        !run.output.includes('VACUOUS'),
        `the gate never ran, so no VACUOUS verdict may be reported, got:\n${run.output}`
      );
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });

  test('P2 (AC2): the persisted state stage is IMPLEMENT, not COMMIT', async (t: any) => {
    const env = createSandbox();

    try {
      if (!(await assertCritiqueAbsent(t, env))) return;

      await runYolo(env);

      const persisted = readState(env.sandbox);
      assert.ok(persisted, `state.json must exist under ${env.sandbox}`);
      assert.strictEqual(persisted.currentStage, 'IMPLEMENT', `state=${JSON.stringify(persisted)}`);
      assert.notStrictEqual(persisted.currentStage, 'COMMIT');
      assert.notStrictEqual(persisted.currentStage, 'QUALITY_GATE');
      assert.ok(persisted.pausedAtGate == null, 'a park is not a human gate');

      // The source file is untouched: the plan was never executed.
      const source = fs.readFileSync(path.join(env.sandbox, 'src-target.js'), 'utf8');
      assert.strictEqual(source, SOURCE_WITH_42, 'the implementation must not have been produced');
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });

  test('P3 (AC1/AC6): the park prints the invoke_subagent JSON payload for the implementer', async (t: any) => {
    const env = createSandbox();

    try {
      if (!(await assertCritiqueAbsent(t, env))) return;

      // Issue #259 (S10): the fast-path never dispatches the PLANNER, so its
      // plan IS the tool's blank scaffold — and a directive that points at an
      // EMPTY plan is a false instruction. The directive is therefore emitted
      // over a plan that was actually WRITTEN (the issue-scoped path, where
      // the planner subagent has filled the plan in).
      writePopulatedPlan(env.sandbox);

      const run = await runYolo(env);

      assert.ok(
        run.stdout.includes('--- invoke_subagent JSON Payload ---'),
        `the implementer dispatch directive must be printed, got:\n${run.stdout}`
      );

      const payloadStart = run.stdout.indexOf('--- invoke_subagent JSON Payload ---');
      const payloadEnd = run.stdout.indexOf('Pass this payload directly to invoke_subagent');
      assert.ok(payloadStart >= 0 && payloadEnd > payloadStart, `the payload must be delimited, got:\n${run.stdout}`);

      const rawPayload = run.stdout
        .slice(payloadStart + '--- invoke_subagent JSON Payload ---'.length, payloadEnd)
        .trim();
      const payload = JSON.parse(rawPayload);

      assert.ok(Array.isArray(payload.Subagents), 'the payload must carry a Subagents array');
      assert.strictEqual(payload.Subagents.length, 1);
      assert.strictEqual(payload.Subagents[0].Role, 'Code Implementation Subagent');
      assert.ok(
        payload.Subagents[0].Prompt.includes('Implementation Execution'),
        'the payload must be the implementer directive'
      );
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });

  test('P4 (AC2): the output contains no "Paused at COMMIT gate" and no "Quality gates passed"', async (t: any) => {
    const env = createSandbox();

    try {
      if (!(await assertCritiqueAbsent(t, env))) return;

      const run = await runYolo(env);

      assert.ok(
        !run.output.includes('Paused at'),
        `a park must never announce a gate pause, got:\n${run.output}`
      );
      assert.ok(
        !run.output.includes('Quality gates passed'),
        `a park must never claim the gates passed, got:\n${run.output}`
      );
      assert.ok(
        !run.output.includes('Review passed'),
        `a park must never claim a review passed, got:\n${run.output}`
      );
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });

  test('P5 (AC5): after a source change exists, a re-run reaches the COMMIT gate', async (t: any) => {
    const env = createSandbox();

    try {
      if (!(await assertCritiqueAbsent(t, env))) return;

      const first = await runYolo(env);
      assert.strictEqual(first.code, EXIT_CODE_SUCCESS, `the first run must park, got:\n${first.output}`);

      // Simulate the implementer subagent: the source AND the test change.
      // Issue #301: the run executes in the worktree it provisioned, so the
      // implementation must land there.
      const target = implementationDir(env.sandbox);
      fs.writeFileSync(path.join(target, 'src-target.js'), SOURCE_WITH_7, 'utf8');
      fs.writeFileSync(path.join(target, 'index.test.js'), TEST_EXPECTING_7, 'utf8');

      const second = await runYolo(env);

      assert.strictEqual(
        second.code,
        EXIT_CODE_SUCCESS,
        `the gates must pass over the implemented tree; stdout=${second.stdout} stderr=${second.stderr}`
      );
      assert.ok(
        second.output.includes(HEADER_QUALITY_GATE_REPORT),
        `the gates must run over the implemented tree, got:\n${second.output}`
      );
      assert.ok(
        second.output.includes(`${LABEL_OVERALL_VERDICT} : PASSED`),
        `the gates must pass over the implemented tree, got:\n${second.output}`
      );
      assert.ok(
        second.output.includes('(1/1 tests passed)'),
        `the suite must really have run over the implemented tree, got:\n${second.output}`
      );

      const persisted = readState(env.sandbox);
      assert.ok(persisted, 'the checkpoint must be persisted');
      assert.strictEqual(persisted.currentStage, 'COMMIT', `state=${JSON.stringify(persisted)}`);
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });

  test('P6 (AC5): a re-run over a tree whose implementation is wrong FAILS the gates (the gates validate the implementation, not the baseline)', async (t: any) => {
    const env = createSandbox();

    try {
      if (!(await assertCritiqueAbsent(t, env))) return;

      const first = await runYolo(env);
      assert.strictEqual(first.code, EXIT_CODE_SUCCESS, `the first run must park, got:\n${first.output}`);

      // Simulate a WRONG implementation: the source changes, the test does not.
      // Issue #301: written in the worktree the pipeline actually measures.
      fs.writeFileSync(path.join(implementationDir(env.sandbox), 'src-target.js'), SOURCE_WITH_7, 'utf8');

      const second = await runYolo(env);

      assert.strictEqual(
        second.code,
        EXIT_CODE_FAILURE,
        `the gates must fail over the broken implementation; stdout=${second.stdout} stderr=${second.stderr}`
      );
      assert.ok(
        second.output.includes(HEADER_QUALITY_GATE_REPORT),
        `the gates must run over the implemented tree, got:\n${second.output}`
      );
      assert.ok(
        second.output.includes(`${LABEL_OVERALL_VERDICT} : FAILED`),
        `the gates must FAIL over the broken implementation, got:\n${second.output}`
      );
      assert.ok(
        !second.output.includes(`${LABEL_OVERALL_VERDICT} : PASSED`),
        `the baseline must never be certified, got:\n${second.output}`
      );
      assert.ok(
        second.output.includes('(0/1 tests passed)'),
        `the suite must really have run over the broken implementation, got:\n${second.output}`
      );

      const persisted = readState(env.sandbox);
      assert.ok(persisted, 'the checkpoint must be persisted');
      assert.strictEqual(
        persisted.currentStage,
        'IMPLEMENT',
        `a failed gate must revert to IMPLEMENT, state=${JSON.stringify(persisted)}`
      );
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });
});

/**
 * S10 — the CLI park over an EMPTY plan.
 *
 * `codeloop yolo` never dispatches the PLANNER either, so the plan the
 * fast-path holds is the tool's own blank scaffold. The park must say so and
 * must NOT print an implementer directive that points at an empty plan.
 */
describe('codeloop yolo implementation park — the empty-plan guard (issue #259, S10)', () => {
  test('Q6 (AC7): the CLI park over an empty plan prints the plan-empty advisory and NO invoke_subagent payload', async (t: any) => {
    const env = createSandbox();

    try {
      if (!(await assertCritiqueAbsent(t, env))) return;

      const run = await runYolo(env);

      assert.strictEqual(
        run.code,
        EXIT_CODE_SUCCESS,
        `the park is a deliberate, checkpointed stop (exit 0 expected); stdout=${run.stdout} stderr=${run.stderr}`
      );

      // The plan-empty advisory names the plan the implementer would have
      // received.
      assert.ok(
        run.stderr.includes('blank scaffold'),
        `the park must say the plan is the blank scaffold, got:\n${run.stderr}`
      );
      assert.ok(
        run.stderr.includes('[Implementation] - repro task.md'),
        `the park must name the plan path, got:\n${run.stderr}`
      );
      assert.ok(
        run.stderr.includes(NOTE_IMPLEMENTATION_PLAN_EMPTY_NEXT),
        `the plan-empty continuation line must be printed, got:\n${run.stderr}`
      );

      // The ordinary continuation line is REPLACED, not supplemented: printing
      // both would tell the operator to dispatch an implementer that has
      // nothing to execute.
      assert.ok(
        !run.stderr.includes(NOTE_IMPLEMENTATION_PARK_NEXT),
        `the ordinary continuation line must be replaced, got:\n${run.stderr}`
      );

      // No directive: a payload that points at an empty plan is a false
      // instruction.
      assert.ok(
        !run.stdout.includes('--- invoke_subagent JSON Payload ---'),
        `no implementer directive may be printed over an empty plan, got:\n${run.stdout}`
      );

      // The park itself is unchanged: the tree is still unchanged, and the
      // checkpoint is still at IMPLEMENT.
      for (const line of expectedPlanEmptyParkBlock('main').slice(0, 3)) {
        assert.ok(run.stderr.includes(line), `expected the park line '${line}' on stderr, got:\n${run.stderr}`);
      }
      const persisted = readState(env.sandbox);
      assert.ok(persisted, 'state.json must exist');
      assert.strictEqual(persisted.currentStage, 'IMPLEMENT', `state=${JSON.stringify(persisted)}`);
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });

  test('Q7 (AC7, negative control): the CLI park over a populated plan still prints the invoke_subagent payload for the implementer', async (t: any) => {
    const env = createSandbox();

    try {
      if (!(await assertCritiqueAbsent(t, env))) return;

      // The planner subagent (or the operator) wrote a real plan.
      writePopulatedPlan(env.sandbox);

      const run = await runYolo(env);

      assert.strictEqual(
        run.code,
        EXIT_CODE_SUCCESS,
        `the park is a deliberate, checkpointed stop (exit 0 expected); stdout=${run.stdout} stderr=${run.stderr}`
      );

      // The directive is emitted — the issue-scoped path is not broken.
      assert.ok(
        run.stdout.includes('--- invoke_subagent JSON Payload ---'),
        `the implementer dispatch directive must be printed over a written plan, got:\n${run.stdout}`
      );

      // And the plan-empty advisory is absent.
      assert.ok(
        !run.stderr.includes('blank scaffold'),
        `a written plan must never be reported as the blank scaffold, got:\n${run.stderr}`
      );
      assert.ok(
        !run.stderr.includes(NOTE_IMPLEMENTATION_PLAN_EMPTY_NEXT),
        `the plan-empty continuation line must not be printed over a written plan, got:\n${run.stderr}`
      );
      assert.ok(
        run.stderr.includes(NOTE_IMPLEMENTATION_PARK_NEXT),
        `the ordinary continuation line must be printed, got:\n${run.stderr}`
      );
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });
});

/**
 * The VACUOUS refusal at the CLI boundary (issue #259).
 *
 * The gate refuses to certify an unimplemented tree, and the CLI prints that
 * refusal. The wording lives in the DOMAIN (`NOTE_GATES_VACUOUS_STANDARD` /
 * `NOTE_GATES_VACUOUS_YOLO`): the presentation layer used to carry its own
 * hand-typed copies — one of them a truncated variant of the standard message
 * — and a copy is exactly how the two drift apart.
 */
describe('the CLI VACUOUS refusal (issue #259)', () => {
  test('P7 (AC3): the CLI prints the domain VACUOUS refusal — the constant with {baseRef} substituted, never a hand-typed copy', async () => {
    const env = createSandbox();

    try {
      // The standard loop over an unchanged tree: plan -> implement -> gates.
      // The gates refuse to certify the untouched baseline (VACUOUS).
      const planned = await runStandard(env, [
        '--no-worktree',
        '--title',
        'repro task',
        '--type',
        'implementation'
      ]);
      assert.strictEqual(
        planned.code,
        EXIT_CODE_SUCCESS,
        `the plan leg must succeed; stdout=${planned.stdout} stderr=${planned.stderr}`
      );

      const implemented = await runStandard(env, [
        'implement',
        '--no-worktree',
        '--title',
        'repro task',
        '--type',
        'implementation'
      ]);
      assert.strictEqual(
        implemented.code,
        EXIT_CODE_SUCCESS,
        `the implement leg must succeed; stdout=${implemented.stdout} stderr=${implemented.stderr}`
      );

      const run = await runStandard(env, [
        '--no-worktree',
        '--title',
        'repro task',
        '--type',
        'implementation'
      ]);

      // A refusal is not a failure.
      assert.strictEqual(
        run.code,
        EXIT_CODE_SUCCESS,
        `the VACUOUS refusal is a deliberate stop (exit 0 expected); stdout=${run.stdout} stderr=${run.stderr}`
      );

      // The printed refusal IS the domain constant, with `{baseRef}` substituted
      // by the verdict's base ref — never a hand-typed literal.
      const expected = `⚠ ${NOTE_GATES_VACUOUS_STANDARD.replace('{baseRef}', 'main')}`;
      const refusalLines = run.stderr.split('\n').filter((line) => line.startsWith('⚠ '));
      assert.ok(
        refusalLines.includes(expected),
        `the refusal must be printed verbatim from the domain constant; expected:\n${expected}\ngot:\n${run.stderr}`
      );

      // The verdict itself is a refusal, not a failure.
      assert.ok(
        run.output.includes(`${LABEL_OVERALL_VERDICT} : VACUOUS`),
        `the gate must report the VACUOUS verdict, got:\n${run.output}`
      );
      assert.ok(
        !run.output.includes('Quality gates failed'),
        `a refusal must never be reported as a failure, got:\n${run.output}`
      );
      assert.ok(
        !run.output.includes('reverted to'),
        `nothing was reverted, so nothing may claim it was, got:\n${run.output}`
      );
    } finally {
      destroySandbox(env.sandbox, env.supportDir);
    }
  });

  test('P8 (AC3): the presentation layer carries no hand-typed copy of the VACUOUS refusal — the domain constants are the only source', () => {
    const cliSource = fs.readFileSync(CLI_SOURCE_PATH, 'utf8');

    assert.ok(
      !cliSource.includes('Quality gates refused to certify an unimplemented tree'),
      'the CLI must not re-type the VACUOUS refusal — it must use the domain constants'
    );
    assert.ok(
      cliSource.includes('NOTE_GATES_VACUOUS_STANDARD'),
      'the CLI must use the domain constant for the standard refusal'
    );
    assert.ok(
      cliSource.includes('NOTE_GATES_VACUOUS_YOLO'),
      'the CLI must use the domain constant for the YOLO refusal'
    );

    // The domain constants are the single source of truth for both messages.
    assert.ok(
      NOTE_GATES_VACUOUS_STANDARD.includes('{baseRef}'),
      'the standard refusal names the base ref it was measured against'
    );
    assert.ok(
      !NOTE_GATES_VACUOUS_YOLO.includes('{baseRef}'),
      'the YOLO refusal carries no base ref placeholder'
    );
  });
});
