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

  const makeUseCase = () =>
    new InitProjectUseCase({
      commandExecutor: {
        execute: async (cmd: string) => {
          const out: Record<string, string> = {
            'git remote': 'origin\n',
            'git symbolic-ref refs/remotes/origin/HEAD': 'refs/remotes/origin/develop\n',
            'git remote get-url origin': 'git@github.com:a/b.git\n'
          };
          return { command: cmd, exitCode: cmd in out ? 0 : 1, stdout: out[cmd] || '', stderr: '', combinedOutput: '', durationMs: 0, timedOut: false };
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

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-init-'));
    confirmAnswer = false;
    confirmCalls = 0;
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
});
