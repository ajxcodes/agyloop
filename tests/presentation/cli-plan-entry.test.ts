/**
 * agyloop - Plan entry stage through the CLI (issue #379)
 *
 * PE-CLI1: a bug issue parks at DISCOVERY and hands the operator a real
 *          discovery dispatch — it never claims to have advanced to PLAN.
 * PE-CLI2: a feature issue keeps today's `Pipeline advanced to [PLAN]`.
 * PE-CLI3: an explicit `--type` selects the entry stage on either side.
 * PE-CLI4: `--dry-run` promises the park and writes nothing.
 *
 * Everything runs offline: no issue lookup, the title markers carry the kind.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../../dist/presentation/cli');

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function makeSandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-cli-plan-entry-'));
}

function taskStatePath(dir: string, issue: number): string {
  return path.join(dir, '.agyloop', 'tasks', `${issue}.json`);
}

function readTaskState(dir: string, issue: number): any {
  try {
    return JSON.parse(fs.readFileSync(taskStatePath(dir, issue), 'utf8'));
  } catch {
    return null;
  }
}

async function runCliIn(dir: string, args: readonly string[]) {
  const prevCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = '';
  let stderr = '';
  try {
    process.chdir(dir);
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
  }
}

describe('plan entry stage through the CLI (issue #379)', () => {
  test('PE-CLI1: a bug title parks at DISCOVERY with a discovery dispatch', async () => {
    const dir = makeSandbox();
    try {
      const run = await runCliIn(dir, ['plan', '--issue', '381', '--title', '[Bug] login crash']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Parked at DISCOVERY/, run.stdout);
      assert.match(run.stdout, /Subagent\s+: discovery/, run.stdout);
      assert.doesNotMatch(run.stdout, /Pipeline advanced to \[PLAN\]/, run.stdout);

      const persisted = readTaskState(dir, 381);
      assert.strictEqual(persisted?.currentStage, 'DISCOVERY');
      assert.ok(
        !(persisted?.history ?? []).some((h: any) => h.stage === 'PLAN'),
        'a bug entry must record no PLAN transition'
      );

      const next = await runCliIn(dir, ['next', '--json']);
      assert.strictEqual(next.code, 0, next.stderr);
      const directive = JSON.parse(next.stdout.trim());
      assert.strictEqual(directive.currentStage, 'DISCOVERY');
      assert.strictEqual(directive.role, 'discovery');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PE-CLI2: a feature title still advances to PLAN', async () => {
    const dir = makeSandbox();
    try {
      const run = await runCliIn(dir, ['plan', '--issue', '383', '--title', 'Feature Plan']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Pipeline advanced to \[PLAN\]/, run.stdout);
      assert.doesNotMatch(run.stdout, /Parked at DISCOVERY/, run.stdout);
      assert.doesNotMatch(run.stdout, /Subagent\s+: discovery/, run.stdout);
      assert.strictEqual(readTaskState(dir, 383)?.currentStage, 'PLAN');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PE-CLI3: an explicit --type selects the entry stage on either side', async () => {
    const discoveryDir = makeSandbox();
    try {
      const discovery = await runCliIn(discoveryDir, [
        'plan',
        '--issue',
        '384',
        '--type',
        'discovery',
        '--title',
        'Feature but explicit RCA'
      ]);
      assert.strictEqual(discovery.code, 0, discovery.stderr);
      assert.match(discovery.stdout, /Parked at DISCOVERY/, discovery.stdout);
      assert.strictEqual(readTaskState(discoveryDir, 384)?.currentStage, 'DISCOVERY');
    } finally {
      fs.rmSync(discoveryDir, { recursive: true, force: true });
    }

    const implementationDir = makeSandbox();
    try {
      const implementation = await runCliIn(implementationDir, [
        'plan',
        '--issue',
        '382',
        '--type',
        'implementation',
        '--title',
        '[Bug] but explicit plan'
      ]);
      assert.strictEqual(implementation.code, 0, implementation.stderr);
      assert.match(implementation.stdout, /Pipeline advanced to \[PLAN\]/, implementation.stdout);
      assert.strictEqual(readTaskState(implementationDir, 382)?.currentStage, 'PLAN');
    } finally {
      fs.rmSync(implementationDir, { recursive: true, force: true });
    }
  });

  test('PE-CLI4: --dry-run promises the park and writes nothing', async () => {
    const dir = makeSandbox();
    try {
      const run = await runCliIn(dir, [
        'plan',
        '--issue',
        '385',
        '--title',
        '[Bug] dry run probe',
        '--dry-run'
      ]);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /\[DRY RUN\] Would park at DISCOVERY/, run.stdout);
      assert.match(run.stdout, /Stage unchanged/, run.stdout);
      assert.match(run.stdout, /No checkpoint was written/, run.stdout);
      assert.doesNotMatch(run.stdout, /State is checkpointed/, run.stdout);
      assert.strictEqual(fs.existsSync(taskStatePath(dir, 385)), false);
      assert.strictEqual(fs.existsSync(path.join(dir, 'artifacts')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Issue #382 (D4 nit) — the first-run park names the command to run next.
 *
 * "then re-run" told the operator to re-run *something*. After the report is
 * populated, `next` already says `Advance with codeloop plan --issue <n>`; the
 * park message must name the same command.
 */
describe('first-run park names the command (issue #382)', () => {
  test('PE-CLI5: the dry-run park literal names `codeloop plan --issue <n>` and writes nothing', async () => {
    const dir = makeSandbox();
    try {
      const run = await runCliIn(dir, [
        'plan',
        '--issue',
        '385',
        '--title',
        '[Bug] park probe',
        '--dry-run'
      ]);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /codeloop plan --issue <n>/, run.stdout);
      assert.match(run.stdout, /\[DRY RUN\] Would park at DISCOVERY/, run.stdout);
      assert.doesNotMatch(run.stdout, /then re-run/, run.stdout);
      assert.strictEqual(fs.existsSync(taskStatePath(dir, 385)), false);
      assert.strictEqual(fs.existsSync(path.join(dir, 'artifacts')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PE-CLI6: the real park note names the same command', async () => {
    const dir = makeSandbox();
    try {
      const run = await runCliIn(dir, ['plan', '--issue', '386', '--title', '[Bug] park note probe']);

      assert.strictEqual(run.code, 0, run.stderr);
      assert.match(run.stdout, /Parked at DISCOVERY/, run.stdout);
      assert.match(run.stdout, /codeloop plan --issue <n>/, run.stdout);
      assert.doesNotMatch(run.stdout, /then re-run/, run.stdout);
      assert.strictEqual(readTaskState(dir, 386)?.currentStage, 'DISCOVERY');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
