/**
 * agyloop - GitWorktreeManager Branch & Release Methods Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
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

describe('GitWorktreeManager Branch & Release Extensions', () => {
  test('listBranches parses both local and remote branches cleanly without duplicates', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('git branch')) {
          return makeResult(cmd, {
            stdout: 'main\nphase/1-bridge-arch\ntask/88-collector\norigin/phase/1-bridge-arch\norigin/feature/auth\n'
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const branches = await manager.listBranches({ workspaceDir: '/repo' });

    assert(branches.includes('main'));
    assert(branches.includes('phase/1-bridge-arch'));
    assert(branches.includes('task/88-collector'));
    assert(branches.includes('feature/auth'));
    assert.strictEqual(branches.length, 4); // main, phase/1-bridge-arch, task/88-collector, feature/auth
  });

  test('createBranch executes git branch with startPoint', async () => {
    let capturedCmd = '';
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        capturedCmd = cmd;
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    await manager.createBranch({
      branchName: 'phase/2-realtime',
      startPoint: 'main',
      workspaceDir: '/repo'
    });

    assert.strictEqual(capturedCmd, 'git branch "phase/2-realtime" "main"');
  });

  test('createBranch defaults startPoint to HEAD if omitted', async () => {
    let capturedCmd = '';
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        capturedCmd = cmd;
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    await manager.createBranch({
      branchName: 'phase/3-sync',
      workspaceDir: '/repo'
    });

    assert.strictEqual(capturedCmd, 'git branch "phase/3-sync" "HEAD"');
  });

  test('isAncestor returns true when git merge-base --is-ancestor exits 0', async () => {
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        return makeResult(cmd, { exitCode: 0 });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const result = await manager.isAncestor({
      ancestorBranch: 'phase/1-bridge',
      descendantBranch: 'main',
      workspaceDir: '/repo'
    });

    assert.strictEqual(result, true);
  });

  test('isAncestor returns false when git merge-base --is-ancestor exits non-zero', async () => {
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        return makeResult(cmd, { exitCode: 1 });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const result = await manager.isAncestor({
      ancestorBranch: 'phase/2-unmerged',
      descendantBranch: 'main',
      workspaceDir: '/repo'
    });

    assert.strictEqual(result, false);
  });

  test('isAncestor returns false when ancestor and descendant share identical commit hash (same commit = not merged)', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('git rev-parse')) {
          return makeResult(cmd, { stdout: 'aabbcc112233\n' });
        }
        return makeResult(cmd, { exitCode: 0 });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const result = await manager.isAncestor({
      ancestorBranch: 'phase/5-orch',
      descendantBranch: 'main',
      workspaceDir: '/repo'
    });

    assert.strictEqual(result, false);
    // Verify merge-base was NOT executed because commit hashes were identical
    assert.strictEqual(executedCommands.some((c) => c.includes('git merge-base')), false);
  });

  test('isAncestor returns true when commit hashes differ and merge-base exits 0', async () => {
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('phase/1-bridge')) {
          return makeResult(cmd, { stdout: '111111\n' });
        }
        if (cmd.includes('main')) {
          return makeResult(cmd, { stdout: '222222\n' });
        }
        if (cmd.includes('git merge-base')) {
          return makeResult(cmd, { exitCode: 0 });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const result = await manager.isAncestor({
      ancestorBranch: 'phase/1-bridge',
      descendantBranch: 'main',
      workspaceDir: '/repo'
    });

    assert.strictEqual(result, true);
  });

  test('getCommitsBetween parses git log records separated by delimiter', async () => {
    const gitLogOutput = [
      'feat(bridge): add websocket connector\x1fAdded WS client',
      'fix(bridge): handle reconnect timeout\x1fFix timeout bug',
      'docs: update architecture spec\x1f'
    ].join('\x1e') + '\x1e';

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('git log')) {
          return makeResult(cmd, { stdout: gitLogOutput });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const commits = await manager.getCommitsBetween({
      baseBranch: 'main',
      headBranch: 'phase/1-bridge',
      workspaceDir: '/repo'
    });

    assert.strictEqual(commits.length, 3);
    assert(commits[0].includes('feat(bridge): add websocket connector'));
    assert(commits[1].includes('fix(bridge): handle reconnect timeout'));
    assert(commits[2].includes('docs: update architecture spec'));
  });
});

describe('GitWorktreeManager.resolveBaseBranch (issue #218 / AC5)', () => {
  const branchProbes = (executedCommands: string[]): string[] =>
    executedCommands.filter((c) => c.startsWith('git rev-parse --verify refs/heads/'));

  test('returns the attached HEAD branch without probing candidates', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd === 'git rev-parse --abbrev-ref HEAD') {
          return makeResult(cmd, { stdout: 'feature/mirai\n' });
        }
        return makeResult(cmd, { exitCode: 1 });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    assert.strictEqual(await manager.resolveBaseBranch('/repo'), 'feature/mirai');
    assert.strictEqual(executedCommands[0], 'git rev-parse --abbrev-ref HEAD');
    assert.deepStrictEqual(branchProbes(executedCommands), []);
  });

  test('probes develop, master, main, trunk in order when HEAD is detached', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd === 'git rev-parse --abbrev-ref HEAD') {
          return makeResult(cmd, { stdout: 'HEAD\n' });
        }
        return makeResult(cmd, { exitCode: 1, stderr: 'error' });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    // Every probe fails, so the terminal DEFAULT_BASE_BRANCH stands.
    assert.strictEqual(await manager.resolveBaseBranch('/repo'), 'main');
    assert.deepStrictEqual(branchProbes(executedCommands), [
      'git rev-parse --verify refs/heads/develop',
      'git rev-parse --verify refs/heads/master',
      'git rev-parse --verify refs/heads/main',
      'git rev-parse --verify refs/heads/trunk'
    ]);
  });

  test('prefers develop over master and short-circuits the remaining candidates', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd === 'git rev-parse --abbrev-ref HEAD') {
          return makeResult(cmd, { stdout: 'HEAD\n' });
        }
        if (cmd.includes('refs/heads/')) {
          return makeResult(cmd, { stdout: 'abc1234\n' });
        }
        return makeResult(cmd, { exitCode: 1 });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    assert.strictEqual(await manager.resolveBaseBranch('/repo'), 'develop');
    assert.deepStrictEqual(branchProbes(executedCommands), ['git rev-parse --verify refs/heads/develop']);
  });

  test('resolves trunk when it is the only well-known local candidate', async () => {
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git rev-parse --abbrev-ref HEAD') {
          return makeResult(cmd, { stdout: 'HEAD\n' });
        }
        if (cmd === 'git rev-parse --verify refs/heads/trunk') {
          return makeResult(cmd, { stdout: 'def5678\n' });
        }
        return makeResult(cmd, { exitCode: 1 });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    assert.strictEqual(await manager.resolveBaseBranch('/repo'), 'trunk');
  });

  test('continues to the next candidate when a probe throws', async () => {
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git rev-parse --abbrev-ref HEAD') {
          return makeResult(cmd, { stdout: 'HEAD\n' });
        }
        if (cmd === 'git rev-parse --verify refs/heads/develop') {
          throw new Error('git exploded');
        }
        if (cmd === 'git rev-parse --verify refs/heads/master') {
          return makeResult(cmd, { stdout: 'aaa1111\n' });
        }
        return makeResult(cmd, { exitCode: 1 });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    assert.strictEqual(await manager.resolveBaseBranch('/repo'), 'master');
  });
});
