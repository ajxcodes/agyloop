/**
 * agyloop - InitProjectUseCase Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { InitProjectUseCase } = require('../../dist/application');
const { FileProjectScaffolder, DEFAULT_CONFIG } = require('../../dist/infrastructure');

describe('InitProjectUseCase', () => {
  let dir: string;
  let confirmAnswer: boolean;
  let confirmCalls: number;
  let executedCommands: string[];

  type CommandStub = { stdout?: string; exitCode?: number };

  const BASE_COMMANDS: Record<string, CommandStub> = {
    'git remote': { stdout: 'origin\n' },
    'git symbolic-ref refs/remotes/origin/HEAD': { stdout: 'refs/remotes/origin/develop\n' },
    'git remote get-url origin': { stdout: 'git@github.com:a/b.git\n' }
  };

  // Any command absent from the map exits non-zero, so every new probe must be declared.
  const makeUseCase = (overrides: Record<string, CommandStub> = {}) => {
    const commands: Record<string, CommandStub> = { ...BASE_COMMANDS, ...overrides };
    return new InitProjectUseCase({
      commandExecutor: {
        execute: async (cmd: string) => {
          executedCommands.push(cmd);
          const stub = commands[cmd];
          const exitCode = stub ? stub.exitCode ?? 0 : 1;
          return {
            command: cmd,
            exitCode,
            stdout: exitCode === 0 ? stub?.stdout || '' : '',
            stderr: '',
            combinedOutput: '',
            durationMs: 0,
            timedOut: false
          };
        }
      },
      buildDetector: {
        detect: async () => ({
          workspaceDir: dir,
          ecosystems: ['node'],
          primaryEcosystem: 'node',
          commands: [
            { id: 'typecheck', label: 'Typecheck', command: 'npm run typecheck' },
            { id: 'test', label: 'Test', command: 'npm test' }
          ],
          hasOverrides: false
        })
      },
      scaffolder: new FileProjectScaffolder(),
      confirmationPrompt: {
        confirm: async () => {
          confirmCalls++;
          return confirmAnswer;
        }
      }
    });
  };

  const readWrittenGit = (configPath: string): any => JSON.parse(fs.readFileSync(configPath, 'utf8')).git;
  const branchProbes = (): string[] =>
    executedCommands.filter((c) => c.startsWith('git rev-parse --verify refs/heads/'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-init-'));
    confirmAnswer = false;
    confirmCalls = 0;
    executedCommands = [];
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('generates config with git, verification and defaults', async () => {
    const res = await makeUseCase().execute({ workspaceDir: dir, yes: true });
    assert.strictEqual(res.skipped, false);
    assert.strictEqual(res.configPath, path.join(dir, '.codeloop', 'config.json'));
    const written = JSON.parse(fs.readFileSync(res.configPath, 'utf8'));
    assert.deepStrictEqual(written.git, { remote: 'origin', baseBranch: 'develop', forge: 'github' });
    assert.strictEqual(written.verification.gates.length, 2);
    assert.ok(written.runner && written.models && written.options && written.circuitBreakers);
    assert.ok(res.gitignoreAdded.length > 0);
    const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(!/config\.json/.test(gi));
  });

  test('--dry-run writes nothing', async () => {
    const res = await makeUseCase().execute({ workspaceDir: dir, dryRun: true });
    assert.strictEqual(res.dryRun, true);
    assert.ok(res.config);
    assert.strictEqual(fs.existsSync(path.join(dir, '.codeloop')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, '.gitignore')), false);
  });

  test('skips existing config unless --force, and is idempotent for gitignore', async () => {
    await makeUseCase().execute({ workspaceDir: dir, yes: true });
    const skipped = await makeUseCase().execute({ workspaceDir: dir, interactive: true });
    assert.strictEqual(skipped.skipped, true);
    assert.strictEqual(confirmCalls, 1);

    const forced = await makeUseCase().execute({ workspaceDir: dir, force: true });
    assert.strictEqual(forced.skipped, false);
    assert.deepStrictEqual(forced.gitignoreAdded, []);
  });

  test('migrates legacy .agyloop config with user values winning', async () => {
    fs.mkdirSync(path.join(dir, '.agyloop'));
    const legacy = path.join(dir, '.agyloop', 'config.json');
    fs.writeFileSync(legacy, JSON.stringify({ options: { commitAfter: true }, git: { baseBranch: 'trunk' } }));
    const res = await makeUseCase().execute({ workspaceDir: dir, yes: true });
    assert.strictEqual(res.migratedFrom, legacy);
    assert.strictEqual(res.config.options.commitAfter, true);
    assert.strictEqual(res.config.git.baseBranch, 'trunk');
    assert.strictEqual(res.config.git.forge, 'github');
    assert.ok(fs.existsSync(path.join(dir, '.codeloop', 'config.json')));
  });

  test('generated defaults equal DEFAULT_CONFIG', async () => {
    const res = await makeUseCase().execute({ workspaceDir: dir, dryRun: true });
    for (const key of ['runner', 'opencode', 'models', 'options', 'circuitBreakers']) {
      assert.deepStrictEqual(res.config[key], (DEFAULT_CONFIG as any)[key], key);
    }
  });

  test('non-interactive with existing config skips without prompting', async () => {
    await makeUseCase().execute({ workspaceDir: dir, yes: true });
    const uc = new InitProjectUseCase({
      commandExecutor: { execute: async (cmd: string) => ({ command: cmd, exitCode: 1, stdout: '', stderr: '', combinedOutput: '', durationMs: 0, timedOut: false }) },
      buildDetector: { detect: async () => ({ workspaceDir: dir, ecosystems: [], primaryEcosystem: 'node', commands: [], hasOverrides: false }) },
      scaffolder: new FileProjectScaffolder(),
      confirmationPrompt: { confirm: async () => { throw new Error('prompt must not be called'); } }
    });
    const res = await uc.execute({ workspaceDir: dir, interactive: false });
    assert.strictEqual(res.skipped, true);
  });

  // --- Base branch resolution (issue #218 / AC5) ---------------------------

  test('falls back to the current local branch when origin/HEAD is missing', async () => {
    const res = await makeUseCase({
      'git symbolic-ref refs/remotes/origin/HEAD': { exitCode: 1 },
      'git branch --show-current': { stdout: 'trunk\n' }
    }).execute({ workspaceDir: dir, yes: true });

    assert.strictEqual(readWrittenGit(res.configPath).baseBranch, 'trunk');
    assert.strictEqual(executedCommands.includes('git branch --show-current'), true);
    // A resolved local branch short-circuits the candidate probes.
    assert.deepStrictEqual(branchProbes(), []);
  });

  test('probes develop, master, main, trunk in order when there is no local branch and no origin/HEAD', async () => {
    const res = await makeUseCase({
      'git symbolic-ref refs/remotes/origin/HEAD': { exitCode: 1 },
      'git branch --show-current': { exitCode: 1 },
      'git rev-parse --verify refs/heads/develop': { exitCode: 1 },
      'git rev-parse --verify refs/heads/master': { exitCode: 1 },
      'git rev-parse --verify refs/heads/main': { exitCode: 1 },
      'git rev-parse --verify refs/heads/trunk': { exitCode: 1 }
    }).execute({ workspaceDir: dir, dryRun: true });

    assert.deepStrictEqual(branchProbes(), [
      'git rev-parse --verify refs/heads/develop',
      'git rev-parse --verify refs/heads/master',
      'git rev-parse --verify refs/heads/main',
      'git rev-parse --verify refs/heads/trunk'
    ]);
    assert.strictEqual(res.config.git.baseBranch, 'main');
  });

  test('prefers develop over master when both exist locally', async () => {
    const res = await makeUseCase({
      'git symbolic-ref refs/remotes/origin/HEAD': { exitCode: 1 },
      'git branch --show-current': { exitCode: 1 },
      'git rev-parse --verify refs/heads/develop': { stdout: 'aaa1111\n' },
      'git rev-parse --verify refs/heads/master': { stdout: 'bbb2222\n' }
    }).execute({ workspaceDir: dir, dryRun: true });

    assert.strictEqual(res.config.git.baseBranch, 'develop');
    // First hit wins — the later candidates are never probed.
    assert.deepStrictEqual(branchProbes(), ['git rev-parse --verify refs/heads/develop']);
  });

  test('falls back to main when no candidate branch exists (all probes exit non-zero)', async () => {
    const res = await makeUseCase({
      'git symbolic-ref refs/remotes/origin/HEAD': { exitCode: 1 },
      'git branch --show-current': { exitCode: 1 }
    }).execute({ workspaceDir: dir, yes: true });

    assert.strictEqual(readWrittenGit(res.configPath).baseBranch, 'main');
  });

  test('ignores a detached HEAD reported by git branch --show-current', async () => {
    const res = await makeUseCase({
      'git symbolic-ref refs/remotes/origin/HEAD': { exitCode: 1 },
      'git branch --show-current': { stdout: 'HEAD\n' },
      'git rev-parse --verify refs/heads/master': { stdout: 'ccc3333\n' }
    }).execute({ workspaceDir: dir, dryRun: true });

    assert.strictEqual(res.config.git.baseBranch, 'master');
    assert.deepStrictEqual(branchProbes(), [
      'git rev-parse --verify refs/heads/develop',
      'git rev-parse --verify refs/heads/master'
    ]);
  });

  test('reads origin/HEAD from the resolved remote when the remote is not named origin', async () => {
    const res = await makeUseCase({
      'git remote': { stdout: 'upstream\n' },
      'git symbolic-ref refs/remotes/origin/HEAD': { exitCode: 1 },
      'git symbolic-ref refs/remotes/upstream/HEAD': { stdout: 'refs/remotes/upstream/stable\n' },
      'git remote get-url upstream': { stdout: 'git@github.com:a/b.git\n' }
    }).execute({ workspaceDir: dir, dryRun: true });

    assert.deepStrictEqual(res.config.git, { remote: 'upstream', baseBranch: 'stable', forge: 'github' });
    assert.strictEqual(executedCommands.includes('git symbolic-ref refs/remotes/upstream/HEAD'), true);
    // The hardcoded 'origin' ref is never consulted when it is not the resolved remote.
    assert.strictEqual(
      executedCommands.filter((c) => c.startsWith('git symbolic-ref ')).length,
      1
    );
  });
});
