/**
 * agyloop - GitWorktreeManager Infrastructure Adapter Unit Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GitWorktreeManager } = require('../../dist/infrastructure');
const { WorktreeCreationError, INIT_GITIGNORE_RULES } = require('../../dist/domain');

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

  test('ensureGitIgnore creates .gitignore with .worktrees when missing', async () => {
    const manager = new GitWorktreeManager();
    const created = await manager.ensureGitIgnore({ workspaceDir: tmpDir });
    assert.strictEqual(created, true);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('.worktrees'));
  });

  test('ensureGitIgnore appends .worktrees when .gitignore exists but lacks it', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    const manager = new GitWorktreeManager();
    const modified = await manager.ensureGitIgnore({ workspaceDir: tmpDir });
    assert.strictEqual(modified, true);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    assert.ok(content.includes('node_modules/'));
    assert.ok(content.includes('.worktrees'));
  });

  test('repo .gitignore keeps a bare .agyloop entry so a symlinked state dir stays ignored', () => {
    // #102 regression: 19f00f7 (#216/#217) replaced the bare `.agyloop` entry with granular
    // `.agyloop/...` rules. Those rules can never match a symlinked state dir -- git records it
    // as mode 120000 (a file), so `git add -A` staged it and it landed in the open PR. A trailing
    // slash would not help either: it matches directories only.
    const content = fs.readFileSync(path.resolve(__dirname, '..', '..', '.gitignore'), 'utf8');
    const lines = content.split(/\r?\n/);

    assert.ok(
      lines.includes('.agyloop'),
      'repo .gitignore must contain a bare `.agyloop` entry (no trailing slash)'
    );
    assert.ok(
      !lines.includes('.agyloop/'),
      'a trailing-slash rule would not match a symlink and must not be the only entry'
    );

    // Granular rules are still meaningful and must be retained alongside the bare entry.
    for (const rule of [
      '.agyloop/state.json',
      '.agyloop/tasks/',
      '.agyloop/locks/',
      '.agyloop/logs/',
      '.agyloop/critique-update-cache.json',
      '.agyloop/*.bak'
    ]) {
      assert.ok(lines.includes(rule), `granular rule ${rule} must be retained`);
    }

    // The bare entry is repo-scoped; consumer scaffolding now carries the symlink-safe pair
    // (`#221`): a bare `.agyloop` (matches the mode-120000 symlink) immediately re-included by
    // `!.agyloop/` so `.agyloop/config.json` stays trackable.
    assert.ok(
      INIT_GITIGNORE_RULES.includes('.agyloop'),
      'consumer-project scaffolding must ignore the .agyloop symlink'
    );
    assert.ok(
      INIT_GITIGNORE_RULES.includes('!.agyloop/'),
      'consumer-project scaffolding must re-include the .agyloop directory to keep config.json trackable'
    );
  });

  test('ensureGitIgnore does not re-add blanket .agyloop when granular state rules exist', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.agyloop/state.json\n.agyloop/tasks/\n', 'utf8');
    const manager = new GitWorktreeManager();
    const modified = await manager.ensureGitIgnore({ workspaceDir: tmpDir, entry: '.agyloop' });
    assert.strictEqual(modified, false);
    assert.ok(!fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').split('\n').includes('.agyloop'));
  });

  test('ensureGitIgnore uses INIT_GITIGNORE_RULES to skip bare .agyloop when ephemeral rules exist', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.gitignore'),
      '.agyloop/critique-update-cache.json\n.agyloop/*.bak\n',
      'utf8'
    );
    const manager = new GitWorktreeManager();
    const modified = await manager.ensureGitIgnore({ workspaceDir: tmpDir, entry: '.agyloop' });
    assert.strictEqual(modified, false);
    assert.ok(!fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').split('\n').includes('.agyloop'));
  });

  test('ensureGitIgnore returns false and does not duplicate if .worktrees already present', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.worktrees\n', 'utf8');
    const manager = new GitWorktreeManager();
    const modified = await manager.ensureGitIgnore({ workspaceDir: tmpDir });
    assert.strictEqual(modified, false);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = content.match(/\.worktrees/g);
    assert.strictEqual(matches?.length, 1);
  });

  test('ensureGitIgnore returns false and does not re-add .worktrees if .worktrees/ is already present', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.worktrees/\n', 'utf8');
    const manager = new GitWorktreeManager();
    const modified = await manager.ensureGitIgnore({ workspaceDir: tmpDir });
    assert.strictEqual(modified, false);

    const content = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    const matches = content.match(/\.worktrees/g);
    assert.strictEqual(matches?.length, 1);
  });

  test('ensureGitIgnore normalizes .worktrees/ entry and does not duplicate if .worktrees is present', async () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.worktrees\n', 'utf8');
    const manager = new GitWorktreeManager();
    const modified = await manager.ensureGitIgnore({ workspaceDir: tmpDir, entry: '.worktrees/' });
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
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: '', combinedOutput: '' });
        }
        if (cmd.includes('git worktree list --porcelain')) {
          return makeResult(cmd, { stdout: '', combinedOutput: '' });
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
    assert.ok(fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').includes('.worktrees'));

    // Verify command was executed
    assert.ok(executedCommands.some((c) => c.includes('git worktree add -b "task/87-git-worktree-isolation"')));
  });

  test('createWorktree symlinks .agyloop and artifacts into worktree if present in workspace', async () => {
    // Setup root .agyloop and artifacts
    const agyloopDir = path.join(tmpDir, '.agyloop');
    const artifactsDir = path.join(tmpDir, 'artifacts');
    fs.mkdirSync(agyloopDir, { recursive: true });
    fs.writeFileSync(path.join(agyloopDir, 'state.json'), '{"stage":"PLAN"}', 'utf8');
    fs.mkdirSync(artifactsDir, { recursive: true });

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git worktree add')) {
          // Simulate git worktree creating the folder
          const wtPath = path.resolve(tmpDir, '.worktrees', '87');
          fs.mkdirSync(wtPath, { recursive: true });
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

    const targetAgyloop = path.join(descriptor.worktreePath, '.agyloop');
    const targetArtifacts = path.join(descriptor.worktreePath, 'artifacts');

    assert.ok(fs.existsSync(targetAgyloop));
    assert.ok(fs.lstatSync(targetAgyloop).isSymbolicLink());
    assert.ok(fs.existsSync(targetArtifacts));
    assert.ok(fs.lstatSync(targetArtifacts).isSymbolicLink());

    // Also verify removeWorktree unlinks .agyloop cleanly
    await manager.removeWorktree({
      worktreePath: descriptor.worktreePath,
      workspaceDir: tmpDir
    });
    assert.strictEqual(fs.existsSync(targetAgyloop), false);
    // Root .agyloop remains intact
    assert.ok(fs.existsSync(agyloopDir));
  });

  test('createWorktree proactively queries branches and reuses existing fix/ branch without -b flag', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\nfix/82-bug-fix\n', combinedOutput: 'main\nfix/82-bug-fix\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({
      taskId: '82',
      workspaceDir: tmpDir
    });

    assert.strictEqual(descriptor.taskId, '82');
    assert.strictEqual(descriptor.branch, 'fix/82-bug-fix');
    // Ensure it didn't run git worktree add -b "task/82"
    assert.strictEqual(executedCommands.some((c) => c.includes('git worktree add -b')), false);
    // Ensure it checked out the existing branch directly
    assert.ok(executedCommands.some((c) => c.includes('git worktree add "') && c.includes('fix/82-bug-fix')));
  });

  test('createWorktree handles already checked out branch by throwing error without -b flag', async () => {
    const executedCommands: string[] = [];
    const wtPath = path.resolve(tmpDir, '.worktrees', '82');
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\nfix/82-bug-fix\n', combinedOutput: 'main\nfix/82-bug-fix\n' });
        }
        if (cmd.includes('git worktree list --porcelain')) {
          // Realistic porcelain: the main repository root is ALWAYS listed first,
          // then the linked worktree that holds the branch (#247 fixture repair —
          // the previous single-entry listing made getRepoRoot resolve the holder
          // itself, which the new root-invariant adoption guard must refuse).
          return makeResult(
            cmd,
            {
              stdout: [
                `worktree ${tmpDir}`,
                'HEAD 1111111111111111111111111111111111111111',
                'branch refs/heads/main',
                '',
                `worktree ${wtPath}`,
                'HEAD 2222222222222222222222222222222222222222',
                'branch refs/heads/fix/82-bug-fix',
                ''
              ].join('\n'),
              combinedOutput: ''
            },
          );
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, { exitCode: 128, stderr: `fatal: 'fix/82-bug-fix' is already checked out at '${wtPath}'`, combinedOutput: `fatal: 'fix/82-bug-fix' is already checked out at '${wtPath}'` });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({
      taskId: '82',
      workspaceDir: tmpDir
    });

    assert.strictEqual(descriptor.taskId, '82');
    assert.strictEqual(descriptor.branch, 'fix/82-bug-fix');
    assert.strictEqual(descriptor.worktreePath, wtPath);
    // Ensure it didn't run git worktree add -b "task/82"
    assert.strictEqual(executedCommands.some((c) => c.includes('git worktree add -b')), false);
  });

  test('createWorktree handles existing branch by reusing existing branch without -b flag', async () => {
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git branch -a --format')) {
          return makeResult(cmd, { stdout: 'task/87\n', combinedOutput: 'task/87' });
        }
        if (cmd.includes('git worktree list --porcelain')) {
          return makeResult(cmd, { stdout: '', combinedOutput: '' }); // Not checked out
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
    // We should explicitly not run with -b since the branch exists
    assert.ok(!executedCommands.some((c) => c.includes('git worktree add -b')));
    assert.ok(
      executedCommands.some((c) => c.includes('git worktree add "') && !c.includes('-b')),
      'Expected executedCommands to contain `git worktree add "` without `-b`'
    );
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

  test('createWorktree attaches to the existing worktree when modern git reports "is already used by worktree at"', async () => {
    // Regression for BUG-3 / issue #218: git >= 2.45 says "is already used by worktree at",
    // which the previous "already checked out at" match never recognised.
    const rootRepo = path.resolve(tmpDir, 'root-repo');
    const holderPath = path.join(rootRepo, '.worktrees', '218-triage');
    fs.mkdirSync(holderPath, { recursive: true });
    fs.mkdirSync(path.join(rootRepo, '.agyloop'), { recursive: true });
    fs.mkdirSync(path.join(rootRepo, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(rootRepo, 'node_modules'), { recursive: true });

    const porcelainOutput = [
      `worktree ${rootRepo}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree ${holderPath}`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/218',
      ''
    ].join('\n');

    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, { stdout: porcelainOutput, combinedOutput: porcelainOutput });
        }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\ntask/218\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: `Preparing worktree (checking out 'task/218')\nfatal: 'task/218' is already used by worktree at '${holderPath}'`
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    // Must resolve, not throw WorktreeCreationError.
    const descriptor = await manager.createWorktree({ taskId: '218', workspaceDir: rootRepo });

    assert.strictEqual(descriptor.taskId, '218');
    assert.strictEqual(descriptor.branch, 'task/218');
    assert.strictEqual(descriptor.worktreePath, path.resolve(holderPath));
    assert.strictEqual(descriptor.isIsolated, true);

    // The already-existing worktree got the same link treatment as a freshly created one.
    assert.strictEqual(fs.lstatSync(path.join(holderPath, 'node_modules')).isSymbolicLink(), true);
    assert.strictEqual(fs.lstatSync(path.join(holderPath, 'artifacts')).isSymbolicLink(), true);
    const linkedAgyloop = path.join(holderPath, '.agyloop');
    assert.strictEqual(fs.lstatSync(linkedAgyloop).isSymbolicLink(), true);
    assert.strictEqual(
      fs.realpathSync(linkedAgyloop),
      fs.realpathSync(path.join(rootRepo, '.agyloop'))
    );

    // The branch already existed, so the -b variant was never attempted.
    assert.strictEqual(executedCommands.some((c) => c.includes('git worktree add -b')), false);
    assert.ok(executedCommands.some((c) => c.includes('git worktree add "') && c.includes('task/218')));
  });

  test('createWorktree recovers from modern git wording when the porcelain listing yields no holder', async () => {
    // Pins the widened regex itself: with `git worktree list --porcelain` unavailable the
    // path can only come from the error text, and modern git says "used by worktree at".
    const rootRepo = path.resolve(tmpDir, 'root-repo');
    const holderPath = path.join(rootRepo, '.worktrees', '218-triage');
    fs.mkdirSync(holderPath, { recursive: true });
    fs.mkdirSync(path.join(rootRepo, '.agyloop'), { recursive: true });

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse --show-toplevel')) {
          return makeResult(cmd, { stdout: `${rootRepo}\n` });
        }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\ntask/218\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: `Preparing worktree (checking out 'task/218')\nfatal: 'task/218' is already used by worktree at '${holderPath}'`
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({ taskId: '218', workspaceDir: rootRepo });

    assert.strictEqual(descriptor.branch, 'task/218');
    assert.strictEqual(descriptor.worktreePath, path.resolve(holderPath));
    assert.strictEqual(
      fs.lstatSync(path.join(holderPath, '.agyloop')).isSymbolicLink(),
      true,
      'expected .agyloop to be linked into the recovered worktree'
    );
  });

  test('createWorktree still recovers from the legacy "is already checked out at" wording', async () => {
    // The pre-2.45 git wording must not regress.
    const rootRepo = path.resolve(tmpDir, 'root-repo');
    const holderPath = path.join(rootRepo, '.worktrees', '87-legacy');
    fs.mkdirSync(holderPath, { recursive: true });
    fs.mkdirSync(path.join(rootRepo, '.agyloop'), { recursive: true });

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse --show-toplevel')) {
          return makeResult(cmd, { stdout: `${rootRepo}\n` });
        }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\ntask/87\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: `fatal: 'task/87' is already checked out at '${holderPath}'`
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({ taskId: '87', workspaceDir: rootRepo });

    assert.strictEqual(descriptor.branch, 'task/87');
    assert.strictEqual(descriptor.worktreePath, path.resolve(holderPath));
    assert.strictEqual(
      fs.lstatSync(path.join(holderPath, '.agyloop')).isSymbolicLink(),
      true,
      'expected .agyloop to be linked into the recovered worktree'
    );
  });

  test('createWorktree trusts the worktree list over stale git error wording', async () => {
    // `git worktree list --porcelain` is authoritative: even if the error text names a
    // different path, the worktree that actually holds the branch is the one to attach to.
    const rootRepo = path.resolve(tmpDir, 'root-repo');
    const actualHolder = path.join(rootRepo, '.worktrees', '99-actual');
    fs.mkdirSync(actualHolder, { recursive: true });

    const porcelainOutput = [
      `worktree ${rootRepo}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree ${actualHolder}`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/77',
      ''
    ].join('\n');

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, { stdout: porcelainOutput, combinedOutput: porcelainOutput });
        }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\ntask/77\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: "fatal: 'task/77' is already used by worktree at '/stale/gone/path'"
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({ taskId: '77', workspaceDir: rootRepo });

    assert.strictEqual(descriptor.worktreePath, path.resolve(actualHolder));
  });

  test('createWorktree still throws WorktreeCreationError for unrelated git worktree add failures', async () => {
    const rootRepo = path.resolve(tmpDir, 'root-repo');
    fs.mkdirSync(rootRepo, { recursive: true });

    const porcelainOutput = [
      `worktree ${rootRepo}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      ''
    ].join('\n');

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, { stdout: porcelainOutput, combinedOutput: porcelainOutput });
        }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\ntask/88\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: `Preparing worktree (checking out 'task/88')\nfatal: '${rootRepo}/.worktrees/88' already exists`
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    let caught: unknown = null;
    try {
      await manager.createWorktree({ taskId: '88', workspaceDir: rootRepo });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof WorktreeCreationError, 'expected a WorktreeCreationError');
    assert.ok(
      (caught as Error).message.includes('already exists'),
      `expected the git output to be surfaced, got: ${(caught as Error).message}`
    );
    assert.ok((caught as Error).message.includes('createWorktree'));
  });

  test('createWorktree prunes a dead worktree registration instead of returning a bogus descriptor', async () => {
    // Regression: `git worktree list --porcelain` keeps listing a `prunable` entry
    // (with its `branch` line) after the worktree directory was deleted behind git's
    // back. Trusting it produced a descriptor with isIsolated: true for a path that
    // does not exist on disk. Pruning frees the branch, so the checkout is retried.
    const rootRepo = path.resolve(tmpDir, 'root-repo');
    const deadPath = path.join(rootRepo, '.worktrees', '91');
    const canonicalPath = path.join(rootRepo, '.worktrees', '91');
    fs.mkdirSync(rootRepo, { recursive: true });
    fs.mkdirSync(path.join(rootRepo, '.agyloop'), { recursive: true });
    assert.strictEqual(fs.existsSync(deadPath), false, 'precondition: the worktree dir must be gone');

    const livePorcelain = [
      `worktree ${rootRepo}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      ''
    ].join('\n');
    const prunablePorcelain = [
      livePorcelain,
      `worktree ${deadPath}`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/91',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n');

    let prunesRun = 0;
    let addAttempts = 0;
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git worktree list --porcelain') {
          const stdout = prunesRun > 0 ? livePorcelain : prunablePorcelain;
          return makeResult(cmd, { stdout, combinedOutput: stdout });
        }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\ntask/91\n' });
        }
        if (cmd.includes('git worktree prune')) {
          prunesRun += 1;
          return makeResult(cmd);
        }
        if (cmd.includes('git worktree add')) {
          addAttempts += 1;
          if (addAttempts === 1) {
            return makeResult(cmd, {
              exitCode: 128,
              stderr: `Preparing worktree (checking out 'task/91')\nfatal: 'task/91' is already used by worktree at '${deadPath}'`
            });
          }
          fs.mkdirSync(canonicalPath, { recursive: true });
          return makeResult(cmd, { stdout: 'Preparing worktree\n' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({ taskId: '91', workspaceDir: rootRepo });

    assert.strictEqual(prunesRun, 1, 'expected exactly one `git worktree prune`');
    assert.strictEqual(addAttempts, 2, 'expected the checkout to be retried once');
    // The descriptor points at a directory that actually exists -- never at deadPath.
    assert.strictEqual(descriptor.worktreePath, path.resolve(canonicalPath));
    assert.strictEqual(descriptor.branch, 'task/91');
    assert.strictEqual(descriptor.isIsolated, true);
    assert.strictEqual(fs.existsSync(descriptor.worktreePath), true);
  });

  test('createWorktree refuses a prunable registration that survives pruning', async () => {
    // If the dead registration cannot be pruned away, fail loudly rather than hand
    // back a descriptor for a path that does not exist.
    const rootRepo = path.resolve(tmpDir, 'root-repo');
    const deadPath = path.join(rootRepo, '.worktrees', '92');
    fs.mkdirSync(rootRepo, { recursive: true });

    const prunablePorcelain = [
      `worktree ${rootRepo}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree ${deadPath}`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/92',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n');

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, { stdout: prunablePorcelain, combinedOutput: prunablePorcelain });
        }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\ntask/92\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: `fatal: 'task/92' is already used by worktree at '${deadPath}'`
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    let caught: unknown = null;
    try {
      await manager.createWorktree({ taskId: '92', workspaceDir: rootRepo });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof WorktreeCreationError, 'expected a WorktreeCreationError');
    const message = (caught as Error).message;
    assert.ok(message.includes('missing worktree'), `expected a "missing worktree" explanation, got: ${message}`);
    assert.ok(message.includes(path.resolve(deadPath)), `expected the dead path to be named, got: ${message}`);
    assert.ok(message.includes('git worktree prune'), `expected remediation advice, got: ${message}`);
  });

  test('createWorktree throws WorktreeCreationError on unrecoverable failure', async () => {
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse --show-toplevel')) return makeResult(cmd, { stdout: `${tmpDir}\n` });
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

  test('createWorktree refuses root-as-worktree registration instead of treating resolvedRoot === resolvedTarget as no-worktree-active (#247)', async () => {
    // Pre-fix, the adopt path blessed `{ worktreePath: <repoRoot>, isIsolated: false }`
    // with a real-directory .agyloop treatment — the exact descriptor teardown
    // later interpreted as "a worktree to delete" (issue #247). Root adoption is
    // now refused at the boundary; a root workspace manages `.agyloop` the
    // in-place way only outside createWorktree.
    const rootDir = path.resolve(tmpDir, '.worktrees', '87');
    fs.mkdirSync(rootDir, { recursive: true });
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: `fatal: 'task/87' is already checked out at '${rootDir}'`,
            combinedOutput: `fatal: 'task/87' is already checked out at '${rootDir}'`
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    await assert.rejects(
      async () => {
        await manager.createWorktree({
          taskId: '87',
          workspaceDir: rootDir
        });
      },
      (err: unknown) => {
        assert.ok(
          /Refusing to adopt the repository root/.test((err as Error).message),
          `unexpected message: ${(err as Error).message}`
        );
        return true;
      }
    );
  });

  test('createWorktree refuses root-as-worktree adoption without consuming a pre-existing broken .agyloop symlink (#247)', async () => {
    const targetDir = path.resolve(tmpDir, 'repo-root');
    fs.mkdirSync(targetDir, { recursive: true });

    // Intentionally create a self-referential / cyclic symlink: .agyloop -> .agyloop
    const cyclicSymlinkPath = path.join(targetDir, '.agyloop');
    fs.symlinkSync(cyclicSymlinkPath, cyclicSymlinkPath);
    assert.ok(fs.lstatSync(cyclicSymlinkPath).isSymbolicLink());

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, {
            exitCode: 128,
            stderr: `fatal: 'task/87' is already checked out at '${targetDir}'`,
            combinedOutput: `fatal: 'task/87' is already checked out at '${targetDir}'`
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    await assert.rejects(
      async () => {
        await manager.createWorktree({
          taskId: '87',
          workspaceDir: targetDir
        });
      },
      (err: unknown) => {
        assert.ok(/Refusing to adopt the repository root/.test((err as Error).message));
        return true;
      }
    );

    // The refusal fires BEFORE any link treatment: the owner's directory content
    // (adoption target) is not consumed or rewritten by the refused attach.
    assert.strictEqual(fs.lstatSync(cyclicSymlinkPath).isSymbolicLink(), true);
  });

  test('createWorktree creates symlink pointing to root .agyloop when in isolated worktree', async () => {
    const rootRepo = path.resolve(tmpDir, 'primary-root');
    fs.mkdirSync(rootRepo, { recursive: true });
    const rootAgyloop = path.join(rootRepo, '.agyloop');

    const wtPath = path.resolve(rootRepo, '.worktrees', '87');

    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse --show-toplevel')) {
          return makeResult(cmd, { stdout: `${rootRepo}\n` });
        }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git worktree add')) {
          fs.mkdirSync(wtPath, { recursive: true });
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({
      taskId: '87',
      workspaceDir: rootRepo
    });

    assert.strictEqual(descriptor.worktreePath, wtPath);

    // Verify root .agyloop exists as directory
    assert.ok(fs.existsSync(rootAgyloop));
    assert.strictEqual(fs.lstatSync(rootAgyloop).isDirectory(), true);

    // Verify target in worktree is a symlink pointing to root
    const wtAgyloop = path.join(wtPath, '.agyloop');
    assert.ok(fs.existsSync(wtAgyloop));
    const wtStat = fs.lstatSync(wtAgyloop);
    assert.strictEqual(wtStat.isSymbolicLink(), true);
    assert.strictEqual(fs.realpathSync(wtAgyloop), fs.realpathSync(rootAgyloop));
  });

  test('listWorktrees filters out external subagent worktrees by default unless includeExternal is true', async () => {
    const subagentPath = '/home/user/.gemini/antigravity/brain/abc-123/.system_generated/worktrees/subagent-1';
    const otherExternalPath = '/tmp/some/other/worktree';
    const porcelainOutput = [
      `worktree ${tmpDir}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree ${path.join(tmpDir, '.worktrees', '90')}`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/fix/90',
      '',
      `worktree ${subagentPath}`,
      'HEAD 3333333333333333333333333333333333333333',
      'branch refs/heads/subagent-branch',
      '',
      `worktree ${otherExternalPath}`,
      'HEAD 4444444444444444444444444444444444444444',
      'branch refs/heads/external-branch',
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

    // Default: excludes external worktrees
    const defaultList = await manager.listWorktrees({ workspaceDir: tmpDir });
    assert.strictEqual(defaultList.length, 1);
    assert.strictEqual(defaultList[0].taskId, '90');
    assert.strictEqual(defaultList[0].worktreePath, path.resolve(tmpDir, '.worktrees', '90'));

    // With includeExternal: true, includes all worktrees
    const allList = await manager.listWorktrees({ workspaceDir: tmpDir, includeExternal: true });
    assert.strictEqual(allList.length, 3);
    assert.strictEqual(allList[0].taskId, '90');
    assert.strictEqual(allList[1].worktreePath, path.resolve(subagentPath));
    assert.strictEqual(allList[2].worktreePath, path.resolve(otherExternalPath));
  });

  test('cleanOrphanedWorktrees with subagents: true prunes external subagent worktrees while safeguarding process.cwd', async () => {
    const executedCommands: string[] = [];
    const currentCwd = path.resolve(process.cwd());
    const subagentPath1 = '/home/user/.gemini/antigravity/brain/abc-123/.system_generated/worktrees/subagent-1';
    const subagentPath2 = '/home/user/.gemini/antigravity/brain/def-456/.system_generated/worktrees/subagent-2';

    let removeCount = 0;
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('git worktree remove')) {
          removeCount++;
          return makeResult(cmd);
        }
        if (cmd === 'git worktree list --porcelain') {
          // If both subagents have been removed, return only root and cwd
          if (removeCount >= 2) {
            return makeResult(cmd, {
              stdout: [
                `worktree ${tmpDir}`,
                'HEAD 1111111111111111111111111111111111111111',
                'branch refs/heads/main',
                '',
                `worktree ${currentCwd}`,
                'HEAD 2222222222222222222222222222222222222222',
                'branch refs/heads/fix/90',
                ''
              ].join('\n')
            });
          }

          return makeResult(cmd, {
            stdout: [
              `worktree ${tmpDir}`,
              'HEAD 1111111111111111111111111111111111111111',
              'branch refs/heads/main',
              '',
              `worktree ${currentCwd}`,
              'HEAD 2222222222222222222222222222222222222222',
              'branch refs/heads/fix/90',
              '',
              `worktree ${subagentPath1}`,
              'HEAD 3333333333333333333333333333333333333333',
              'branch refs/heads/subagent-1',
              '',
              `worktree ${subagentPath2}`,
              'HEAD 4444444444444444444444444444444444444444',
              'branch refs/heads/subagent-2',
              ''
            ].join('\n')
          });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const cleaned = await manager.cleanOrphanedWorktrees({
      workspaceDir: tmpDir,
      subagents: true
    });

    assert.strictEqual(cleaned, 2);
    // Subagents should be removed via git worktree remove --force
    assert.ok(executedCommands.some((c) => c.includes(`git worktree remove --force "${subagentPath1}"`)));
    assert.ok(executedCommands.some((c) => c.includes(`git worktree remove --force "${subagentPath2}"`)));
    // process.cwd() MUST NOT be removed
    assert.strictEqual(
      executedCommands.some((c) => c.includes(`git worktree remove --force "${currentCwd}"`)),
      false
    );
  });

  describe('GitWorktreeManager Root-Invariant Teardown Guards (#247)', () => {
    test('removeWorktree rejects the repository root before any side effect and preserves the workspace', async () => {
      const executedCommands: string[] = [];
      const mockExecutor: CommandExecutorPort = {
        execute: async (cmd: string): Promise<CommandExecutionResult> => {
          executedCommands.push(cmd);
          return makeResult(cmd);
        }
      };

      const sentinelPath = path.join(tmpDir, 'sentinel.txt');
      fs.writeFileSync(sentinelPath, 'keep me alive', 'utf8');

      const manager = new GitWorktreeManager(mockExecutor);
      await assert.rejects(
        async () => {
          await manager.removeWorktree({
            worktreePath: tmpDir,
            workspaceDir: tmpDir,
            force: true,
            prune: true
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            /Refusing to remove the repository root/.test((err as Error).message),
            `unexpected message: ${(err as Error).message}`
          );
          return true;
        }
      );

      assert.strictEqual(
        executedCommands.some((c) => c.includes('git worktree remove')),
        false,
        'no git worktree remove may run for the root'
      );
      assert.strictEqual(
        executedCommands.some((c) => c.includes('git worktree prune')),
        false,
        'prune is a side effect after the guard'
      );
      assert.strictEqual(fs.existsSync(sentinelPath), true, 'sentinel in the root must survive');
      assert.strictEqual(
        fs.readFileSync(sentinelPath, 'utf8'),
        'keep me alive',
        'root contents must be untouched'
      );
    });

    test('removeWorktree never rmSyncs a path that contains the workspace root (ancestor-kill guard)', async () => {
      const executedCommands: string[] = [];
      const mockExecutor: CommandExecutorPort = {
        execute: async (cmd: string): Promise<CommandExecutionResult> => {
          executedCommands.push(cmd);
          return makeResult(cmd);
        }
      };

      // A nested workspace root; the target is its PARENT (would delete the root).
      const rootDir = path.join(tmpDir, 'main');
      fs.mkdirSync(rootDir, { recursive: true });
      fs.writeFileSync(path.join(rootDir, 'root-sentinel.txt'), 'alive', 'utf8');
      fs.writeFileSync(path.join(tmpDir, 'host-sentinel.txt'), 'alive', 'utf8');

      const manager = new GitWorktreeManager(mockExecutor);
      await assert.rejects(
        async () => {
          await manager.removeWorktree({
            worktreePath: tmpDir,
            workspaceDir: rootDir,
            force: true,
            prune: false
          });
        },
        (err: unknown) => {
          assert.ok(/Refusing to remove the repository root/.test((err as Error).message));
          return true;
        }
      );

      assert.strictEqual(
        executedCommands.some((c) => c.includes('git worktree remove')),
        false
      );
      assert.strictEqual(fs.existsSync(path.join(rootDir, 'root-sentinel.txt')), true);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, 'host-sentinel.txt')), true);
    });

    test('removeWorktree throws on a git main-tree refusal before the rmSync fallback (failure is no longer masked)', async () => {
      const decoyDir = path.join(tmpDir, 'decoy-main-tree');
      fs.mkdirSync(decoyDir, { recursive: true });
      fs.writeFileSync(path.join(decoyDir, 'decoy-sentinel.txt'), 'alive', 'utf8');

      const mockExecutor: CommandExecutorPort = {
        execute: async (cmd: string): Promise<CommandExecutionResult> => {
          if (cmd.includes('git worktree remove --force')) {
            return makeResult(cmd, {
              exitCode: 1,
              stderr: `fatal: '${decoyDir}' is a main working tree`,
              combinedOutput: `fatal: '${decoyDir}' is a main working tree`
            });
          }
          return makeResult(cmd);
        }
      };

      const manager = new GitWorktreeManager(mockExecutor);
      await assert.rejects(
        async () => {
          await manager.removeWorktree({
            worktreePath: decoyDir,
            workspaceDir: tmpDir,
            force: true,
            prune: false
          });
        },
        (err: unknown) => {
          assert.ok(/is a main working tree/.test((err as Error).message));
          return true;
        }
      );

      // The refusal must throw BEFORE the rmSync fallback: the decoy dir that
      // stands in for the main tree survives (pre-fix it was force-deleted and
      // the failure printed as success).
      assert.strictEqual(
        fs.existsSync(path.join(decoyDir, 'decoy-sentinel.txt')),
        true,
        'the main-tree decoy must survive the refusal'
      );
    });

    test('removeWorktree still force-cleans a stale non-root folder inside .worktrees after a non-main-tree git failure (fallback whitelist intact)', async () => {
      const staleDir = path.join(tmpDir, '.worktrees', '1');
      fs.mkdirSync(staleDir, { recursive: true });
      fs.writeFileSync(path.join(staleDir, 'stale.txt'), 'stale', 'utf8');

      const executedCommands: string[] = [];
      const mockExecutor: CommandExecutorPort = {
        execute: async (cmd: string): Promise<CommandExecutionResult> => {
          executedCommands.push(cmd);
          if (cmd.includes('git worktree remove --force')) {
            return makeResult(cmd, {
              exitCode: 1,
              stderr: 'fatal: some unrelated git failure',
              combinedOutput: 'fatal: some unrelated git failure'
            });
          }
          return makeResult(cmd);
        }
      };

      const manager = new GitWorktreeManager(mockExecutor);
      await assert.doesNotReject(async () => {
        await manager.removeWorktree({
          worktreePath: staleDir,
          workspaceDir: tmpDir,
          force: true,
          prune: false
        });
      });

      assert.strictEqual(
        fs.existsSync(staleDir),
        false,
        'a stale .worktrees/<id> folder must still be force-cleaned'
      );
      assert.strictEqual(executedCommands.some((c) => c.includes('git worktree remove')), true);
    });

    test('removeWorktree still removes a genuine external, disjoint worktree path (no over-restriction)', async () => {
      // The porcelain-declared main repo root sits below the external worktree's
      // parent so that the EXTERNAL path is fully disjoint from the root.
      const mainRepoRoot = path.join(tmpDir, 'main');
      fs.mkdirSync(mainRepoRoot, { recursive: true });
      const externalPath = path.join(tmpDir, 'external-247');
      fs.mkdirSync(externalPath, { recursive: true });
      fs.writeFileSync(path.join(externalPath, 'external.txt'), 'external', 'utf8');

      const porcelainOutput = [
        `worktree ${mainRepoRoot}`,
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        `worktree ${externalPath}`,
        'HEAD 2222222222222222222222222222222222222222',
        'branch refs/heads/fix/external',
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
      await assert.doesNotReject(async () => {
        await manager.removeWorktree({
          worktreePath: externalPath,
          workspaceDir: mainRepoRoot,
          force: true,
          prune: false
        });
      });

      assert.strictEqual(
        fs.existsSync(externalPath),
        false,
        'a genuine external, disjoint worktree must still be cleaned up'
      );
    });

    test('createWorktree refuses to adopt the repository root as a task worktree', async () => {
      const mockExecutor: CommandExecutorPort = {
        execute: async (cmd: string): Promise<CommandExecutionResult> => {
          if (cmd.includes('git worktree add -b')) {
            return makeResult(cmd, {
              exitCode: 128,
              stderr: `fatal: 'task/247' is already checked out at '${path.resolve(tmpDir)}'`,
              combinedOutput: `fatal: 'task/247' is already checked out at '${path.resolve(tmpDir)}'`
            });
          }
          return makeResult(cmd);
        }
      };

      const manager = new GitWorktreeManager(mockExecutor);
      await assert.rejects(
        async () => {
          await manager.createWorktree({ taskId: '247', workspaceDir: tmpDir });
        },
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            /Refusing to adopt the repository root/.test((err as Error).message),
            `unexpected message: ${(err as Error).message}`
          );
          return true;
        }
      );
    });

    test('createWorktree still adopts a non-root, fully checked-out branch path (no over-restriction)', async () => {
      const holderPath = path.join(tmpDir, 'external-holder');
      fs.mkdirSync(holderPath, { recursive: true });

      const mockExecutor: CommandExecutorPort = {
        execute: async (cmd: string): Promise<CommandExecutionResult> => {
          if (cmd.includes('git worktree add -b')) {
            return makeResult(cmd, {
              exitCode: 128,
              stderr: `fatal: 'task/247' is already checked out at '${holderPath}'`,
              combinedOutput: `fatal: 'task/247' is already checked out at '${holderPath}'`
            });
          }
          return makeResult(cmd);
        }
      };

      const manager = new GitWorktreeManager(mockExecutor);
      const descriptor = await manager.createWorktree({ taskId: '247', workspaceDir: tmpDir });

      assert.strictEqual(descriptor.worktreePath, path.resolve(holderPath));
      assert.strictEqual(descriptor.branch, 'task/247');
      assert.strictEqual(descriptor.isIsolated, true);
    });
  });
});

