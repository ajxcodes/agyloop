/**
 * agyloop - GitWorktreeManager Infrastructure Adapter Unit Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { GitWorktreeManager } = require('../../dist/infrastructure');
const { WorktreeCreationError, INIT_GITIGNORE_RULES } = require('../../dist/domain');

import type { CommandExecutorPort, CommandExecutionResult } from '../../src/ports';

function makeResult(cmd: string, partial: Partial<CommandExecutionResult> = {}): CommandExecutionResult {
  return {
    command: cmd,
    exitCode: 0,
    stdout: cmd === 'git rev-parse --is-inside-work-tree' ? 'true\n' : '',
    stderr: '',
    timedOut: false,
    durationMs: 5,
    combinedOutput: '',
    ...partial
  };
}

/**
 * `git worktree add` has exactly two forms:
 *
 *   git worktree add -b "<branch>" "<path>" "<base>"   -- create the branch
 *   git worktree add "<path>" "<branch>"                -- reuse an existing branch
 *
 * The `-b` flag is POSITIONAL: it is the token immediately after `git worktree add `.
 * Scanning the whole command for the substring `-b` is therefore wrong -- the command
 * embeds the worktree path, so a path that happens to contain `-b` (e.g. the temp dir
 * `/tmp/agyloop-test-wt-bLeg0o`, whose random suffix begins with `b`) makes the correct
 * no-`-b` form look like the create-branch form. That is the flake that reddened CI on
 * PR #261, so both forms are recognised by the FLAG POSITION only.
 */
const WORKTREE_ADD_PREFIX = 'git worktree add ';

/** The `git worktree add` invocations among the executed commands. */
function worktreeAddCommands(commands: readonly string[]): string[] {
  return commands.filter((c) => c.startsWith(WORKTREE_ADD_PREFIX));
}

/** True for the create-branch form: the `-b` flag sits in the flag position. */
function isCreateBranchForm(cmd: string): boolean {
  return cmd.startsWith(`${WORKTREE_ADD_PREFIX}-b `) || cmd === `${WORKTREE_ADD_PREFIX}-b`;
}

/** True for the reuse-existing-branch form: a quoted path sits in the flag position. */
function isReuseExistingBranchForm(cmd: string): boolean {
  return cmd.startsWith(`${WORKTREE_ADD_PREFIX}"`);
}

/**
 * #264: the branch-existence check in `listBranches` runs `git branch [--format]`
 * (local only) versus the legacy `git branch -a --format` (local + remote). Both
 * shapes are accepted by the fake so a remote-inclusive regression would surface
 * as an assertion failure rather than as an empty branch list.
 */
function isBranchListingCommand(cmd: string): boolean {
  return cmd.startsWith('git branch') && cmd.includes('--format');
}

/** The local-only listing form (no `-a`): the discriminator #264 hinges on. */
function isLocalBranchListingCommand(cmd: string): boolean {
  return isBranchListingCommand(cmd) && !cmd.includes('-a ');
}

/** A deterministic 40-char sha used to make start-point verification succeed. */
const VERIFIED_SHA = 'a'.repeat(40);

/**
 * The start-point verification commands are `git -C "<worktreePath>" rev-parse …`
 * (`#264`): distinguishing them from `resolveBaseBranch`'s cwd-scoped
 * `git rev-parse --abbrev-ref HEAD` by a whole-command `includes('rev-parse')`
 * alone would mis-route that command, so the `git -C ` prefix at the START of
 * the command decides.
 */
function isWorktreeScopedRevParse(cmd: string): boolean {
  return cmd.startsWith('git -C ') && cmd.includes('rev-parse');
}

/**
 * Structural shape of the descriptor `createWorktree` resolves to. The manager
 * class is `any` at runtime (a plain `require` of the built `dist/` module), so
 * an explicit structural annotation keeps the strict typecheck honest without
 * depending on `dist` types.
 */
interface CreatedWorktree {
  readonly taskId: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly worktreePath: string;
  readonly slug: string;
  readonly isIsolated: boolean;
  readonly reusedBranchCommit?: string;
}

/**
 * Captures console.warn emissions for the duration of an async operation
 * (#264: the reuse / merged-branch / unverifiable-start-point notices are
 * console-based). console.warn is always restored, including when `fn`
 * throws, so an intra-capture assertion failure still surfaces normally.
 */
async function captureConsoleWarn<T = CreatedWorktree>(fn: () => Promise<T>): Promise<{ warnings: string[]; result: T }> {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: unknown): void => {
    warnings.push(String(msg));
  };
  try {
    const result = await fn();
    return { warnings, result };
  } finally {
    console.warn = originalWarn;
  }
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
        if (isWorktreeScopedRevParse(cmd)) {
          // Start-point verification (#264): worktree HEAD and base tip agree.
          return makeResult(cmd, { stdout: `${VERIFIED_SHA}\n`, combinedOutput: VERIFIED_SHA });
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
        if (isWorktreeScopedRevParse(cmd)) {
          // Start-point verification (#264): worktree HEAD and base tip agree.
          return makeResult(cmd, { stdout: `${VERIFIED_SHA}\n`, combinedOutput: VERIFIED_SHA });
        }
        if (cmd === 'git worktree list --porcelain') {
          // #282: a removal only proceeds for a REGISTERED worktree.
          const wtPath = path.resolve(tmpDir, '.worktrees', '87');
          return makeResult(cmd, {
            stdout: [
              `worktree ${tmpDir}`,
              'HEAD 1111111111111111111111111111111111111111',
              'branch refs/heads/main',
              '',
              `worktree ${wtPath}`,
              'HEAD 2222222222222222222222222222222222222222',
              'branch refs/heads/task/87-git-worktree-isolation',
              ''
            ].join('\n')
          });
        }
        if (cmd.includes('git worktree remove --force')) {
          // Simulate git removing the directory, so the #282 post-condition holds.
          const match = cmd.match(/"([^"]+)"/);
          if (match && match[1]) {
            fs.rmSync(match[1], { recursive: true, force: true });
          }
          return makeResult(cmd);
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
        if (isBranchListingCommand(cmd)) {
          // #264: the widened fake accepts both the legacy remote-inclusive form
          // (`git branch -a --format`) and the current local-only form
          // (`git branch  --format`, flag empty). It must NOT be kept green by
          // re-adding `-a` at the call site instead.
          return makeResult(cmd, { stdout: 'task/87\n', combinedOutput: 'task/87' });
        }
        if (cmd.includes('git worktree list --porcelain')) {
          return makeResult(cmd, { stdout: '', combinedOutput: '' }); // Not checked out
        }
        if (cmd.includes('git worktree add')) {
          // Both forms succeed on purpose: a regression to the `-b` form must surface as
          // an assertion failure naming the offending command, not as an opaque
          // WorktreeCreationError raised by a mocked git refusal.
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
    assert.strictEqual(descriptor.branch, 'task/87');

    // The branch already exists, so the create-branch form must not be used. Both
    // checks below look at the FLAG POSITION -- the token right after `git worktree
    // add ` -- and never at a whole-command substring: the command embeds the
    // worktree path, which may itself contain `-b` (a temp dir whose random suffix
    // begins with `b`), and scanning the whole string mis-read the correct no-`-b`
    // form as the create-branch form.
    const addCommands = worktreeAddCommands(executedCommands);
    assert.ok(
      !addCommands.some((c) => isCreateBranchForm(c)),
      `Expected no \`git worktree add -b\` command for an existing branch, got: ${JSON.stringify(addCommands)}`
    );
    assert.ok(
      addCommands.some((c) => isReuseExistingBranchForm(c)),
      `Expected a \`git worktree add "<path>" "<branch>"\` command, got: ${JSON.stringify(addCommands)}`
    );
    assert.ok(
      addCommands.some((c) => c.includes('"task/87"')),
      `Expected the existing branch to be checked out, got: ${JSON.stringify(addCommands)}`
    );
  });

  test('createWorktree keeps the no--b form when the worktree path itself contains -b', async () => {
    // Regression test for the PR #261 flake. The `-b` flag of `git worktree add` is
    // POSITIONAL (the token right after `git worktree add `), but the command embeds
    // the worktree path. A path containing `-b` -- constructed deterministically here
    // instead of relying on a random `mkdtemp` suffix that happens to begin with `b`
    // -- used to make a whole-command substring scan mis-read the correct no-`-b` form
    // as the create-branch form. The flag position decides, so this command is the
    // reuse form and must be accepted.
    const rootRepo = path.join(tmpDir, 'wt-b-root');
    fs.mkdirSync(rootRepo, { recursive: true });

    const porcelainOutput = [
      `worktree ${rootRepo}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
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
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (cmd.includes('git branch')) {
          return makeResult(cmd, { stdout: 'main\ntask/87\n', combinedOutput: 'main\ntask/87\n' });
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
      workspaceDir: rootRepo
    });

    const worktreePath = path.resolve(rootRepo, '.worktrees', '87');
    assert.strictEqual(descriptor.branch, 'task/87');
    assert.strictEqual(descriptor.worktreePath, worktreePath);

    const addCommands = worktreeAddCommands(executedCommands);
    assert.strictEqual(
      addCommands.length,
      1,
      `expected exactly one \`git worktree add\` command, got: ${JSON.stringify(addCommands)}`
    );

    // Precondition: the command really does embed a path containing `-b` ...
    assert.ok(worktreePath.includes('-b'), 'precondition: the worktree path must contain `-b`');
    assert.ok(addCommands[0].includes('-b'), 'precondition: the command must embed the `-b` path');

    // ... and the flag position still carries no `-b`, so this is the reuse form.
    assert.ok(
      !isCreateBranchForm(addCommands[0]),
      `the \`-b\` flag must not sit in the flag position, got: ${addCommands[0]}`
    );
    assert.ok(
      isReuseExistingBranchForm(addCommands[0]),
      `expected \`git worktree add "<path>" "<branch>"\`, got: ${addCommands[0]}`
    );
    assert.ok(
      addCommands[0].includes('"task/87"'),
      `expected the existing branch to be checked out, got: ${addCommands[0]}`
    );
  });

  test('createWorktree ignores a remote-only fix/<id> branch and creates the task branch from the current base (#264)', async () => {
    // T1 (AC1, AC2, AC6): `origin/fix/264` — the leftover of a merged PR — must NOT
    // make the worktree reuse arm fire. The existence check lists LOCAL branches
    // only, so the same-named remote branch falls through to the fresh `-b` create
    // from the current base branch: the task branch cannot start at the remote's
    // (stale) commit via git's DWIM rule.
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (isBranchListingCommand(cmd)) {
          if (cmd.includes('-a ')) {
            // What a remote-inclusive listing (a regression to `-a`) would return:
            // the merged PR's remote-only branch, prefix-stripped to `fix/264`.
            return makeResult(cmd, {
              stdout: 'main\norigin/fix/264\n',
              combinedOutput: 'main\norigin/fix/264\n'
            });
          }
          // The local-only listing truth: no local fix/264 exists.
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main\n' });
        }
        if (isWorktreeScopedRevParse(cmd)) {
          // Start-point verification: worktree HEAD and base tip agree.
          return makeResult(cmd, { stdout: `${VERIFIED_SHA}\n`, combinedOutput: VERIFIED_SHA });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const descriptor = await manager.createWorktree({
      taskId: '264',
      workspaceDir: tmpDir,
      branchPrefix: 'fix/'
    });

    // (i) The branch listing was emitted in its LOCAL-ONLY form: no `-a` anywhere.
    const branchCommands = executedCommands.filter(isBranchListingCommand);
    assert.strictEqual(branchCommands.length, 1, `expected exactly one branch listing, got: ${JSON.stringify(branchCommands)}`);
    assert.ok(
      isLocalBranchListingCommand(branchCommands[0]),
      `expected the local-only listing form, got: ${branchCommands[0]}`
    );

    // (ii) The add is the create-branch form, starting from the current base.
    const addCommands = worktreeAddCommands(executedCommands);
    assert.ok(
      addCommands.some(isCreateBranchForm),
      `expected a \`git worktree add -b\` command, got: ${JSON.stringify(addCommands)}`
    );
    assert.ok(
      addCommands.every((c) => !isReuseExistingBranchForm(c)),
      `a remote-only branch must not trigger the reuse form, got: ${JSON.stringify(addCommands)}`
    );
    const createCommand = addCommands.find(isCreateBranchForm);
    assert.ok(
      createCommand?.includes('-b "fix/264"'),
      `expected the task branch to be created, got: ${createCommand}`
    );
    assert.ok(
      createCommand?.endsWith('"main"'),
      `expected the current base branch as the start point, got: ${createCommand}`
    );

    // (iv) The descriptor records the fresh create, not a reuse.
    assert.strictEqual(descriptor.branch, 'fix/264');
    assert.strictEqual(descriptor.baseBranch, 'main');
    assert.strictEqual(descriptor.reusedBranchCommit, undefined);

    // (v) Start-point verification ran and its SHAs agreed (worktree HEAD = base tip).
    const verifyCommands = executedCommands.filter(isWorktreeScopedRevParse);
    assert.strictEqual(verifyCommands.length, 2, `expected both verification reads, got: ${JSON.stringify(verifyCommands)}`);
    assert.ok(verifyCommands.some((c) => c.includes('rev-parse HEAD')));
    assert.ok(verifyCommands.some((c) => c.includes('rev-parse "main"')));
  });

  test('createWorktree reports reusing a local fix/<id> branch with its tip commit (#264)', async () => {
    // T2 (AC3, AC7): a genuinely LOCAL fix/<id> is still reused without -b, and the run
    // says so — the reuse warning names the branch and the commit it reused, and the
    // descriptor carries that commit programmatically.
    const FIXTIP = 'b'.repeat(40);
    const executedCommands: string[] = [];
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (isBranchListingCommand(cmd)) {
          // A LOCAL fix/264 (this same listing command is local-only, so a
          // remote-only branch could never have been returned by it).
          return makeResult(cmd, { stdout: 'main\nfix/264\n', combinedOutput: 'main\nfix/264\n' });
        }
        if (cmd.includes('rev-parse "fix/264"')) {
          return makeResult(cmd, { stdout: `${FIXTIP}\n`, combinedOutput: FIXTIP });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const { warnings, result: descriptor } = await captureConsoleWarn<CreatedWorktree>(() =>
      manager.createWorktree({ taskId: '264', workspaceDir: tmpDir, branchPrefix: 'fix/' })
    );

    // The add is the reuse form.
    const addCommands = worktreeAddCommands(executedCommands);
    assert.ok(
      addCommands.some(isReuseExistingBranchForm),
      `expected \`git worktree add "<path>" "<branch>"\`, got: ${JSON.stringify(addCommands)}`
    );
    assert.ok(
      addCommands.every((c) => !isCreateBranchForm(c)),
      `a matching local branch must be reused without -b, got: ${JSON.stringify(addCommands)}`
    );
    assert.ok(
      addCommands.some((c) => c.includes('"fix/264"')),
      `expected the existing branch to be checked out, got: ${JSON.stringify(addCommands)}`
    );

    // The run reports the reuse, naming branch AND commit.
    const reuseWarning = warnings.find((w) => w.includes('reusing existing local branch "fix/264"'));
    assert.ok(
      reuseWarning && reuseWarning.includes(FIXTIP),
      `the reuse warning must name the reused commit, got: ${JSON.stringify(warnings)}`
    );

    // The descriptor exposes the reuse programmatically.
    assert.strictEqual(descriptor.branch, 'fix/264');
    assert.strictEqual(descriptor.reusedBranchCommit, FIXTIP);

    // No start-point HEAD assertion on the reuse arm: the verification is scoped to
    // the fresh-create path.
    assert.strictEqual(
      executedCommands.some(isWorktreeScopedRevParse),
      false,
      'verification must not run on the reuse arm'
    );
  });

  test('createWorktree throws WorktreeCreationError when the fresh worktree starts off the base tip (#264)', async () => {
    // T3 (AC5): a start-point MISMATCH is a hard error carrying both SHAs — never a
    // silent success (this is the stale-start defect class, #264).
    const ACTUAL_SHA = 'c'.repeat(40);
    const EXPECTED_SHA = 'd'.repeat(40);
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (isWorktreeScopedRevParse(cmd)) {
          if (cmd.includes('rev-parse HEAD')) {
            return makeResult(cmd, { stdout: `${ACTUAL_SHA}\n`, combinedOutput: ACTUAL_SHA });
          }
          return makeResult(cmd, { stdout: `${EXPECTED_SHA}\n`, combinedOutput: EXPECTED_SHA });
        }
        if (isBranchListingCommand(cmd)) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    let caught: unknown = null;
    try {
      await manager.createWorktree({ taskId: '264', workspaceDir: tmpDir, branchPrefix: 'fix/' });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof WorktreeCreationError, `expected a WorktreeCreationError, got: ${caught}`);
    const message = (caught as Error).message;
    assert.ok(message.includes('did not start from the base branch'), `expected a stale-start explanation, got: ${message}`);
    assert.ok(message.includes(EXPECTED_SHA), `expected expectedSha in the message, got: ${message}`);
    assert.ok(message.includes(ACTUAL_SHA), `expected actualSha in the message, got: ${message}`);
    assert.ok(message.includes('reflog show'), `expected the DWIM-origin pointer, got: ${message}`);

    const details = (caught as { details?: Record<string, unknown> }).details;
    assert.strictEqual(details?.expectedSha, EXPECTED_SHA);
    assert.strictEqual(details?.actualSha, ACTUAL_SHA);
  });

  test('createWorktree warns but proceeds when the worktree start point cannot be verified (#264)', async () => {
    // T4: an UNREADABLE start point (either rev-parse fails or comes back empty) is not
    // a mismatch — loud-but-lenient: warn, and let the successfully created worktree
    // through.
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (isWorktreeScopedRevParse(cmd)) {
          if (cmd.includes('rev-parse HEAD')) {
            // The worktree HEAD read fails.
            return makeResult(cmd, { exitCode: 1, stderr: 'fatal: invalid object', combinedOutput: 'fatal' });
          }
          return makeResult(cmd, { stdout: `${VERIFIED_SHA}\n`, combinedOutput: VERIFIED_SHA });
        }
        if (isBranchListingCommand(cmd)) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main\n' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const { warnings, result: descriptor } = await captureConsoleWarn<CreatedWorktree>(() =>
      manager.createWorktree({ taskId: '264', workspaceDir: tmpDir, branchPrefix: 'fix/' })
    );

    assert.ok(descriptor, 'expected a descriptor despite the unverifiable start point');
    assert.strictEqual(descriptor.branch, 'fix/264');

    const warning = warnings.find((w) => w.includes('unable to verify worktree start point'));
    assert.ok(warning, `expected an unverifiable-start-point warning, got: ${JSON.stringify(warnings)}`);
  });

  test('createWorktree warns non-blocking when a reused local branch is already merged into the base (#264)', async () => {
    // T5 (D4): a once-merged local branch is still reusable (the policy decision is a
    // follow-up), but the run surfaces the fact explicitly and does NOT fail.
    const FIXTIP = 'b'.repeat(40);
    const MAIN_SHA = 'e'.repeat(40);
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return makeResult(cmd, { stdout: 'main\n', combinedOutput: 'main' });
        }
        if (isBranchListingCommand(cmd)) {
          return makeResult(cmd, { stdout: 'main\nfix/264\n', combinedOutput: 'main\nfix/264\n' });
        }
        if (cmd.includes('rev-parse "fix/264"')) {
          return makeResult(cmd, { stdout: `${FIXTIP}\n`, combinedOutput: FIXTIP });
        }
        if (cmd.includes('rev-parse "main^{commit}"')) {
          return makeResult(cmd, { stdout: `${MAIN_SHA}\n`, combinedOutput: MAIN_SHA });
        }
        if (cmd.includes('merge-base --is-ancestor')) {
          // Ancestor check exits 0: the branch IS merged into the base.
          return makeResult(cmd, { stdout: '', combinedOutput: '' });
        }
        if (cmd.includes('git worktree add')) {
          return makeResult(cmd, { stdout: 'Preparing worktree\n', combinedOutput: 'Preparing worktree' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    const { warnings, result: descriptor } = await captureConsoleWarn<CreatedWorktree>(() =>
      manager.createWorktree({ taskId: '264', workspaceDir: tmpDir, branchPrefix: 'fix/' })
    );

    assert.ok(descriptor, 'expected a descriptor despite the merged-branch warning');
    assert.strictEqual(descriptor.branch, 'fix/264');

    const mergedWarning = warnings.find((w) =>
      w.includes('already merged into base "main"') && w.includes('recreating it from the base branch is recommended')
    );
    assert.ok(mergedWarning, `expected the merged-branch policy warning, got: ${JSON.stringify(warnings)}`);

    const reuseWarning = warnings.find((w) => w.includes('reusing existing local branch "fix/264"'));
    assert.ok(reuseWarning, `expected the reuse notice alongside the policy warning, got: ${JSON.stringify(warnings)}`);
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
    const wtPath = path.join(tmpDir, '.worktrees', '87');
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, {
            stdout: [
              `worktree ${tmpDir}`,
              'HEAD 1111111111111111111111111111111111111111',
              'branch refs/heads/main',
              '',
              `worktree ${wtPath}`,
              'HEAD 2222222222222222222222222222222222222222',
              'branch refs/heads/task/87',
              ''
            ].join('\n')
          });
        }
        if (cmd.includes('git worktree remove --force')) {
          fs.rmSync(wtPath, { recursive: true, force: true });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(mockExecutor);
    fs.mkdirSync(wtPath, { recursive: true });

    await manager.removeWorktree({
      worktreePath: wtPath,
      workspaceDir: tmpDir,
      force: true,
      prune: true
    });

    assert.ok(executedCommands.some((c) => c.includes('git worktree remove --force')));
    assert.ok(executedCommands.some((c) => c === 'git worktree prune'));
    assert.strictEqual(fs.existsSync(wtPath), false, 'the registered worktree must be gone');
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
        if (isWorktreeScopedRevParse(cmd)) {
          // Start-point verification (#264): worktree HEAD and base tip agree.
          return makeResult(cmd, { stdout: `${VERIFIED_SHA}\n`, combinedOutput: VERIFIED_SHA });
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
    // Real directories (#282): a removal now proves ownership and existence, so
    // a fake path would be refused before `git worktree remove` ever ran.
    const subagentPath1 = path.join(
      tmpDir,
      '.gemini',
      'antigravity',
      'brain',
      'abc-123',
      '.system_generated',
      'worktrees',
      'subagent-1'
    );
    const subagentPath2 = path.join(
      tmpDir,
      '.gemini',
      'antigravity',
      'brain',
      'def-456',
      '.system_generated',
      'worktrees',
      'subagent-2'
    );
    fs.mkdirSync(subagentPath1, { recursive: true });
    fs.mkdirSync(subagentPath2, { recursive: true });

    let removeCount = 0;
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        executedCommands.push(cmd);
        if (cmd.includes('git worktree remove')) {
          removeCount++;
          const match = cmd.match(/"([^"]+)"/);
          if (match && match[1]) {
            fs.rmSync(match[1], { recursive: true, force: true });
          }
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
          if (cmd === 'git worktree list --porcelain') {
            // #282: the ownership check runs before git, so the decoy must be a
            // REGISTERED worktree of this repository for the test to reach git.
            return makeResult(cmd, {
              stdout: [
                `worktree ${tmpDir}`,
                'HEAD 1111111111111111111111111111111111111111',
                'branch refs/heads/main',
                '',
                `worktree ${decoyDir}`,
                'HEAD 2222222222222222222222222222222222222222',
                'branch refs/heads/fix/decoy',
                ''
              ].join('\n')
            });
          }
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
            prune: false,
            // The decoy is outside `.worktrees`, so the containment default would
            // refuse it before git. Opt in explicitly so this test still reaches
            // the `is a main working tree` refusal it pins (#282).
            allowExternal: true
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

  /**
   * Issue #425: provisioning must not leave litter behind.
   *
   * WT-425-1/2 pin #420's teardown invariant for the `.worktrees` CONTAINER: a
   * failed `git worktree add` removes the container only when THIS invocation
   * created it, and only while it is still empty. WT-425-3 pins the refusal for
   * a workspace that is not inside a git work tree: nothing is written — no
   * `.gitignore`, no `.worktrees`.
   */
  describe('createWorktree provisioning container (#425)', () => {
    const ADD_FAILURE = 'fatal: could not create work tree dir';

    function porcelainFor(rootRepo: string): string {
      return [
        `worktree ${rootRepo}`,
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        ''
      ].join('\n');
    }

    function failingAddExecutor(rootRepo: string): CommandExecutorPort {
      const porcelain = porcelainFor(rootRepo);
      return {
        execute: async (cmd: string): Promise<CommandExecutionResult> => {
          if (cmd === 'git worktree list --porcelain') {
            return makeResult(cmd, { stdout: porcelain, combinedOutput: porcelain });
          }
          if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
            return makeResult(cmd, { stdout: 'main\n' });
          }
          if (cmd.includes('git branch')) {
            return makeResult(cmd, { stdout: 'main\n' });
          }
          if (cmd.includes('git worktree add')) {
            return makeResult(cmd, { exitCode: 128, stderr: ADD_FAILURE, combinedOutput: ADD_FAILURE });
          }
          return makeResult(cmd);
        }
      };
    }

    async function expectProvisioningFailure(
      manager: InstanceType<typeof GitWorktreeManager>,
      rootRepo: string
    ): Promise<any> {
      let caught: unknown = null;
      try {
        await manager.createWorktree({ taskId: '425', workspaceDir: rootRepo });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof WorktreeCreationError, 'expected a WorktreeCreationError');
      assert.strictEqual((caught as any).operation, 'createWorktree');
      return caught;
    }

    test('WT-425-1: a failed add removes the container this invocation created', async () => {
      const rootRepo = path.resolve(tmpDir, 'root-repo');
      fs.mkdirSync(rootRepo, { recursive: true });

      const manager = new GitWorktreeManager(failingAddExecutor(rootRepo));
      const error = await expectProvisioningFailure(manager, rootRepo);

      assert.match(error.message, /could not create work tree dir/, 'the git output must still be surfaced');
      assert.strictEqual(
        fs.existsSync(path.join(rootRepo, '.worktrees')),
        false,
        'a failed provisioning must not leave the empty container it created'
      );
    });

    test('WT-425-2: a container that already existed survives a failed add', async () => {
      const rootRepo = path.resolve(tmpDir, 'root-repo');
      fs.mkdirSync(path.join(rootRepo, '.worktrees'), { recursive: true });

      const manager = new GitWorktreeManager(failingAddExecutor(rootRepo));
      await expectProvisioningFailure(manager, rootRepo);

      assert.strictEqual(
        fs.existsSync(path.join(rootRepo, '.worktrees')),
        true,
        'a container this invocation did not create must never be removed'
      );
      assert.deepStrictEqual(fs.readdirSync(path.join(rootRepo, '.worktrees')), []);
    });

    test('WT-428: a bare repository is refused before any write', async () => {
      const bare = path.join(tmpDir, 'bare.git');
      execFileSync('git', ['init', '--bare', bare], { stdio: 'pipe' });
      const manager = new GitWorktreeManager();
      const error = await expectProvisioningFailure(manager, bare);
      assert.match(error.message, /not inside a git work tree/);
      assert.ok(error.message.includes(bare));
      assert.strictEqual(fs.existsSync(path.join(bare, '.gitignore')), false);
      assert.strictEqual(fs.existsSync(path.join(bare, '.worktrees')), false);
    });

    for (const layout of ['normal', 'linked', 'submodule', 'separate']) {
      test(`WT-428: ${layout} work trees pass the real Git probe`, async () => {
        const repo = path.join(tmpDir, 'repo');
        const git = (args: string[], cwd = tmpDir) =>
          execFileSync('git', args, { cwd, stdio: 'pipe' });
        git(['init', '-b', 'main', repo]);
        git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'seed'], repo);
        let workspace = repo;
        if (layout === 'linked') {
          workspace = path.join(tmpDir, 'linked');
          git(['worktree', 'add', '-b', 'linked', workspace], repo);
        } else if (layout === 'submodule') {
          const parent = path.join(tmpDir, 'parent');
          git(['init', parent]);
          git(['-c', 'protocol.file.allow=always', 'submodule', 'add', repo, 'child'], parent);
          workspace = path.join(parent, 'child');
        } else if (layout === 'separate') {
          workspace = path.join(tmpDir, 'separate');
          git(['clone', '--separate-git-dir', path.join(tmpDir, 'metadata'), repo, workspace]);
        }
        const descriptor = await new GitWorktreeManager().createWorktree({
          taskId: '428', workspaceDir: workspace, baseBranch: 'main'
        });
        assert.ok(fs.existsSync(path.join(descriptor.worktreePath, '.git')));
      });
    }

    test('WT-425-3: a non-git workspace is refused before any write', async () => {
      const plain = path.resolve(tmpDir, 'plain-workspace');
      fs.mkdirSync(plain, { recursive: true });

      const manager = new GitWorktreeManager();
      const error = await expectProvisioningFailure(manager, plain);

      assert.match(error.message, /not inside a git work tree/);
      assert.ok(error.message.includes(plain), `the refusal must name the workspace, got: ${error.message}`);
      assert.strictEqual(fs.existsSync(path.join(plain, '.worktrees')), false, 'nothing may be provisioned');
      assert.strictEqual(fs.existsSync(path.join(plain, '.gitignore')), false, 'nothing may be written');
    });
  });
});

/**
 * Issue #282 — `worktree remove` is the only destructive operator command.
 *
 * These tests pin the VALIDATE -> REFUSE -> ACT contract: nothing is deleted
 * unless it is a path this repository registers as a worktree (and, for the
 * operator surface, lies strictly inside `<root>/.worktrees`). Every refusal
 * happens before the first side effect, and no failure is reported as success.
 */
describe('removeWorktree containment, ownership and post-conditions (#282)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-wt282-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /** Blank-line separated porcelain blocks for the given worktree paths. */
  function porcelainFor(rootDir: string, worktrees: readonly string[]): string {
    const blocks = [
      [`worktree ${rootDir}`, 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'].join('\n'),
      ...worktrees.map((wt, index) =>
        [
          `worktree ${wt}`,
          `HEAD ${String(index + 2).repeat(40).slice(0, 40)}`,
          `branch refs/heads/task/${path.basename(wt)}`
        ].join('\n')
      )
    ];
    return `${blocks.join('\n\n')}\n`;
  }

  function executor(options: {
    porcelain?: string;
    onRemove?: (cmd: string) => CommandExecutionResult;
    commands?: string[];
  }): CommandExecutorPort {
    return {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        options.commands?.push(cmd);
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, { stdout: options.porcelain || '' });
        }
        if (cmd.includes('git worktree remove --force') && options.onRemove) {
          return options.onRemove(cmd);
        }
        return makeResult(cmd);
      }
    };
  }

  /** Records every path passed to `fs.rmSync` for the duration of `fn`. */
  async function recordRmSync<T>(fn: () => Promise<T>): Promise<{ result: T; paths: string[] }> {
    const original = fs.rmSync;
    const paths: string[] = [];
    fs.rmSync = ((target: any, rmOptions?: any) => {
      paths.push(String(target));
      return original(target, rmOptions);
    }) as typeof fs.rmSync;
    try {
      const result = await fn();
      return { result, paths };
    } finally {
      fs.rmSync = original;
    }
  }

  test('T-I1 rejects an external target before any side effect (AC-1)', async () => {
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-victim282-'));
    const decoyTarget = path.join(tmpDir, 'node-modules-target');
    fs.mkdirSync(decoyTarget, { recursive: true });
    fs.writeFileSync(path.join(victim, 'data'), 'keep', 'utf8');
    fs.symlinkSync(decoyTarget, path.join(victim, 'node_modules'), 'dir');

    const commands: string[] = [];
    try {
      const manager = new GitWorktreeManager(executor({ commands }));

      await assert.rejects(
        async () => {
          await manager.removeWorktree({ worktreePath: victim, workspaceDir: tmpDir });
        },
        (err: unknown) => {
          assert.ok(/outside .*\.worktrees/i.test((err as Error).message), (err as Error).message);
          return true;
        }
      );

      assert.strictEqual(
        commands.some((c) => c.includes('git worktree remove')),
        false,
        'no git worktree remove may run for an external target'
      );
      assert.strictEqual(fs.readFileSync(path.join(victim, 'data'), 'utf8'), 'keep');
      assert.strictEqual(fs.lstatSync(path.join(victim, 'node_modules')).isSymbolicLink(), true);
    } finally {
      fs.rmSync(victim, { recursive: true, force: true });
    }
  });

  test('T-I2 never calls fs.rmSync for an external target (AC-1, AC-10)', async () => {
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-victim282-rm-'));
    fs.writeFileSync(path.join(victim, 'data'), 'keep', 'utf8');

    try {
      const manager = new GitWorktreeManager(executor({}));
      const { paths } = await recordRmSync(async () => {
        await assert.rejects(async () => {
          await manager.removeWorktree({ worktreePath: victim, workspaceDir: tmpDir });
        });
      });

      assert.strictEqual(
        paths.some((p) => p === victim || p.startsWith(victim + path.sep)),
        false,
        `fs.rmSync must never run for the external victim; saw: ${paths.join(', ')}`
      );
      assert.strictEqual(fs.existsSync(path.join(victim, 'data')), true);
    } finally {
      fs.rmSync(victim, { recursive: true, force: true });
    }
  });

  test("T-I3 resolveTaskWorktreePath rejects absolute, '..', multi-segment and unsafe ids (AC-2)", async () => {
    const manager = new GitWorktreeManager(executor({}));

    for (const bad of ['/tmp/x', '..', 'a/b', 'a\\b', '.', '-x', 'x;rm', '   ']) {
      await assert.rejects(
        async () => {
          await manager.resolveTaskWorktreePath(tmpDir, bad);
        },
        (err: unknown) => {
          assert.ok(
            /Refusing|required/i.test((err as Error).message),
            `segment '${bad}' produced: ${(err as Error).message}`
          );
          return true;
        }
      );
    }

    await assert.rejects(async () => {
      await manager.resolveTaskWorktreePath(tmpDir, '87', path.join(tmpDir, 'absolute-worktrees'));
    });

    // Minor (#282 review): a REPOSITORY-RELATIVE worktreesDir must not escape
    // either — `../escape-dir` would otherwise place the container outside.
    for (const escapingDir of ['../escape-dir', path.join('nested', '..', '..', 'escape-dir')]) {
      await assert.rejects(
        async () => {
          await manager.resolveTaskWorktreePath(tmpDir, '87', escapingDir);
        },
        (err: unknown) => {
          assert.ok(
            /worktreesDir|inside the repository root/i.test((err as Error).message),
            `worktreesDir '${escapingDir}' produced: ${(err as Error).message}`
          );
          return true;
        }
      );
    }

    for (const good of ['87', 'adhoc', 'orphan-task-1']) {
      const resolved = await manager.resolveTaskWorktreePath(tmpDir, good);
      assert.strictEqual(resolved, path.resolve(tmpDir, '.worktrees', good));
    }
  });

  test('T-I4 refuses a .worktrees symlink that escapes and leaves the victim intact (AC-3)', async () => {
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-victim282-link-'));
    fs.writeFileSync(path.join(victim, 'data'), 'keep', 'utf8');
    const linkDir = path.join(tmpDir, '.worktrees');
    fs.mkdirSync(linkDir, { recursive: true });
    const linkPath = path.join(linkDir, '666');
    fs.symlinkSync(victim, linkPath, 'dir');

    const commands: string[] = [];
    try {
      const manager = new GitWorktreeManager(executor({ commands }));
      await assert.rejects(
        async () => {
          await manager.removeWorktree({ worktreePath: linkPath, workspaceDir: tmpDir });
        },
        (err: unknown) => {
          assert.ok(/symbolic link|outside/i.test((err as Error).message), (err as Error).message);
          return true;
        }
      );

      assert.strictEqual(commands.some((c) => c.includes('git worktree remove')), false);
      assert.strictEqual(fs.readFileSync(path.join(victim, 'data'), 'utf8'), 'keep');
      assert.strictEqual(fs.lstatSync(linkPath).isSymbolicLink(), true);
    } finally {
      fs.rmSync(victim, { recursive: true, force: true });
    }
  });

  test('T-I5 refuses a missing target with a clear error instead of reporting success (AC-4)', async () => {
    const commands: string[] = [];
    const manager = new GitWorktreeManager(
      executor({ commands, porcelain: porcelainFor(tmpDir, []) })
    );

    await assert.rejects(
      async () => {
        await manager.removeWorktree({
          worktreePath: path.join(tmpDir, '.worktrees', '999'),
          workspaceDir: tmpDir
        });
      },
      (err: unknown) => {
        assert.ok(
          /does not exist|not a registered/i.test((err as Error).message),
          (err as Error).message
        );
        return true;
      }
    );

    assert.strictEqual(commands.some((c) => c.includes('git worktree remove')), false);
    assert.strictEqual(commands.some((c) => c.includes('git worktree prune')), false);
  });

  test('T-I6 refuses an unregistered external directory (AC-5)', async () => {
    const externalDir = path.join(tmpDir, 'external-unregistered');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'sentinel'), 'keep', 'utf8');

    const commands: string[] = [];
    const manager = new GitWorktreeManager(
      executor({ commands, porcelain: porcelainFor(tmpDir, []) })
    );

    const { paths } = await recordRmSync(async () => {
      await assert.rejects(
        async () => {
          await manager.removeWorktree({
            worktreePath: externalDir,
            workspaceDir: tmpDir,
            allowExternal: true
          });
        },
        (err: unknown) => {
          assert.ok(/not a registered/i.test((err as Error).message), (err as Error).message);
          return true;
        }
      );
    });

    assert.strictEqual(fs.readFileSync(path.join(externalDir, 'sentinel'), 'utf8'), 'keep');
    assert.strictEqual(paths.includes(externalDir), false);
    assert.strictEqual(commands.some((c) => c.includes('git worktree remove')), false);
  });

  test('T-I7 refuses an unregistered folder inside .worktrees instead of force-deleting it (AC-5)', async () => {
    const unregistered = path.join(tmpDir, '.worktrees', '777');
    fs.mkdirSync(unregistered, { recursive: true });
    fs.writeFileSync(path.join(unregistered, 'sentinel'), 'keep', 'utf8');

    const commands: string[] = [];
    const manager = new GitWorktreeManager(
      executor({ commands, porcelain: porcelainFor(tmpDir, []) })
    );

    await assert.rejects(
      async () => {
        await manager.removeWorktree({ worktreePath: unregistered, workspaceDir: tmpDir });
      },
      (err: unknown) => {
        assert.ok(/not a registered/i.test((err as Error).message), (err as Error).message);
        return true;
      }
    );

    assert.strictEqual(fs.readFileSync(path.join(unregistered, 'sentinel'), 'utf8'), 'keep');
    assert.strictEqual(commands.some((c) => c.includes('git worktree remove')), false);
  });

  test('T-I8 removes a registered worktree, prunes, and does not fall back (AC-6)', async () => {
    const wtPath = path.join(tmpDir, '.worktrees', '87');
    fs.mkdirSync(wtPath, { recursive: true });

    const commands: string[] = [];
    const manager = new GitWorktreeManager(
      executor({
        commands,
        porcelain: porcelainFor(tmpDir, [wtPath]),
        onRemove: (cmd) => {
          // Simulate git detaching the worktree (empty dir -> rmdir, so the
          // rmSync recorder below can only observe a real fallback call).
          try {
            fs.rmdirSync(wtPath);
          } catch {
            // Ignore
          }
          return makeResult(cmd);
        }
      })
    );

    const { paths } = await recordRmSync(async () => {
      await manager.removeWorktree({ worktreePath: wtPath, workspaceDir: tmpDir, prune: true });
    });

    assert.strictEqual(fs.existsSync(wtPath), false);
    assert.ok(commands.some((c) => c.includes(`git worktree remove --force "${wtPath}"`)));
    assert.ok(commands.some((c) => c === 'git worktree prune'));
    assert.strictEqual(paths.includes(wtPath), false, 'no rmSync fallback for a successful git removal');
  });

  test('T-I9 a registered external worktree with allowExternal is removed by git only (AC-10)', async () => {
    const mainRepoRoot = path.join(tmpDir, 'main');
    fs.mkdirSync(mainRepoRoot, { recursive: true });
    const externalPath = path.join(tmpDir, 'external-282');
    fs.mkdirSync(externalPath, { recursive: true });

    const manager = new GitWorktreeManager(
      executor({
        porcelain: porcelainFor(mainRepoRoot, [externalPath]),
        onRemove: (cmd) => {
          try {
            fs.rmdirSync(externalPath);
          } catch {
            // Ignore
          }
          return makeResult(cmd);
        }
      })
    );

    const { paths } = await recordRmSync(async () => {
      await manager.removeWorktree({
        worktreePath: externalPath,
        workspaceDir: mainRepoRoot,
        allowExternal: true,
        prune: false
      });
    });

    assert.strictEqual(fs.existsSync(externalPath), false);
    assert.strictEqual(paths.includes(externalPath), false, 'git alone must delete an external worktree');
  });

  test('T-I10 a registered external worktree without allowExternal is refused (AC-10)', async () => {
    const mainRepoRoot = path.join(tmpDir, 'main');
    fs.mkdirSync(mainRepoRoot, { recursive: true });
    const externalPath = path.join(tmpDir, 'external-282-refused');
    fs.mkdirSync(externalPath, { recursive: true });
    fs.writeFileSync(path.join(externalPath, 'sentinel'), 'keep', 'utf8');

    const commands: string[] = [];
    const manager = new GitWorktreeManager(
      executor({ commands, porcelain: porcelainFor(mainRepoRoot, [externalPath]) })
    );

    await assert.rejects(
      async () => {
        await manager.removeWorktree({
          worktreePath: externalPath,
          workspaceDir: mainRepoRoot,
          prune: false
        });
      },
      (err: unknown) => {
        assert.ok(/outside .*\.worktrees/i.test((err as Error).message), (err as Error).message);
        return true;
      }
    );

    assert.strictEqual(fs.readFileSync(path.join(externalPath, 'sentinel'), 'utf8'), 'keep');
    assert.strictEqual(commands.some((c) => c.includes('git worktree remove')), false);
  });

  test('T-I12 tolerateMissing resolves and prunes when the directory is already gone (AC-12)', async () => {
    const commands: string[] = [];
    const manager = new GitWorktreeManager(
      executor({ commands, porcelain: porcelainFor(tmpDir, []) })
    );

    await assert.doesNotReject(async () => {
      await manager.removeWorktree({
        worktreePath: path.join(tmpDir, '.worktrees', '555'),
        workspaceDir: tmpDir,
        tolerateMissing: true
      });
    });

    assert.ok(commands.some((c) => c === 'git worktree prune'));
  });

  test('T-I13 surfaces a git failure for a registered in-.worktrees worktree when the fallback cannot delete it (AC-5)', async () => {
    const wtPath = path.join(tmpDir, '.worktrees', '88');
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'sentinel'), 'keep', 'utf8');

    const manager = new GitWorktreeManager(
      executor({
        porcelain: porcelainFor(tmpDir, [wtPath]),
        onRemove: (cmd) =>
          makeResult(cmd, {
            exitCode: 1,
            stderr: 'fatal: worktree is dirty',
            combinedOutput: 'fatal: worktree is dirty'
          })
      })
    );

    const originalRmSync = fs.rmSync;
    // Make the in-.worktrees fallback a no-op: the failure must be decided by
    // git's exit code, not by a post-deletion `existsSync`.
    fs.rmSync = (() => undefined) as typeof fs.rmSync;
    try {
      await assert.rejects(
        async () => {
          await manager.removeWorktree({ worktreePath: wtPath, workspaceDir: tmpDir, prune: false });
        },
        (err: unknown) => {
          assert.ok(/worktree is dirty/.test((err as Error).message), (err as Error).message);
          return true;
        }
      );
    } finally {
      fs.rmSync = originalRmSync;
    }

    assert.strictEqual(fs.readFileSync(path.join(wtPath, 'sentinel'), 'utf8'), 'keep');
  });

  test('T-I14 prunable registrations are refused with remediation (AC-5)', async () => {
    const wtPath = path.join(tmpDir, '.worktrees', '89');
    const prunablePorcelain = `${porcelainFor(tmpDir, [wtPath]).trimEnd()}\nprunable gitdir file points to non-existent location\n`;

    const commands: string[] = [];
    const refusing = new GitWorktreeManager(executor({ commands, porcelain: prunablePorcelain }));

    await assert.rejects(
      async () => {
        await refusing.removeWorktree({ worktreePath: wtPath, workspaceDir: tmpDir });
      },
      (err: unknown) => {
        assert.ok(
          /prunable|worktree prune/i.test((err as Error).message),
          (err as Error).message
        );
        return true;
      }
    );
    assert.strictEqual(commands.some((c) => c.includes('git worktree remove')), false);

    // With `tolerateMissing` the internal teardown still resolves and prunes.
    const tolerantCommands: string[] = [];
    const tolerant = new GitWorktreeManager(
      executor({ commands: tolerantCommands, porcelain: prunablePorcelain })
    );
    await assert.doesNotReject(async () => {
      await tolerant.removeWorktree({
        worktreePath: wtPath,
        workspaceDir: tmpDir,
        tolerateMissing: true
      });
    });
    assert.ok(tolerantCommands.some((c) => c === 'git worktree prune'));
  });
});


/**
 * Issue #266: `quarantineWorktree` used to discard its own recovery reference
 * and to report a failed `git stash` as success. These tests pin the atomic,
 * evidence-returning contract the abort summary depends on.
 */
describe('quarantineWorktree atomicity and recovery evidence (#266)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-wt266-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /** A real git repository with one committed file, plus dirty work. */
  function initRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'smoke@test'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'README.md'), 'probe\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'chore: probe init'], { cwd: dir, stdio: 'ignore' });
  }

  test('B1 returns the stash ref and message a failed stash would otherwise hide (AC-4)', async () => {
    initRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'feature.txt'), 'work in progress\n', 'utf8');

    const manager = new GitWorktreeManager();
    const result = await manager.quarantineWorktree({
      worktreePath: tmpDir,
      taskId: '212',
      workspaceDir: tmpDir
    });

    assert.strictEqual(result.quarantined, true);
    assert.strictEqual(result.outcome, 'stashed');
    assert.strictEqual(result.stashed, true);
    assert.match(result.stashRef || '', /^stash@\{\d+\}$/);
    assert.match(result.stashMessage || '', /^quarantine-abort-task-212-\d+$/);

    const stashList = execFileSync('git', ['stash', 'list'], { cwd: tmpDir, encoding: 'utf8' });
    assert.ok(
      stashList.includes(result.stashMessage),
      `the reported message must identify the stash:\n${stashList}`
    );
    assert.strictEqual(fs.existsSync(path.join(tmpDir, 'feature.txt')), false);
  });

  test('B2 fails atomically when the stash is refused (AC-6)', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const commands: string[] = [];
    const executor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        commands.push(cmd);
        if (cmd === 'git status --porcelain') {
          return makeResult(cmd, { stdout: 'M f.txt\n' });
        }
        if (cmd.startsWith('git stash push')) {
          return makeResult(cmd, { exitCode: 1, stderr: 'stash failed' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(executor);
    const result = await manager.quarantineWorktree({
      worktreePath: tmpDir,
      taskId: '212'
    });

    assert.strictEqual(result.quarantined, false);
    assert.strictEqual(result.outcome, 'failed');
    assert.ok((result.error || '').includes('stash failed'));
    assert.ok(commands.some((c) => c.startsWith('git stash push')));
  });

  test('B3 reports a failed dirty probe instead of "clean" (AC-6)', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const commands: string[] = [];
    const executor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        commands.push(cmd);
        if (cmd === 'git status --porcelain') {
          return makeResult(cmd, { exitCode: 128, stderr: 'not a git repository' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(executor);
    const result = await manager.quarantineWorktree({
      worktreePath: tmpDir,
      taskId: '212'
    });

    assert.strictEqual(result.quarantined, false);
    assert.strictEqual(result.outcome, 'failed');
    assert.ok((result.error || '').includes('not a git repository'));
    assert.strictEqual(
      commands.some((c) => c.startsWith('git stash')),
      false,
      'a failed probe must never reach a destructive command'
    );
  });

  test('B4 branch mode checks every step (AC-6)', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const executor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git status --porcelain') {
          return makeResult(cmd, { stdout: 'M f.txt\n' });
        }
        if (cmd.startsWith('git commit')) {
          return makeResult(cmd, { exitCode: 1, stderr: 'commit refused' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(executor);
    const result = await manager.quarantineWorktree({
      worktreePath: tmpDir,
      taskId: '212',
      quarantineBranch: true
    });

    assert.strictEqual(result.quarantined, false);
    assert.strictEqual(result.outcome, 'failed');
    assert.match(result.branch || '', /^quarantine\/task-212-/);
    assert.ok((result.error || '').includes('commit refused'));
  });

  test('B5 resolveRepositoryRoot returns the main root from inside a linked worktree (AC-9)', async () => {
    initRepo(tmpDir);
    const worktreePath = path.join(tmpDir, '.worktrees', '7');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'task/7-probe', worktreePath], {
      cwd: tmpDir,
      stdio: 'ignore'
    });

    const manager = new GitWorktreeManager();
    const resolved = await manager.resolveRepositoryRoot(worktreePath);

    assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(tmpDir));
  });

  test('B6 quotes every interpolated token so a task id can never execute', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const commands: string[] = [];
    const executor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        commands.push(cmd);
        if (cmd === 'git status --porcelain') {
          return makeResult(cmd, { stdout: 'M f.txt\n' });
        }
        if (cmd.startsWith('git stash push')) {
          return makeResult(cmd);
        }
        if (cmd.startsWith('git stash list')) {
          return makeResult(cmd, { stdout: '' });
        }
        return makeResult(cmd);
      }
    };

    const manager = new GitWorktreeManager(executor);
    await manager.quarantineWorktree({
      worktreePath: tmpDir,
      taskId: "$(touch /tmp/pwned)'; rm -rf /"
    });

    const stashPush = commands.find((c) => c.startsWith('git stash push'));
    assert.ok(stashPush, 'the stash command must have run');
    assert.ok(
      /^git stash push -u -m '.*'$/.test(stashPush as string),
      `the message must be one single-quoted POSIX word:\n${stashPush}`
    );
    assert.ok(
      (stashPush as string).includes("'\\''"),
      `an embedded single quote must be escaped:\n${stashPush}`
    );
    assert.strictEqual(
      (stashPush as string).includes('"'),
      false,
      `no double-quoted word may remain:\n${stashPush}`
    );
  });
});

describe('listWorktrees parses the prunable marker (issue #339 item 5, T5.1 / AC-2.2)', () => {
  function runList(porcelainOutput: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-test-prunable-'));
    const mockExecutor: CommandExecutorPort = {
      execute: async (cmd: string): Promise<CommandExecutionResult> => {
        if (cmd === 'git worktree list --porcelain') {
          return makeResult(cmd, { stdout: porcelainOutput, combinedOutput: porcelainOutput });
        }
        return makeResult(cmd);
      }
    };
    const manager = new GitWorktreeManager(mockExecutor);
    return manager.listWorktrees({ workspaceDir: tmpDir }).then((list: any) => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return list;
    });
  }

  test('a porcelain block with a prunable line yields descriptor.prunable === true', async () => {
    const root = '/repo/root';
    const porcelain = [
      `worktree ${root}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree ${root}/.worktrees/2`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/2',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n');

    const list = await runList(porcelain);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].taskId, '2');
    assert.strictEqual(list[0].prunable, true);
    // Conditional key: a prunable descriptor SERIALISES the key…
    assert.strictEqual(list[0].toJSON().prunable, true);
    // …and `isIsolated` deliberately stays true (the label defect was
    // "active", not "isolated" — Step 5 rationale).
    assert.strictEqual(list[0].isIsolated, true);
  });

  test('a porcelain block without it yields descriptor.prunable === false (key absent)', async () => {
    const root = '/repo/root';
    const porcelain = [
      `worktree ${root}`,
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree ${root}/.worktrees/2`,
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/task/2',
      ''
    ].join('\n');

    const list = await runList(porcelain);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].prunable, false);
    // Conditional key: an ACTIVE descriptor serialises EXACTLY as before.
    assert.strictEqual('prunable' in list[0].toJSON(), false);
  });

  test('a round trip through fromJSON preserves the prunable flag', async () => {
    const active = new (require('../../dist/domain').WorktreeDescriptor)({
      taskId: '2',
      worktreePath: '/repo/root/.worktrees/2',
      branch: 'task/2',
      baseBranch: 'main'
    });
    const round = require('../../dist/domain').WorktreeDescriptor.fromJSON(active.toJSON());
    assert.strictEqual(round.prunable, false);

    const prunable = require('../../dist/domain').WorktreeDescriptor.fromJSON({
      ...active.toJSON(),
      prunable: true
    });
    assert.strictEqual(prunable.prunable, true);
    assert.strictEqual(prunable.toJSON().prunable, true);
  });
});
