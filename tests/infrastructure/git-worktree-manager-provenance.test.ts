/**
 * agyloop - GitWorktreeManager provisioning-state probe (issue #426)
 *
 * The refusal teardown turns "nothing existed before provisioning" into "this
 * invocation created it" and DELETES. That decision may only be taken on a
 * truthful answer, so the probe must report a failed `git` read as `null` —
 * never as `[]` — while the published `listWorktrees`/`listBranches` keep their
 * `[]`-on-failure contract exactly as they were.
 */

const { after, describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitWorktreeManager } = require('../../dist/infrastructure');

import type { CommandExecutorPort, CommandExecutionResult } from '../../src/ports';

function makeResult(cmd: string, partial: Partial<CommandExecutionResult> = {}): CommandExecutionResult {
  return {
    command: cmd,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 5,
    combinedOutput: '',
    ...partial
  };
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-provenance-'));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

after(() => {
  for (const tmpDir of tmpDirs) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** Every fake executor records its commands so "no `-a` was requested" is observable. */
function makeManager(
  answer: (cmd: string) => CommandExecutionResult
): { manager: any; commands: string[] } {
  const commands: string[] = [];
  const mockExecutor: CommandExecutorPort = {
    execute: async (cmd: string): Promise<CommandExecutionResult> => {
      commands.push(cmd);
      return answer(cmd);
    }
  };
  return { manager: new GitWorktreeManager(mockExecutor), commands };
}

function rootBlock(root: string): string {
  return [
    `worktree ${root}`,
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    ''
  ].join('\n');
}

function linkedBlock(worktreePath: string, branch = 'task/9'): string {
  return [
    `worktree ${worktreePath}`,
    'HEAD 2222222222222222222222222222222222222222',
    `branch refs/heads/${branch}`,
    ''
  ].join('\n');
}

/** Joins porcelain blocks the way `git worktree list --porcelain` separates them. */
function porcelain(...blocks: string[]): string {
  return blocks.join('\n');
}

describe('probeProvisioningState distinguishes a failed read from an empty registry (#426)', () => {
  test('WT-426-1: a failed registry read is null, not []', async () => {
    const tmpDir = makeTmpDir();
    const { manager } = makeManager((cmd) => {
      if (cmd === 'git worktree list --porcelain') {
        return makeResult(cmd, {
          exitCode: 128,
          stderr: 'fatal: could not read the worktree registry'
        });
      }
      if (cmd.includes('git branch')) {
        return makeResult(cmd, { stdout: 'main\n' });
      }
      return makeResult(cmd);
    });

    const probe = await manager.probeProvisioningState({ workspaceDir: tmpDir });

    assert.strictEqual(
      probe.worktreePaths,
      null,
      'a failed registry read must be UNKNOWN (null), never "nothing existed"'
    );
    assert.deepStrictEqual(probe.localBranches, ['main']);
    // The public contract is frozen: a failed read is still `[]` for callers
    // that predate the probe.
    assert.deepStrictEqual(await manager.listWorktrees({ workspaceDir: tmpDir }), []);
  });

  test('WT-426-2: a successful empty registry is [] and is not null', async () => {
    const tmpDir = makeTmpDir();
    const { manager } = makeManager((cmd) => {
      if (cmd === 'git worktree list --porcelain') {
        return makeResult(cmd, { stdout: rootBlock(tmpDir) });
      }
      if (cmd.includes('git branch')) {
        return makeResult(cmd, { stdout: 'main\n' });
      }
      return makeResult(cmd);
    });

    const probe = await manager.probeProvisioningState({ workspaceDir: tmpDir });

    assert.notStrictEqual(probe.worktreePaths, null, 'a successful read is trusted evidence');
    assert.deepStrictEqual(probe.worktreePaths, []);
    assert.deepStrictEqual(probe.localBranches, ['main']);
  });

  test('WT-426-3: external registrations are visible to the probe', async () => {
    const tmpDir = makeTmpDir();
    const internal = path.join(tmpDir, '.worktrees', '9');
    const external = '/elsewhere/adopted';
    const { manager } = makeManager((cmd) => {
      if (cmd === 'git worktree list --porcelain') {
        return makeResult(cmd, {
          stdout: porcelain(rootBlock(tmpDir), linkedBlock(internal), linkedBlock(external, 'feature/x'))
        });
      }
      if (cmd.includes('git branch')) {
        return makeResult(cmd, { stdout: 'main\ntask/9\n' });
      }
      return makeResult(cmd);
    });

    const probe = await manager.probeProvisioningState({ workspaceDir: tmpDir });

    assert.ok(probe.worktreePaths.includes(internal), JSON.stringify(probe.worktreePaths));
    assert.ok(
      probe.worktreePaths.includes(external),
      'the probe must include external registrations (#282, #287)'
    );
    assert.deepStrictEqual(probe.localBranches, ['main', 'task/9']);

    const publicList = await manager.listWorktrees({ workspaceDir: tmpDir });
    assert.deepStrictEqual(
      publicList.map((worktree: any) => worktree.worktreePath),
      [internal],
      'the public default still excludes external worktrees'
    );
  });

  test('WT-426-4: a failed branch read is null, not []', async () => {
    const tmpDir = makeTmpDir();
    const internal = path.join(tmpDir, '.worktrees', '9');
    const { manager } = makeManager((cmd) => {
      if (cmd === 'git worktree list --porcelain') {
        return makeResult(cmd, { stdout: porcelain(rootBlock(tmpDir), linkedBlock(internal)) });
      }
      if (cmd.includes('git branch')) {
        return makeResult(cmd, { exitCode: 128, stderr: 'fatal: could not read the branch list' });
      }
      return makeResult(cmd);
    });

    const probe = await manager.probeProvisioningState({ workspaceDir: tmpDir });

    assert.strictEqual(
      probe.localBranches,
      null,
      'a failed branch read must be UNKNOWN (null), never "no branches existed"'
    );
    assert.ok(probe.worktreePaths.includes(internal), JSON.stringify(probe.worktreePaths));
    assert.deepStrictEqual(
      await manager.listBranches({ workspaceDir: tmpDir, remote: false }),
      []
    );
  });

  test('WT-426-5: branch parsing is unchanged', async () => {
    const tmpDir = makeTmpDir();
    const { manager, commands } = makeManager((cmd) => {
      if (cmd === 'git worktree list --porcelain') {
        return makeResult(cmd, { stdout: rootBlock(tmpDir) });
      }
      if (cmd.includes('git branch')) {
        return makeResult(cmd, { stdout: 'main\ntask/9\norigin/main\ntask/9\n' });
      }
      return makeResult(cmd);
    });

    const probe = await manager.probeProvisioningState({ workspaceDir: tmpDir });

    assert.deepStrictEqual(probe.localBranches, ['main', 'task/9']);
    const branchCommands = commands.filter((cmd) => cmd.includes('git branch'));
    assert.ok(branchCommands.length > 0, 'the probe must read the branch list');
    for (const cmd of branchCommands) {
      assert.ok(!/\s-a\s/.test(cmd), `the probe must request local branches only: ${cmd}`);
    }
  });

  test('WT-426-6: a thrown executor is null, never a rejection', async () => {
    const tmpDir = makeTmpDir();
    const { manager } = makeManager((cmd) => {
      if (cmd === 'git worktree list --porcelain') {
        throw new Error('spawn git ENOENT');
      }
      if (cmd.includes('git branch')) {
        return makeResult(cmd, { stdout: 'main\ntask/9\n' });
      }
      return makeResult(cmd);
    });

    const probe = await manager.probeProvisioningState({ workspaceDir: tmpDir });

    assert.strictEqual(probe.worktreePaths, null);
    assert.deepStrictEqual(probe.localBranches, ['main', 'task/9']);
  });
});
