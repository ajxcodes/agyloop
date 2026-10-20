/**
 * agyloop - yolo AI-review SKIPPED e2e through runCli (issue #236, AC1/AC2)
 *
 * A clean yolo run with passing gates and NO reviewer output + NO critique
 * report must:
 *   - exit 0 (never EXIT_CODE_FAILURE on the basis of a fabricated rejection),
 *   - print a distinct `⚠ AI PR Review: SKIPPED` advisory with remediation
 *     (`codeloop critique install`),
 *   - never print `AI Review requested changes` / `AI PR Review: CHANGES_REQUESTED`
 *     / `Pipeline reverted to`,
 *   - persist `currentStage=COMMIT` with a `reviewVerdict: SKIPPED` history entry
 *     and NO `selfCorrectionPayload`.
 *
 * Harness: in-process `runCli` sandbox copied from cli-yolo-discovery.test.ts
 * (#234), extended with:
 *   - `git init` + stub package.json gates (`typecheck`/`test` echo scripts),
 *   - an environment sanitation pass (HOME/XDG/AGY_SUBAGENT scrub + a shadow PATH
 *     that contains every original PATH entry except a `critique` executable),
 *   - a hard precondition probe: if critique still resolves to anything other
 *     than `source: 'none'` the test SKIPS with an explicit message — it must
 *     never silently pass.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runCli } = require('../../dist/presentation/cli');
const { EXIT_CODE_SUCCESS } = require('../../dist/domain');
const { CliCritiqueGateway } = require('../../dist/infrastructure');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
const CRITIQUE_BINARY = 'critique';

const SOURCE_FILE = 'src-target.js';
const SOURCE_BASELINE = 'export function answer() { return 42; };\n';
const SOURCE_IMPLEMENTED = 'export function answer() { return 7; };\n';

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
 * Builds a shadow directory mirroring every PATH entry, excluding any file named
 * `critique` (CliCritiqueGateway.findInSystemPath resolves it by existence, not
 * by executable bit). Directories without a critique entry are symlinked whole;
 * contaminated directories are rebuilt entry-by-entry with real-path symlinks.
 * Returns a PATH string whose entries are the shadow's per-directory mirrors.
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

function setupProbeRepo(tempDir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: tempDir, stdio: 'ignore' });
  fs.writeFileSync(
    path.join(tempDir, 'package.json'),
    JSON.stringify({
      name: 'probe',
      scripts: {
        typecheck: 'echo TYPECHECK_OK',
        test: 'echo TEST_OK'
      }
    }),
    'utf8'
  );
  // The source file belongs to the repository: it is COMMITTED, so a later edit
  // to it is a TRACKED change (issue #259) rather than an untracked file.
  fs.writeFileSync(path.join(tempDir, SOURCE_FILE), SOURCE_BASELINE, 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: tempDir, stdio: 'ignore' });

  // Issue #259: the implementation the fast-path is supposed to validate.
  // The quality gate now refuses to certify an UNCHANGED tree, so the sandbox
  // must carry a real (tracked) source change for this run to reach the COMMIT
  // gate and exercise the #236 SKIPPED advisory end-to-end.
  fs.writeFileSync(path.join(tempDir, SOURCE_FILE), SOURCE_IMPLEMENTED, 'utf8');

  fs.mkdirSync(path.join(tempDir, '.home'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '.xdg'), { recursive: true });
}

/**
 * Runs `fn` with the sanitized environment applied (HOME/XDG/AGY_SUBAGENT scrub +
 * critique-free shadow PATH), restoring cwd/env/console afterwards. Returns the
 * callback value together with the console streams captured during the run.
 */
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

describe('codeloop yolo with absent critique => SKIPPED advisory (issue #236)', () => {
  test('exits 0, prints the SKIPPED advisory, and checkpoints at COMMIT without reverting', async (t: any) => {
    const sandbox: string = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-yolo-review-skipped-'));

    try {
      setupProbeRepo(sandbox);
      const shadowPath = buildCritiqueFreePathShadow(path.join(sandbox, '.shadow-bin'));

      // Precondition: critique must be entirely absent under the sanitized env.
      const probe = await withSanitizedEnv(sandbox, shadowPath, async () => {
        return new CliCritiqueGateway().resolveReviewer(sandbox);
      });
      const resolution: any = probe.value;
      if (!resolution || resolution.source !== 'none') {
        t.skip(
          `environment cannot guarantee critique absence: resolveReviewer => ${JSON.stringify(resolution)}`
        );
        return;
      }

      const run = await withSanitizedEnv(sandbox, shadowPath, async () => {
        return { code: await runCli(['yolo', '--title', 'Feature: probe']) };
      });
      const runResult: any = run.value;
      const stdout: string = run.stdout;
      const stderr: string = run.stderr;
      const output = `${stdout}\n${stderr}`;

      // AC1: exit 0 — never exit 1 on the basis of a fabricated rejection.
      assert.strictEqual(
        runResult.code,
        EXIT_CODE_SUCCESS,
        `exit 0 expected; stdout=${stdout} stderr=${stderr}`
      );

      // AC2: distinct, actionable advisory signal.
      assert.ok(
        output.includes('AI PR Review: SKIPPED'),
        `expected the SKIPPED advisory, got:\n${output}`
      );
      assert.ok(
        output.includes('codeloop critique install'),
        `expected remediation guidance, got:\n${output}`
      );
      assert.ok(output.includes('⚠'), `expected a warning marker, got:\n${output}`);

      // AC1: never a fabricated rejection or a revert.
      assert.ok(
        !output.includes('AI Review requested changes'),
        `must not claim review requested changes:\n${output}`
      );
      assert.ok(
        !output.includes('AI PR Review: CHANGES_REQUESTED'),
        `must not print CHANGES_REQUESTED:\n${output}`
      );
      assert.ok(
        !output.includes('Pipeline reverted to'),
        `must not revert the pipeline:\n${output}`
      );

      // Persisted state: COMMIT checkpoint with SKIPPED verdict, no payload.
      const persisted = readState(sandbox);
      assert.ok(persisted, `state.json must exist under ${sandbox}`);
      assert.strictEqual(persisted.currentStage, 'COMMIT', `state=${JSON.stringify(persisted)}`);
      const history = persisted.history ?? [];
      const lastEntry = history[history.length - 1];
      assert.ok(lastEntry, 'history must contain at least one entry');
      assert.strictEqual(lastEntry.stage, 'COMMIT');
      assert.strictEqual(lastEntry.metadata?.reviewVerdict, 'SKIPPED');
      assert.ok(
        !('selfCorrectionPayload' in (lastEntry.metadata ?? {})),
        `skipped review must not record a self-correction payload: ${JSON.stringify(lastEntry.metadata)}`
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
