/**
 * agyloop - `FileConfigRepository` workspace resolution (#333 AC2)
 *
 * The defect: the workspace layer was built strictly from `path.join(cwd, …)`
 * for the one directory the caller handed in. A command run from a nested
 * subdirectory or from inside `.worktrees/<task-id>` therefore dropped `git`
 * and `verification` — the sections `codeloop init` writes.
 *
 * CFG-333-1 nested subdirectory resolves the workspace config
 * CFG-333-2 a linked worktree resolves the main checkout config
 * CFG-333-3 the nearest config wins over an ancestor
 * CFG-333-4 the upward walk stops at the checkout boundary
 * CFG-333-5 git and verification survive the worktree merge
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { FileConfigRepository } = require('../../dist/infrastructure');

const SANDBOXES: string[] = [];

afterEach(() => {
  for (const dir of SANDBOXES) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  SANDBOXES.length = 0;
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-config-resolution-'));
  SANDBOXES.push(dir);
  return dir;
}

/** A real git repository (branch `main`) with one commit. */
function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'chore: seed'], { cwd: dir });
}

/** Writes `.codeloop/config.json` under `dir`. */
function writeConfig(dir: string, config: unknown): void {
  const configDir = path.join(dir, '.codeloop');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

describe('FileConfigRepository workspace resolution (#333 AC2)', () => {
  test('CFG-333-1 loadConfig walks up from a nested subdirectory (#333 AC2)', () => {
    const root = sandbox();
    makeRepo(root);
    writeConfig(root, {
      git: { remote: 'origin', baseBranch: 'develop', forge: 'generic' },
      verification: {
        gates: [{ id: 'nested', label: 'Nested Gate', command: 'echo AC-333-NESTED' }]
      }
    });

    const nested = path.join(root, 'src', 'nested');
    fs.mkdirSync(nested, { recursive: true });

    const loaded = new FileConfigRepository().loadConfig({ cwd: nested });

    assert.strictEqual(loaded.git.baseBranch, 'develop');
    assert.strictEqual(loaded.verification.gates[0].command, 'echo AC-333-NESTED');
  });

  test('CFG-333-2 loadConfig resolves the main checkout config from a linked worktree (#333 AC2)', () => {
    const root = sandbox();
    makeRepo(root);
    writeConfig(root, {
      git: { remote: 'origin', baseBranch: 'develop', forge: 'generic' },
      verification: {
        gates: [{ id: 'wt', label: 'Worktree Gate', command: 'echo AC-333-WORKTREE' }]
      }
    });

    const worktreePath = path.join(root, '.worktrees', '333');
    execFileSync('git', ['worktree', 'add', '-q', worktreePath, '-b', 'task/333', 'main'], {
      cwd: root
    });

    // The linked worktree has its own working tree and no `.codeloop` of its own.
    assert.ok(!fs.existsSync(path.join(worktreePath, '.codeloop')));

    const loaded = new FileConfigRepository().loadConfig({ cwd: worktreePath });

    assert.strictEqual(loaded.git.baseBranch, 'develop');
    assert.strictEqual(loaded.verification.gates.length, 1);
  });

  test('CFG-333-3 the nearest config wins over an ancestor (#333 AC2)', () => {
    const root = sandbox();
    makeRepo(root);
    writeConfig(root, { models: { planner: 'pro' } });

    const nested = path.join(root, 'src', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    writeConfig(nested, { models: { planner: 'flash' } });

    const loaded = new FileConfigRepository().loadConfig({ cwd: nested });

    assert.strictEqual(loaded.models.planner, 'flash');
  });

  test('CFG-333-4 the upward walk stops at the checkout boundary (#333 AC2)', () => {
    const base = sandbox();
    // An ancestor config that MUST NOT leak into the checkout below it.
    writeConfig(base, {
      models: { planner: 'flash' },
      git: { baseBranch: 'leaked-branch' }
    });

    const checkout = path.join(base, 'checkout');
    makeRepo(checkout);
    const nested = path.join(checkout, 'src');
    fs.mkdirSync(nested, { recursive: true });

    const loaded = new FileConfigRepository().loadConfig({ cwd: nested });

    assert.strictEqual(loaded.git, undefined);
    assert.strictEqual(loaded.models.planner, 'pro');
  });

  test('CFG-333-5 git and verification survive the worktree merge (#333 AC2)', () => {
    const root = sandbox();
    makeRepo(root);
    writeConfig(root, {
      git: { remote: 'origin', baseBranch: 'develop', forge: 'github' },
      verification: {
        gates: [{ id: 'merge', label: 'Merge Gate', command: 'echo AC-333-MERGE' }]
      }
    });

    const worktreePath = path.join(root, '.worktrees', '333');
    execFileSync('git', ['worktree', 'add', '-q', worktreePath, '-b', 'task/333', 'main'], {
      cwd: root
    });

    const loaded = new FileConfigRepository().loadConfig({ cwd: worktreePath });

    assert.deepStrictEqual(loaded.git, {
      remote: 'origin',
      baseBranch: 'develop',
      forge: 'github'
    });
  });
});
