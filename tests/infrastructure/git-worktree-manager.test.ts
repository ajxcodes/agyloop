/**
 * agyloop - GitWorktreeManager Infrastructure Adapter Unit Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GitWorktreeManager } = require('../../dist/infrastructure');
const { WorktreeCreationError } = require('../../dist/domain');

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

describe('GitWorktreeManager (Infrastructure Layer)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-wt-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('resolveTaskWorktreePath and resolveTaskBranchName format paths and branches deterministically', async () => {
    const manager = new GitWorktreeManager();
    const wtPath = await manager.resolveTaskWorktreePath(tmpDir, '87');
    assert.strictEqual(wtPath, path.resolve(tmpDir, '.worktrees', '87'));

    const branch = manager.resolveTaskBranchName(87, 'Git Worktree Isolation');
    assert.strictEqual(branch, 'task/87-git-worktree-isolation');
  });

  test('ensureGitIgnore creates .gitignore with .worktrees/ when missing', async () => {
    const manager = new GitWorktreeManager();
    const created = await manager.ensureGitIgnore({ workspaceDir: tmpDir });
    assert.strictEqual(created, true);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.worktrees/'));
  });

  test('ensureGitIgnore appends .worktrees/ when .gitignore exists but lacks it', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    const manager = new GitWorktreeManager();
    const modified = await manager.ensureGitIgnore({ workspaceDir: tmpDir });
    assert.strictEqual(modified, true);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('node_modules/'));
    assert.ok(content.includes('.worktrees/'));
  });

  test('ensureGitIgnore returns false and does not duplicate if .worktrees/ already present', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.worktrees/\n', 'utf8');
    const manager = new GitWorktreeManager();
    const modified = await manager.ensureGitIgnore({ workspaceDir: tmpDir });
    assert.strictEqual(modified, false);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = content.match(/\.worktrees/g);
    assert.strictEqual(matches?.length, 1);
  });

  test('resolveBaseBranch parses current branch and falls back to main', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'feature/mirai\n', combinedOutput: 'feature/mirai' });
        }
        return makeResult(cmd, { exitCode: 1, stderr: 'error', combinedOutput: 'error' });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const branch = await manager.resolveBaseBranch(tmpDir);
    assert.strictEqual(branch, 'feature/mirai');
    assert.strictEqual(executedCommands[0], 'git rev-parse --abbrev-ref HEAD');
  });

  test('createWorktree executes git worktree add and auto-adds .gitignore', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({
      taskId: '87',
      title: 'Git Worktree Isolation',
      workspaceDir: tmpDir
    });

    assert.strictEqual(descriptor.taskId, '87');
    assert.strictEqual(descriptor.branch, 'task/87-git-worktree-isolation');
    assert.strictEqual(descriptor.baseBranch, 'main');
    assert.strictEqual(descriptor.worktreePath, path.resolve(tmpDir, '.worktrees', '87'));

    // Verify .gitignore updated
    assert.ok(fs.existsSync(path.join(tmpDir, '.gitignore')));
    assert.ok(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').includes('.worktrees/'));

    // Verify command was executed
    assert.ok(executedCommands.some((c) => c.includes('git worktree add -b "task/87-git-worktree-isolation"')));
  });

  test('createWorktree handles existing branch by reusing existing branch without -b flag', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git worktree add -b')) {
          return makeResult(cmd, { exitCode: 128, stderr: "fatal: a branch named 'task/87' already exists", combinedOutput: 'fatal' });
        }
        if (cmd.includes('git worktree add "')) {
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({
      taskId: '87',
      workspaceDir: tmpDir
    });

    assert.strictEqual(descriptor.taskId, '87');
    assert.ok(executedCommands.some((c) => c.includes('git worktree add -b "task/87"')));
    assert.ok(executedCommands.some((c) => c.includes('git worktree add "') && !c.includes('-b')));
  });

  test('createWorktree idempotently returns existing descriptor when branch is already checked out', async () => {
    const executedCommands: string[] = [];
    const existingWorktreePath = path.resolve(tmpDir, '.worktrees', '87');
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git worktree add -b')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: `fatal: 'task/87' is already checked out at '${existingWorktreePath}'`,
            combinedOutput: `fatal: 'task/87' is already checked out at '${existingWorktreePath}'`
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({
      taskId: '87',
      workspaceDir: tmpDir
    });

    assert.strictEqual(descriptor.taskId, '87');
    assert.strictEqual(descriptor.worktreePath, existingWorktreePath);
    assert.strictEqual(descriptor.branch, 'task/87');
  });

  test('createWorktree throws WorktreeCreationError on unrecoverable failure', async () => {
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse')) return makeResult(cmd, { stdout: 'main\n' });
        return makeResult(cmd, { exitCode: 1, stderr: 'fatal: permission denied', combinedOutput: 'fatal' });
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    await assert.rejects(
      async () => {
        await manager.createWorktree({ taskId: '87', workspaceDir: tmpDir });
      },
      WorktreeCreationError
    );
  });

  test('removeWorktree executes git worktree remove --force and git worktree prune', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const wtPath = path.join(tmpDir, '.worktrees', '87');
    fs.mkdirSync(wtPath, { recursive: true });

    await manager.removeWorktree({
      worktreePath: wtPath,
      workspaceDir: tmpDir,
      force: true,
      prune: true
    });

    assert.ok(executedCommands.some((c) => c.includes('git worktree remove --force')));
    assert.ok(executedCommands.some((c) => c === 'git worktree prune'));
  });

  test('listWorktrees parses git worktree list --porcelain and filters out root workspace', async () => {
    const porcelainOutput = [
      `worktree ${tmpDir}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree ${path.join(tmpDir, '.worktrees', '87')}`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/87-git-worktree-isolation',
      '',
      `worktree ${path.join(tmpDir, '.worktrees', '88')}`,
      'HEAD 3333333333333333333333333333333333333333',
      'branch refs/heads/task/88-avatar-ui',
      ''
    ].join('\n');

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, { stdout: porcelainOutput, combinedOutput: porcelainOutput });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const list = await manager.listWorktrees({ workspaceDir: tmpDir });

    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].taskId, '87');
    assert.strictEqual(list[0].branch, 'task/87-git-worktree-isolation');
    assert.strictEqual(list[1].taskId, '88');
    assert.strictEqual(list[1].branch, 'task/88-avatar-ui');
  });

  test('cleanOrphanedWorktrees deletes untracked directory and calls git worktree prune', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd === 'git worktree list --porcelain') {
          // Only root workspace returned
          return makeResult(cmd, { stdout: `worktree ${tmpDir}\nHEAD abc\nbranch refs/heads/main\n\n` });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const orphanedDir = path.join(tmpDir, '.worktrees', 'orphaned-task');
    fs.mkdirSync(orphanedDir, { recursive: true });

    const cleaned = await manager.cleanOrphanedWorktrees({ workspaceDir: tmpDir });
    assert.strictEqual(cleaned, 1);
    assert.strictEqual(fs.existsSync(orphanedDir), false);
    assert.ok(executedCommands.includes('git worktree prune'));
  });

  test('anchors resolveTaskWorktreePath and createWorktree to primary root when executed inside linked worktree', async () => {
    const mainRepoRoot = path.join(tmpDir, 'main-repo');
    const nestedWorktreeDir = path.join(mainRepoRoot, '.worktrees', '58');
    fs.mkdirSync(nestedWorktreeDir, { recursive: true });

    const porcelainOutput = [
      `worktree ${mainRepoRoot}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree ${nestedWorktreeDir}`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/58',
      ''
    ].join('\n');

    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, { stdout: porcelainOutput, combinedOutput: porcelainOutput });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);

    // Call from within nested worktree dir
    const resolvedPath = await manager.resolveTaskWorktreePath(nestedWorktreeDir, '87');
    assert.strictEqual(resolvedPath, path.join(mainRepoRoot, '.worktrees', '87'));

    const descriptor = await manager.createWorktree({
      taskId: '87',
      workspaceDir: nestedWorktreeDir,
      baseBranch: 'main'
    });

    assert.strictEqual(descriptor.worktreePath, path.join(mainRepoRoot, '.worktrees', '87'));
    // Ensure the add command targeted the primary root path
    assert.ok(
      executedCommands.some(
        (c) =>
          c.includes('git worktree add') &&
          c.includes(path.join(mainRepoRoot, '.worktrees', '87'))
      )
    );
  });
});
