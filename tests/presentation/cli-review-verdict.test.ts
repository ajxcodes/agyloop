/**
 * agyloop - `codeloop review` CLI Tests (issue #269, Defect 2)
 *
 * The shipped OpenCode skill documented `codeloop review`, but the command did
 * not exist: `Error: Unknown command "review"`. The reviewer subagent's
 * `REVIEW_STATUS: APPROVED | CHANGES_REQUESTED` verdict therefore had NO
 * channel into the checkpoint.
 *
 * P1 - `codeloop review --verdict-file <f>` exits 0 (the command EXISTS)
 * P2 - the checkpoint lands at COMMIT with the verdict recorded in the history
 * P3 - a CHANGES_REQUESTED verdict exits 1 and the checkpoint lands at IMPLEMENT
 * P4 - afterwards `codeloop next --json` reports "Review passed." at the COMMIT gate
 * P5 - a SKIPPED block exits 1 and writes NO verdict
 * P6 - `--review-output` and `--verdict-stdin` feed the same seam
 * P7 - `codeloop review` with no verdict runs the critique path and does not crash
 * P10 - `--verdict-file` with no value fails loudly and records NO verdict (R1)
 * P11 - `--review-output` with no value fails loudly and records NO verdict (R1)
 * P12 - the empty `=` form and a flag-following value fail just as loudly (R1)
 * P13 - `--verdict-file` at a nonexistent path still fails loudly (R1)
 * P14 - `--verdict-stdin` with an empty stdin fails loudly (R1)
 * P15 - the reviewer's natural "none" phrasing records APPROVED and reaches
 *      COMMIT (issue #356)
 *
 * Harness: the critique-free PATH shadow copied from `cli-yolo-review-skipped.test.ts`
 * — the Tier 1 critique report must not be able to escalate the verdict under
 * test, so `critique` must be entirely absent.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS, EXIT_CODE_FAILURE } = require('../../dist/domain');
const { CliCritiqueGateway } = require('../../dist/infrastructure');

const CRITIQUE_BINARY = 'critique';
const ISSUE = 901;
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Builds a shadow directory mirroring every PATH entry, excluding any file named
 * `critique` (CliCritiqueGateway.findInSystemPath resolves it by existence).
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

/** Seeds a task checkpoint resting at the given stage. */
function seedCheckpoint(sandbox: string, issue: number, stage: string): string {
  const tasksDir = path.join(sandbox, '.agyloop', 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const file = path.join(tasksDir, `${issue}.json`);
  const now = new Date().toISOString();
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: '1.0.0',
        currentStage: stage,
        mode: 'standard',
        issue,
        baseBranch: 'main',
        createdAt: now,
        updatedAt: now,
        history: [{ stage, timestamp: now }],
        pausedAtGate: null,
        pausedAtTimestamp: null
      },
      null,
      2
    ),
    'utf8'
  );
  return file;
}

function readCheckpoint(sandbox: string, issue: number): any {
  const file = path.join(sandbox, '.agyloop', 'tasks', `${issue}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Runs `fn` with the sanitized environment applied, capturing both streams. */
async function withSanitizedEnv(
  sandbox: string,
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
    process.env.HOME = path.join(sandbox, '.home');
    delete process.env.XDG_DATA_HOME;
    delete process.env.AGY_SUBAGENT;
    console.log = (...a: any[]) => {
      stdout += a.map(String).join(' ') + '\n';
    };
    console.error = (...a: any[]) => {
      stderr += a.map(String).join(' ') + '\n';
    };
    const value = await fn();
    return { value, stdout, stderr };
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

interface Sandbox {
  readonly dir: string;
  readonly shadowPath: string;
}

function makeSandbox(stage: string): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-review-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });
  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.xdg'), { recursive: true });
  seedCheckpoint(dir, ISSUE, stage);
  return { dir, shadowPath: buildCritiqueFreePathShadow(path.join(dir, '.shadow-bin')) };
}

const APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: The change set faithfully implements the approved plan.
UNFULFILLED_AC:
- None
REMEDIATION_GUIDANCE:
- None
`;

const CHANGES_REQUESTED_BLOCK = `REVIEW_STATUS: CHANGES_REQUESTED
REVIEW_SUMMARY: The nil dereference in resolve-subagent.ts is unfixed.
UNFULFILLED_AC:
- The nil dereference is fixed
REMEDIATION_GUIDANCE:
- Fix the nil dereference in src/application/resolve-subagent.ts
`;

/**
 * The reviewer's OWN words (issue #356): the live #352 block. Before the fix,
 * `- None in the reviewed in-repo scope (…)` was captured as a criterion and the
 * two-tier invariant rewrote the reviewer's APPROVED to CHANGES_REQUESTED.
 */
const MIXED_NONE_APPROVED_BLOCK = `REVIEW_STATUS: APPROVED
REVIEW_SUMMARY: Every acceptance criterion is met; the diff is in scope.
UNFULFILLED_AC:
- None in the reviewed in-repo scope (deferred to post-commit).
REMEDIATION_GUIDANCE:
- None required.
`;

describe('codeloop review (issue #269, Defect 2)', () => {
  test('P1/P2: a verdict file is recorded and the checkpoint lands at COMMIT', async (t: any) => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const probe = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        new CliCritiqueGateway().resolveReviewer(sandbox.dir)
      );
      if (!probe.value || probe.value.source !== 'none') {
        t.skip(`environment cannot guarantee critique absence: ${JSON.stringify(probe.value)}`);
        return;
      }

      const verdictFile = path.join(sandbox.dir, 'verdict.md');
      fs.writeFileSync(verdictFile, APPROVED_BLOCK, 'utf8');

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', verdictFile])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.ok(
        !output.includes('Unknown command'),
        `the review command must exist, got:\n${output}`
      );
      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);
      assert.ok(output.includes('APPROVED'), `the verdict must be reported, got:\n${output}`);

      const checkpoint = readCheckpoint(sandbox.dir, ISSUE);
      assert.ok(checkpoint, 'the checkpoint must exist');
      assert.strictEqual(checkpoint.currentStage, 'COMMIT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'APPROVED');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P3: a CHANGES_REQUESTED verdict exits 1 and reverts the checkpoint to IMPLEMENT', async (t: any) => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const probe = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        new CliCritiqueGateway().resolveReviewer(sandbox.dir)
      );
      if (!probe.value || probe.value.source !== 'none') {
        t.skip(`environment cannot guarantee critique absence: ${JSON.stringify(probe.value)}`);
        return;
      }

      const verdictFile = path.join(sandbox.dir, 'verdict.md');
      fs.writeFileSync(verdictFile, CHANGES_REQUESTED_BLOCK, 'utf8');

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', verdictFile])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(
        output.includes('AI Review requested changes'),
        `the failure must be reported, got:\n${output}`
      );

      const checkpoint = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'CHANGES_REQUESTED');
      assert.ok(
        !checkpoint.history.some((h: any) => h.metadata?.reviewVerdict === 'SKIPPED'),
        'a CHANGES_REQUESTED must never be downgraded to SKIPPED'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P4: after recording, `codeloop next --json` reports "Review passed." at the COMMIT gate', async (t: any) => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const probe = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        new CliCritiqueGateway().resolveReviewer(sandbox.dir)
      );
      if (!probe.value || probe.value.source !== 'none') {
        t.skip(`environment cannot guarantee critique absence: ${JSON.stringify(probe.value)}`);
        return;
      }

      const verdictFile = path.join(sandbox.dir, 'verdict.md');
      fs.writeFileSync(verdictFile, APPROVED_BLOCK, 'utf8');

      const review = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', verdictFile])
      );
      assert.strictEqual(review.value, EXIT_CODE_SUCCESS);

      const next = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['next', '--issue', String(ISSUE), '--json'])
      );
      assert.strictEqual(next.value, EXIT_CODE_SUCCESS);

      const payload = JSON.parse(next.stdout);
      assert.strictEqual(payload.currentStage, 'COMMIT');
      assert.ok(
        payload.description.startsWith('Review passed.'),
        `the COMMIT gate must report the recorded verdict, got: ${payload.description}`
      );
      assert.ok(
        !payload.description.includes('No AI review verdict is recorded'),
        `the COMMIT gate must not claim the verdict is missing, got: ${payload.description}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P15: the reviewer\'s natural none phrasing records APPROVED and advances to COMMIT (issue #356)', async (t: any) => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const probe = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        new CliCritiqueGateway().resolveReviewer(sandbox.dir)
      );
      if (!probe.value || probe.value.source !== 'none') {
        t.skip(`environment cannot guarantee critique absence: ${JSON.stringify(probe.value)}`);
        return;
      }

      const verdictFile = path.join(sandbox.dir, 'verdict.md');
      fs.writeFileSync(verdictFile, MIXED_NONE_APPROVED_BLOCK, 'utf8');

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', verdictFile])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(
        run.value,
        EXIT_CODE_SUCCESS,
        `the reviewer APPROVED; exit 0 expected, got:\n${output}`
      );
      assert.ok(output.includes('APPROVED'), `the verdict must be reported, got:\n${output}`);
      assert.ok(
        !output.includes('AI Review requested changes'),
        `the reviewer's APPROVED was rewritten to CHANGES_REQUESTED, got:\n${output}`
      );

      const checkpoint = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(checkpoint.currentStage, 'COMMIT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'APPROVED');
      assert.strictEqual(last.metadata.reviewerVerdict, 'APPROVED');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P5: a SKIPPED verdict block exits 1 and writes NO verdict', async () => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const verdictFile = path.join(sandbox.dir, 'verdict.md');
      fs.writeFileSync(verdictFile, 'REVIEW_STATUS: SKIPPED\nREVIEW_SUMMARY: nope\n', 'utf8');

      const before = readCheckpoint(sandbox.dir, ISSUE);

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', verdictFile])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(
        output.includes('could not be parsed'),
        `the parse failure must be reported, got:\n${output}`
      );

      const after = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, before.currentStage, 'the checkpoint must be unchanged');
      assert.strictEqual(
        after.history.length,
        before.history.length,
        'no history entry may be written for a refused verdict'
      );
      assert.ok(
        !after.history.some((h: any) => h.metadata?.reviewVerdict),
        'no verdict may be recorded for a refused verdict'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P6: --review-output and --verdict-stdin feed the same seam', async () => {
    // --review-output (in-process).
    const inlineSandbox = makeSandbox('REVIEW');
    try {
      const run = await withSanitizedEnv(inlineSandbox.dir, inlineSandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--review-output', APPROVED_BLOCK])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);
      const checkpoint = readCheckpoint(inlineSandbox.dir, ISSUE);
      assert.strictEqual(checkpoint.currentStage, 'COMMIT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'APPROVED');
    } finally {
      fs.rmSync(inlineSandbox.dir, { recursive: true, force: true });
    }

    // --verdict-stdin (a child process, so the verdict really arrives on fd 0).
    const stdinSandbox = makeSandbox('REVIEW');
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'bin', 'codeloop.js'), 'review', '--issue', String(ISSUE), '--verdict-stdin'],
        {
          cwd: stdinSandbox.dir,
          input: CHANGES_REQUESTED_BLOCK,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: stdinSandbox.shadowPath,
            HOME: path.join(stdinSandbox.dir, '.home'),
            AGY_SUBAGENT: ''
          }
        }
      );
      const output = `${result.stdout}\n${result.stderr}`;
      assert.strictEqual(result.status, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      const checkpoint = readCheckpoint(stdinSandbox.dir, ISSUE);
      assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'CHANGES_REQUESTED');
    } finally {
      fs.rmSync(stdinSandbox.dir, { recursive: true, force: true });
    }
  });

  test('P7: `codeloop review` with no verdict runs the critique path and does not crash', async (t: any) => {    const sandbox = makeSandbox('REVIEW');
    try {
      const probe = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        new CliCritiqueGateway().resolveReviewer(sandbox.dir)
      );
      if (!probe.value || probe.value.source !== 'none') {
        t.skip(`environment cannot guarantee critique absence: ${JSON.stringify(probe.value)}`);
        return;
      }

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE)])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.ok(
        !output.includes('Unknown command'),
        `the review command must exist, got:\n${output}`
      );
      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);

      // With no critique and no reviewer output the #236 advisory fail-open
      // applies: SKIPPED -> COMMIT.
      const checkpoint = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(checkpoint.currentStage, 'COMMIT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'SKIPPED');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P8: a verdict can be recorded while the checkpoint rests at the COMMIT gate', async (t: any) => {
    // The LIVE case (issue #269): the commit gate reported "No AI review verdict
    // is recorded for this task" while the reviewer held a genuine APPROVED
    // verdict that had no channel to the checkpoint.
    const sandbox = makeSandbox('COMMIT');
    try {
      const probe = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        new CliCritiqueGateway().resolveReviewer(sandbox.dir)
      );
      if (!probe.value || probe.value.source !== 'none') {
        t.skip(`environment cannot guarantee critique absence: ${JSON.stringify(probe.value)}`);
        return;
      }

      const verdictFile = path.join(sandbox.dir, 'verdict.md');
      fs.writeFileSync(verdictFile, APPROVED_BLOCK, 'utf8');

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', verdictFile])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, `exit 0 expected, got:\n${output}`);

      const checkpoint = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(checkpoint.currentStage, 'COMMIT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'APPROVED');

      // The COMMIT gate now reports the ACTUAL verdict.
      const next = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['next', '--issue', String(ISSUE), '--json'])
      );
      const payload = JSON.parse(next.stdout);
      assert.ok(
        payload.description.startsWith('Review passed.'),
        `the COMMIT gate must report the recorded verdict, got: ${payload.description}`
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P9: --json emits a single JSON document describing the recorded verdict', async (t: any) => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const probe = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        new CliCritiqueGateway().resolveReviewer(sandbox.dir)
      );
      if (!probe.value || probe.value.source !== 'none') {
        t.skip(`environment cannot guarantee critique absence: ${JSON.stringify(probe.value)}`);
        return;
      }

      const verdictFile = path.join(sandbox.dir, 'verdict.md');
      fs.writeFileSync(verdictFile, APPROVED_BLOCK, 'utf8');

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', verdictFile, '--json'])
      );

      assert.strictEqual(run.value, EXIT_CODE_SUCCESS);
      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.verdict.status, 'APPROVED');
      assert.strictEqual(payload.verdictSource, 'reviewer-output');
      assert.strictEqual(payload.passed, true);
      assert.strictEqual(payload.currentStage, 'COMMIT');
      assert.strictEqual(payload.reviewVerdict, 'APPROVED');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Issue #269 (R1): a verdict flag that was PRESENT but carried no value.
  //
  // The flag used to be indistinguishable from "no flag at all": all three
  // sources stayed empty and the command fell through to the Tier 1 critique
  // path, which records a `SKIPPED` verdict — a SILENT downgrade of the
  // reviewer's real verdict, on the very channel that exists to prevent it.
  // ---------------------------------------------------------------------------

  test('P10: `--verdict-file` with no value fails loudly and records NO verdict', async () => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const before = readCheckpoint(sandbox.dir, ISSUE);

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file'])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(
        output.includes('--verdict-file'),
        `the failure must name the flag, got:\n${output}`
      );
      assert.ok(
        !output.includes('SKIPPED'),
        `the failure must not report a SKIPPED verdict, got:\n${output}`
      );

      const after = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, before.currentStage, 'the checkpoint must be unchanged');
      assert.strictEqual(
        after.history.length,
        before.history.length,
        'no history entry may be written for a refused verdict'
      );
      assert.ok(
        !after.history.some((h: any) => h.metadata?.reviewVerdict),
        'no verdict may be recorded for a refused verdict'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P11: `--review-output` with no value fails loudly and records NO verdict', async () => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const before = readCheckpoint(sandbox.dir, ISSUE);

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--review-output'])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(
        output.includes('--review-output'),
        `the failure must name the flag, got:\n${output}`
      );
      assert.ok(
        !output.includes('SKIPPED'),
        `the failure must not report a SKIPPED verdict, got:\n${output}`
      );

      const after = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, before.currentStage, 'the checkpoint must be unchanged');
      assert.strictEqual(
        after.history.length,
        before.history.length,
        'no history entry may be written for a refused verdict'
      );
      assert.ok(
        !after.history.some((h: any) => h.metadata?.reviewVerdict),
        'no verdict may be recorded for a refused verdict'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P12: the empty `=` form and a flag-following value fail just as loudly', async () => {
    // `--verdict-file=` — the value is present but EMPTY.
    const equalsSandbox = makeSandbox('REVIEW');
    try {
      const run = await withSanitizedEnv(equalsSandbox.dir, equalsSandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file='])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(output.includes('--verdict-file'), `the failure must name the flag, got:\n${output}`);

      const after = readCheckpoint(equalsSandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, 'REVIEW', 'the checkpoint must be unchanged');
      assert.ok(
        !after.history.some((h: any) => h.metadata?.reviewVerdict),
        'no verdict may be recorded for a refused verdict'
      );
    } finally {
      fs.rmSync(equalsSandbox.dir, { recursive: true, force: true });
    }

    // `--verdict-file --json` — the next token is another flag, so the value
    // was omitted.
    const followedSandbox = makeSandbox('REVIEW');
    try {
      const run = await withSanitizedEnv(followedSandbox.dir, followedSandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', '--json'])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(output.includes('--verdict-file'), `the failure must name the flag, got:\n${output}`);

      const after = readCheckpoint(followedSandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, 'REVIEW', 'the checkpoint must be unchanged');
      assert.ok(
        !after.history.some((h: any) => h.metadata?.reviewVerdict),
        'no verdict may be recorded for a refused verdict'
      );
    } finally {
      fs.rmSync(followedSandbox.dir, { recursive: true, force: true });
    }
  });

  test('P13: `--verdict-file` pointing at a nonexistent path still fails loudly', async () => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const before = readCheckpoint(sandbox.dir, ISSUE);

      const missing = path.join(sandbox.dir, 'no-such-verdict.md');
      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli(['review', '--issue', String(ISSUE), '--verdict-file', missing])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(
        output.includes('Could not read the reviewer verdict'),
        `the read failure must be reported, got:\n${output}`
      );
      assert.ok(
        !output.includes('SKIPPED'),
        `the failure must not report a SKIPPED verdict, got:\n${output}`
      );

      const after = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, before.currentStage, 'the checkpoint must be unchanged');
      assert.strictEqual(
        after.history.length,
        before.history.length,
        'no history entry may be written for an unreadable verdict'
      );
      assert.ok(
        !after.history.some((h: any) => h.metadata?.reviewVerdict),
        'no verdict may be recorded for an unreadable verdict'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('P14: `--verdict-stdin` with an EMPTY stdin fails loudly and records NO verdict', async () => {
    // A verdict was requested on stdin and NONE arrived — the same silent
    // SKIPPED hole as a present-but-valueless flag, so it fails loudly too.
    const sandbox = makeSandbox('REVIEW');
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'bin', 'codeloop.js'), 'review', '--issue', String(ISSUE), '--verdict-stdin'],
        {
          cwd: sandbox.dir,
          input: '',
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: sandbox.shadowPath,
            HOME: path.join(sandbox.dir, '.home'),
            AGY_SUBAGENT: ''
          }
        }
      );
      const output = `${result.stdout}\n${result.stderr}`;
      assert.strictEqual(result.status, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(
        output.includes('--verdict-stdin'),
        `the failure must name the flag, got:\n${output}`
      );
      assert.ok(
        !output.includes('SKIPPED'),
        `the failure must not report a SKIPPED verdict, got:\n${output}`
      );

      const after = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, 'REVIEW', 'the checkpoint must be unchanged');
      assert.ok(
        !after.history.some((h: any) => h.metadata?.reviewVerdict),
        'no verdict may be recorded for a refused verdict'
      );
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Issue #297: a supplied verdict cannot disable Tier 1. `--critique-report`
  // is the hermetic evidence channel that makes this testable without a host
  // `critique` binary.
  // -------------------------------------------------------------------------

  function writeVerdict(dir: string, block: string): string {
    const file = path.join(dir, 'verdict.md');
    fs.writeFileSync(file, block, 'utf8');
    return file;
  }

  function writeCritique(dir: string, payload: unknown, name = 'critique.json'): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
    return file;
  }

  const CLEAN_CRITIQUE = {
    summary: 'Clean automated review',
    confidenceLevel: 'High',
    confidenceExplanation: 'diff verified',
    comments: []
  };

  const ERROR_CRITIQUE = {
    summary: 'Automated critique found a blocking defect',
    confidenceLevel: 'High',
    confidenceExplanation: 'static scan',
    comments: [
      {
        path: 'src/index.ts',
        line: 1,
        rule: 'blocking-defect',
        message: 'Forged blocking defect',
        severity: 'error'
      }
    ]
  };

  test('CV1: `--verdict-file APPROVED` beside an error finding exits non-zero and records CHANGES_REQUESTED', async () => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const verdictFile = writeVerdict(sandbox.dir, APPROVED_BLOCK);
      const critiqueFile = writeCritique(sandbox.dir, ERROR_CRITIQUE);

      const run = await withSanitizedEnv(sandbox.dir, sandbox.shadowPath, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report',
          critiqueFile
        ])
      );

      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(output.includes('CHANGES_REQUESTED'), output);

      const checkpoint = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'CHANGES_REQUESTED');
      assert.strictEqual(last.metadata.reviewSource, 'reviewer-output+critique-escalation');
      assert.strictEqual(last.metadata.reviewerVerdict, 'APPROVED');
      assert.strictEqual(last.metadata.critiqueVerified, true);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('CV2: a clean `--critique-report` records APPROVED with critiqueVerified=true', async () => {
    const humanSandbox = makeSandbox('REVIEW');
    try {
      const verdictFile = writeVerdict(humanSandbox.dir, APPROVED_BLOCK);
      const critiqueFile = writeCritique(humanSandbox.dir, CLEAN_CRITIQUE);

      const run = await withSanitizedEnv(humanSandbox.dir, humanSandbox.shadowPath, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report',
          critiqueFile
        ])
      );

      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, run.stderr);
      assert.match(run.stdout, /Critique Verified\s*:\s*true/);
      assert.strictEqual(readCheckpoint(humanSandbox.dir, ISSUE).currentStage, 'COMMIT');
    } finally {
      fs.rmSync(humanSandbox.dir, { recursive: true, force: true });
    }

    const jsonSandbox = makeSandbox('REVIEW');
    try {
      const verdictFile = writeVerdict(jsonSandbox.dir, APPROVED_BLOCK);
      const critiqueFile = writeCritique(jsonSandbox.dir, CLEAN_CRITIQUE);

      const run = await withSanitizedEnv(jsonSandbox.dir, jsonSandbox.shadowPath, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report',
          critiqueFile,
          '--json'
        ])
      );

      assert.strictEqual(run.value, EXIT_CODE_SUCCESS, run.stderr);
      const payload = JSON.parse(run.stdout);
      assert.strictEqual(payload.critiqueVerified, true);
      assert.strictEqual(payload.reviewerVerdict, 'APPROVED');
    } finally {
      fs.rmSync(jsonSandbox.dir, { recursive: true, force: true });
    }
  });

  test('CV3: a missing, unreadable, or unparseable `--critique-report` records nothing', async () => {
    // A present-but-valueless flag.
    const missingValueSandbox = makeSandbox('REVIEW');
    try {
      const before = readCheckpoint(missingValueSandbox.dir, ISSUE);
      const verdictFile = writeVerdict(missingValueSandbox.dir, APPROVED_BLOCK);
      const run = await withSanitizedEnv(missingValueSandbox.dir, missingValueSandbox.shadowPath, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report'
        ])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, output);
      assert.ok(output.includes('--critique-report'), output);
      const after = readCheckpoint(missingValueSandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, before.currentStage);
      assert.strictEqual(after.history.length, before.history.length);
    } finally {
      fs.rmSync(missingValueSandbox.dir, { recursive: true, force: true });
    }

    // A path that does not exist.
    const nonexistentSandbox = makeSandbox('REVIEW');
    try {
      const before = readCheckpoint(nonexistentSandbox.dir, ISSUE);
      const verdictFile = writeVerdict(nonexistentSandbox.dir, APPROVED_BLOCK);
      const run = await withSanitizedEnv(nonexistentSandbox.dir, nonexistentSandbox.shadowPath, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report',
          path.join(nonexistentSandbox.dir, 'no-such-critique.json')
        ])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, output);
      // Issue #400: a missing file is the signature of a crashed critique run,
      // not a malformed payload — the message must name the read, not the parse.
      assert.ok(output.includes('could not be read'), output);
      assert.ok(output.includes('--critique-report'), output);
      assert.ok(!output.includes('could not be parsed'), output);
      const after = readCheckpoint(nonexistentSandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, before.currentStage);
      assert.strictEqual(after.history.length, before.history.length);
    } finally {
      fs.rmSync(nonexistentSandbox.dir, { recursive: true, force: true });
    }

    // A file that exists but carries no evidence at all.
    const emptySandbox = makeSandbox('REVIEW');
    try {
      const before = readCheckpoint(emptySandbox.dir, ISSUE);
      const verdictFile = writeVerdict(emptySandbox.dir, APPROVED_BLOCK);
      const empty = path.join(emptySandbox.dir, 'critique.json');
      fs.writeFileSync(empty, '', 'utf8');

      const run = await withSanitizedEnv(emptySandbox.dir, emptySandbox.shadowPath, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report',
          empty
        ])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, output);
      assert.ok(output.includes('is empty'), output);
      assert.ok(!output.includes('could not be parsed'), output);
      const after = readCheckpoint(emptySandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, before.currentStage);
      assert.strictEqual(after.history.length, before.history.length);
    } finally {
      fs.rmSync(emptySandbox.dir, { recursive: true, force: true });
    }

    // A file that is not JSON.
    const garbageSandbox = makeSandbox('REVIEW');
    try {
      const before = readCheckpoint(garbageSandbox.dir, ISSUE);
      const verdictFile = writeVerdict(garbageSandbox.dir, APPROVED_BLOCK);
      const garbage = path.join(garbageSandbox.dir, 'critique.json');
      fs.writeFileSync(garbage, 'this is not a critique report', 'utf8');

      const run = await withSanitizedEnv(garbageSandbox.dir, garbageSandbox.shadowPath, async () =>
        runCli([
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report',
          garbage
        ])
      );
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.value, EXIT_CODE_FAILURE, output);
      assert.ok(output.includes('could not be parsed'), output);
      const after = readCheckpoint(garbageSandbox.dir, ISSUE);
      assert.strictEqual(after.currentStage, before.currentStage);
      assert.strictEqual(after.history.length, before.history.length);
      assert.ok(!after.history.some((h: any) => h.metadata?.reviewVerdict));
    } finally {
      fs.rmSync(garbageSandbox.dir, { recursive: true, force: true });
    }
  });

  test('CV4: `--critique-report -` reads the same evidence from stdin', async () => {
    const sandbox = makeSandbox('REVIEW');
    try {
      const verdictFile = writeVerdict(sandbox.dir, APPROVED_BLOCK);

      const result = spawnSync(
        process.execPath,
        [
          path.join(REPO_ROOT, 'bin', 'codeloop.js'),
          'review',
          '--issue',
          String(ISSUE),
          '--verdict-file',
          verdictFile,
          '--critique-report',
          '-'
        ],
        {
          cwd: sandbox.dir,
          input: JSON.stringify(ERROR_CRITIQUE),
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: sandbox.shadowPath,
            HOME: path.join(sandbox.dir, '.home'),
            AGY_SUBAGENT: ''
          }
        }
      );

      const output = `${result.stdout}\n${result.stderr}`;
      assert.strictEqual(result.status, EXIT_CODE_FAILURE, `exit 1 expected, got:\n${output}`);
      assert.ok(output.includes('CHANGES_REQUESTED'), output);

      const checkpoint = readCheckpoint(sandbox.dir, ISSUE);
      assert.strictEqual(checkpoint.currentStage, 'IMPLEMENT');
      const last = checkpoint.history[checkpoint.history.length - 1];
      assert.strictEqual(last.metadata.reviewVerdict, 'CHANGES_REQUESTED');
      assert.strictEqual(last.metadata.reviewSource, 'reviewer-output+critique-escalation');
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
