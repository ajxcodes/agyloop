/**
 * codeloop - external target repository config contract (#333 AC7)
 *
 * This is the end-to-end guard the issue asks for: initialise a *recognisable*
 * external project with `codeloop init --yes`, then prove the runtime consumes
 * what `init` wrote.
 *
 * Deliberately NOT asserted: any ecosystem-specific command string (`npm test`,
 * `npm run typecheck`, …). #334 owns what `init` scaffolds; this suite only
 * guards that the scaffolding is executed rather than ignored.
 *
 *   EXT-333-1 init writes the gates the gate plan executes
 *   EXT-333-2 the task worktree is cut from config.git.baseBranch
 *   EXT-333-3 the config is readable from inside the provisioned worktree
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'codeloop.js');

const { FileConfigRepository, FileBuildDetector, GitWorktreeManager, ProcessCommandExecutor } = require('../../dist/infrastructure');
const { InferBaseBranchUseCase } = require('../../dist/application');

const SENTINEL_COMMAND = 'echo AC-333-CONFIG-GATE';
const CONFIGURED_BASE = 'develop';
const SANDBOXES: string[] = [];

afterEach(() => {
  for (const dir of SANDBOXES) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  SANDBOXES.length = 0;
});

/**
 * Seeds an external git repository, runs the real `codeloop init`, then
 * overwrites the scaffolded verification profile with a sentinel gate so the
 * assertion cannot depend on which ecosystem commands `init` chose. The
 * configured base branch is a real branch in the sandbox.
 */
function initWithExternalRepo(): {
  workspace: string;
  configPath: string;
  written: any;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-external-repo-'));
  SANDBOXES.push(base);

  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'smoke@example.test'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'smoke'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'README.md'), 'seed\n', 'utf8');
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'ac333-sandbox', version: '1.0.0', scripts: { test: 'node --test' } }),
    'utf8'
  );
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'chore: seed'], { cwd: workspace });

  execFileSync(process.execPath, [CLI_PATH, 'init', '--yes', '--workspace', workspace], {
    cwd: workspace,
    encoding: 'utf8'
  });

  const configPath = path.join(workspace, '.codeloop', 'config.json');
  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // The fixture must be recognisable enough that init scaffolds a gate list.
  assert.ok(
    Array.isArray(written.verification.gates) && written.verification.gates.length > 0,
    'init must scaffold verification.gates for a recognisable project'
  );

  execFileSync('git', ['branch', CONFIGURED_BASE], { cwd: workspace });

  written.verification.gates = [
    { id: 'ac-333', label: 'AC-333 config gate', command: SENTINEL_COMMAND }
  ];
  written.git = {
    ...(written.git || {}),
    remote: 'origin',
    baseBranch: CONFIGURED_BASE,
    forge: 'generic'
  };
  fs.writeFileSync(configPath, JSON.stringify(written, null, 2) + '\n', 'utf8');

  return { workspace, configPath, written };
}

describe('external repository config contract (#333 AC7)', () => {
  test('EXT-333-1 init writes the gates the gate plan executes (#333 AC7)', async () => {
    const { workspace } = initWithExternalRepo();

    const configRepo = new FileConfigRepository();
    const config = configRepo.loadConfig({ cwd: workspace });
    const plan = await new FileBuildDetector().resolveCommandPlan(workspace, config);

    assert.strictEqual(plan.source, 'config');
    assert.strictEqual(plan.commands[0].command, SENTINEL_COMMAND);
  });

  test('EXT-333-2 the task worktree is cut from config.git.baseBranch (#333 AC7)', async () => {
    const { workspace } = initWithExternalRepo();

    const configRepo = new FileConfigRepository();
    const manager = new GitWorktreeManager(new ProcessCommandExecutor());
    const inference = await new InferBaseBranchUseCase(
      manager,
      undefined,
      undefined,
      configRepo
    ).execute({ issueNumber: 333, workspaceDir: workspace, persist: false });

    assert.strictEqual(inference.baseBranch, CONFIGURED_BASE, 'the configured base must win');

    const worktree = await manager.createWorktree({
      taskId: 333,
      baseBranch: inference.baseBranch,
      workspaceDir: workspace
    });

    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree.worktreePath,
      encoding: 'utf8'
    }).trim();
    const baseSha = execFileSync('git', ['rev-parse', CONFIGURED_BASE], {
      cwd: workspace,
      encoding: 'utf8'
    }).trim();

    assert.strictEqual(headSha, baseSha);
  });

  test('EXT-333-3 the config is readable from inside the provisioned worktree (#333 AC7)', async () => {
    const { workspace } = initWithExternalRepo();

    const manager = new GitWorktreeManager(new ProcessCommandExecutor());
    const worktree = await manager.createWorktree({
      taskId: 333,
      baseBranch: CONFIGURED_BASE,
      workspaceDir: workspace
    });

    const fromWorktree = new FileConfigRepository().loadConfig({ cwd: worktree.worktreePath });

    assert.strictEqual(fromWorktree.git.baseBranch, CONFIGURED_BASE);
  });
});
