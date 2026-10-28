/**
 * agyloop - `release --dry-run` reports the range it validated (issue #315,
 * AC-30/AC-32, absorbing #294)
 *
 * Two failures this file pins:
 *   - an unresolvable base ref was reported as "nothing to release" — a
 *     success-shaped answer for a git failure;
 *   - the dry-run report was decorated with hard-coded ANSI even when stdout
 *     was a pipe, and never named the range it had just computed.
 *
 * Full CLI, real git repo. `gh` is absent on purpose: the dry run must not need
 * a remote mutation, and the gateway's inspection failures are non-fatal.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface Sandbox {
  readonly dir: string;
  readonly phaseBranch: string;
}

function makeSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-release-report-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'smoke@test']);
  git(['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'chore: seed']);

  const phaseBranch = 'phase/6-smoke';
  git(['checkout', '-qb', phaseBranch]);
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'feat(release): add the thing']);
  fs.writeFileSync(path.join(dir, 'fix.txt'), 'fix\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'fix(release): handle the thing']);

  fs.mkdirSync(path.join(dir, '.home'), { recursive: true });
  return { dir, phaseBranch };
}

function runRelease(sandbox: Sandbox, args: string[]) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'codeloop.js'), 'release', ...args], {
    cwd: sandbox.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: path.join(sandbox.dir, '.home'),
      AGY_SUBAGENT: ''
    }
  });
}

describe('release --dry-run reports the validated range (AC-30)', () => {
  test('a piped report is plain text and names the range it computed', () => {
    const sandbox = makeSandbox();
    try {
      const run = runRelease(sandbox, [
        sandbox.phaseBranch,
        '--base-branch',
        'main',
        '--dry-run'
      ]);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);

      assert.ok(
        !run.stdout.includes('\x1b['),
        `a piped report must not emit ANSI escapes, got:\n${JSON.stringify(run.stdout)}`
      );
      assert.match(
        run.stdout,
        new RegExp(`Range\\s*:\\s*2 commits from main\\.\\.${sandbox.phaseBranch.replace('/', '\\/')}`)
      );
      assert.match(run.stdout, /Commit Metrics\s*: .*deliverables/);
      assert.match(run.stdout, /commit objects/);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('the dry run names the cross-repo Release-notes dependency (AC-32)', () => {
    const sandbox = makeSandbox();
    try {
      const run = runRelease(sandbox, [
        sandbox.phaseBranch,
        '--base-branch',
        'main',
        '--dry-run'
      ]);
      const output = `${run.stdout}\n${run.stderr}`;
      assert.strictEqual(run.status, 0, output);
      assert.match(output, /ajxcodes\/auto-tag/);
      assert.match(output, /not fixed here/);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });

  test('an unresolvable base ref exits non-zero and is never "nothing to release" (AC-28, AC-31)', () => {
    const sandbox = makeSandbox();
    try {
      const run = runRelease(sandbox, [
        sandbox.phaseBranch,
        '--base-branch',
        'nosuchbranch-315',
        '--dry-run'
      ]);
      const output = `${run.stdout}\n${run.stderr}`;

      assert.notStrictEqual(run.status, 0, `an unresolved ref must fail, got:\n${output}`);
      assert.match(output, /Cannot resolve base ref 'nosuchbranch-315'/);
      assert.doesNotMatch(output, /has no new commits/);
      // The range was never computed, so no Range line may claim one.
      assert.doesNotMatch(run.stdout, /Range\s*:/);
    } finally {
      fs.rmSync(sandbox.dir, { recursive: true, force: true });
    }
  });
});
