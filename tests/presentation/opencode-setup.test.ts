const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const {
  installOpenCodeIntegration,
  ensureOpenCodeCommandRegistration
} = require('../../dist/presentation/opencode-setup');
const { runCli, parseArguments } = require('../../dist/presentation/cli');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const writeMockSkill = (baseDir: string): void => {
  const dir = path.join(baseDir, 'integrations', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'codeloop-skill.md'), '# Mock CodeLoop Skill\n', 'utf8');
};

/** Sorted, symlink-aware listing used to prove a directory tree was left untouched. */
const listTree = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: any[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      out.push(path.relative(dir, current) + ' <absent>');
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full) + (entry.isSymbolicLink() ? ' -> ' + fs.readlinkSync(full) : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
};

describe('OpenCode Setup & CLI Integration', () => {
  let tempBaseDir: string;
  let tempTargetDir: string;
  let tempHomeDir: string;
  let tempConfigDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-base-'));
    tempTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-target-'));
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-home-'));
    tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-config-'));

    // Create mock integration asset in base dir
    writeMockSkill(tempBaseDir);
  });

  afterEach(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
    fs.rmSync(tempTargetDir, { recursive: true, force: true });
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    fs.rmSync(tempConfigDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Target layout (AC1)
  // -------------------------------------------------------------------------

  test('installOpenCodeIntegration installs into skills/codeloop/SKILL.md', () => {
    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.ok(result.success);
    assert.strictEqual(path.basename(result.installedPath), 'SKILL.md');
    assert.strictEqual(path.basename(path.dirname(result.installedPath)), 'codeloop');
    assert.strictEqual(result.installedPath, path.join(tempTargetDir, 'codeloop', 'SKILL.md'));
    assert.strictEqual(fs.existsSync(result.installedPath), true);
    const content = fs.readFileSync(result.installedPath, 'utf8');
    assert.ok(content.includes('# Mock CodeLoop Skill'));
    assert.strictEqual(result.degradedReason, null);
  });

  test('defaults to <configDir>/skills when no explicit targetDir is supplied', () => {
    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir
    });

    assert.strictEqual(result.skillsDir, path.join(tempConfigDir, 'skills'));
    assert.strictEqual(result.installedPath, path.join(tempConfigDir, 'skills', 'codeloop', 'SKILL.md'));
    assert.strictEqual(fs.existsSync(result.installedPath), true);
  });

  test('global: false installs into a project-level .opencode tree', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-project-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(projectDir);
      const result = installOpenCodeIntegration({
        baseDir: tempBaseDir,
        homeDir: tempHomeDir,
        global: false
      });

      assert.strictEqual(result.skillsDir, path.join(projectDir, '.opencode', 'skills'));
      assert.strictEqual(result.installedPath, path.join(projectDir, '.opencode', 'skills', 'codeloop', 'SKILL.md'));
      assert.strictEqual(result.configPath, path.join(projectDir, '.opencode', 'opencode.json'));
      assert.strictEqual(result.commandRegistered, true);
      assert.strictEqual(fs.existsSync(result.installedPath), true);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Dangling symlink safety (AC2)
  // -------------------------------------------------------------------------

  test('install result is a real symlink pointing at the canonical source', () => {
    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.strictEqual(result.isSymlink, true);
    assert.strictEqual(fs.lstatSync(result.installedPath).isSymbolicLink(), true);
    assert.strictEqual(fs.readlinkSync(result.installedPath), result.sourcePath);
    assert.strictEqual(fs.readFileSync(result.installedPath, 'utf8').includes('# Mock CodeLoop Skill'), true);
  });

  test('replaces a dangling symlink instead of writing through it', () => {
    const skillDir = path.join(tempTargetDir, 'codeloop');
    fs.mkdirSync(skillDir, { recursive: true });
    const installedPath = path.join(skillDir, 'SKILL.md');

    // A symlink pointing at an asset that no longer exists (the torn-down worktree).
    const deadSource = path.join(tempBaseDir, 'deleted-worktree', 'codeloop-skill.md');
    fs.symlinkSync(deadSource, installedPath);
    assert.strictEqual(fs.existsSync(installedPath), false, 'precondition: link is dangling');
    assert.strictEqual(fs.lstatSync(installedPath).isSymbolicLink(), true);

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.isSymlink, true);
    assert.strictEqual(fs.lstatSync(result.installedPath).isSymbolicLink(), true);
    assert.strictEqual(fs.readlinkSync(result.installedPath), result.sourcePath);
    // The ephemeral worktree must not have been resurrected by a write-through copy.
    assert.strictEqual(fs.existsSync(deadSource), false);
    assert.strictEqual(fs.readFileSync(result.installedPath, 'utf8').includes('# Mock CodeLoop Skill'), true);
  });

  test('replaces a dangling symlink whose target directory is gone', () => {
    const doomed = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-doomed-'));
    const deadSource = path.join(doomed, 'deep', 'codeloop-skill.md');
    const skillDir = path.join(tempTargetDir, 'codeloop');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.symlinkSync(deadSource, path.join(skillDir, 'SKILL.md'));
    fs.rmSync(doomed, { recursive: true, force: true });

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.strictEqual(result.isSymlink, true);
    assert.strictEqual(fs.readlinkSync(result.installedPath), result.sourcePath);
    assert.strictEqual(fs.existsSync(result.installedPath), true);
  });

  test('replaces a regular file at the target path', () => {
    const skillDir = path.join(tempTargetDir, 'codeloop');
    fs.mkdirSync(skillDir, { recursive: true });
    const installedPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(installedPath, 'stale', 'utf8');

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.ok(fs.readFileSync(result.installedPath, 'utf8').includes('# Mock CodeLoop Skill'));
    assert.strictEqual(result.isSymlink, true);
  });

  test('force removes the whole skill directory before reinstalling', () => {
    const skillDir = path.join(tempTargetDir, 'codeloop');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'notes.md'), 'stale sibling', 'utf8');

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir,
      force: true
    });

    assert.strictEqual(fs.existsSync(path.join(skillDir, 'notes.md')), false);
    assert.strictEqual(fs.existsSync(result.installedPath), true);
  });

  test('without force, unrelated sibling files survive', () => {
    const skillDir = path.join(tempTargetDir, 'codeloop');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'notes.md'), 'keep me', 'utf8');

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.strictEqual(fs.existsSync(path.join(skillDir, 'notes.md')), true);
    assert.strictEqual(fs.existsSync(result.installedPath), true);
  });

  // -------------------------------------------------------------------------
  // Worktree canonicalization (AC3)
  // -------------------------------------------------------------------------

  test('canonicalizes baseDir out of a .worktrees/<id> checkout via the git worktree root', () => {
    const repoRoot = path.join(tempBaseDir, 'repo');
    const worktreeDir = path.join(repoRoot, '.worktrees', '218');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    writeMockSkill(repoRoot);
    childProcess.execSync('git init -q', { cwd: repoRoot, stdio: 'ignore' });

    const result = installOpenCodeIntegration({
      baseDir: worktreeDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.strictEqual(result.canonicalizationMethod, 'git-worktree-root');
    assert.strictEqual(result.canonicalBaseDir, fs.realpathSync(repoRoot));
    assert.strictEqual(result.canonicalBaseDir.includes('.worktrees'), false);
    assert.strictEqual(fs.realpathSync(result.installedPath).includes('.worktrees'), false);
    assert.strictEqual(result.sourcePath.includes('.worktrees'), false);
    assert.strictEqual(result.isSymlink, true);
  });

  test('canonicalizes via path walk when git cannot resolve a worktree root', () => {
    const repoRoot = path.join(tempBaseDir, 'repo');
    const worktreeDir = path.join(repoRoot, '.worktrees', '218');
    writeMockSkill(repoRoot);
    // Precondition: the fixture lives outside any git repository.
    assert.throws(() => childProcess.execSync('git rev-parse --show-toplevel', {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore']
    }));

    const result = installOpenCodeIntegration({
      baseDir: worktreeDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.strictEqual(result.canonicalizationMethod, 'worktree-path-walk');
    assert.strictEqual(result.canonicalBaseDir.includes('.worktrees'), false);
    assert.strictEqual(result.sourcePath.includes('.worktrees'), false);
    assert.strictEqual(result.isSymlink, true);
  });

  test('never symlinks into an ephemeral worktree: copies when no canonical root has the asset', () => {
    const repoRoot = path.join(tempBaseDir, 'repo');
    const worktreeDir = path.join(repoRoot, '.worktrees', '218');
    fs.mkdirSync(repoRoot, { recursive: true });
    // Only the ephemeral worktree carries the asset, and it is inside a real git repo.
    writeMockSkill(worktreeDir);
    childProcess.execSync('git init -q', { cwd: repoRoot, stdio: 'ignore' });

    const result = installOpenCodeIntegration({
      baseDir: worktreeDir,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.strictEqual(result.isSymlink, false);
    assert.strictEqual(result.canonicalizationMethod, 'none');
    assert.strictEqual(fs.lstatSync(result.installedPath).isSymbolicLink(), false);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.degradedReason);
    assert.ok(result.degradedReason.includes('.worktrees'));
    assert.ok(fs.readFileSync(result.installedPath, 'utf8').includes('# Mock CodeLoop Skill'));
  });

  test('copy fallback is used when the worktree path cannot be canonicalized at all', () => {
    const nested = path.join(tempBaseDir, 'orphan', '.worktrees', 'outer', '.worktrees', 'inner');
    writeMockSkill(nested);

    const result = installOpenCodeIntegration({
      baseDir: nested,
      targetDir: tempTargetDir,
      configDir: tempConfigDir,
      homeDir: tempHomeDir
    });

    assert.strictEqual(result.canonicalizationMethod, 'none');
    assert.strictEqual(result.isSymlink, false);
    assert.ok(result.degradedReason);
    assert.ok(fs.readFileSync(result.installedPath, 'utf8').includes('# Mock CodeLoop Skill'));
  });

  test('throws when the integration asset is missing entirely', () => {
    assert.throws(
      () => installOpenCodeIntegration({
        baseDir: path.join(tempBaseDir, 'does-not-exist'),
        targetDir: tempTargetDir,
        configDir: tempConfigDir,
        homeDir: tempHomeDir
      }),
      /OpenCode integration asset not found at source path/
    );
  });

  // -------------------------------------------------------------------------
  // Slash command registration (AC1)
  // -------------------------------------------------------------------------

  test('registers command.codeloop on first run', () => {
    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir
    });

    assert.strictEqual(result.commandRegistered, true);
    assert.strictEqual(result.configPath, path.join(tempConfigDir, 'opencode.json'));
    const parsed = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    assert.ok(parsed.command.codeloop);
    assert.ok(parsed.command.codeloop.template.includes('$ARGUMENTS'));
    assert.ok(parsed.command.codeloop.description.length > 0);
  });

  test('command registration is idempotent and leaves an existing entry byte-for-byte alone', () => {
    const configPath = path.join(tempConfigDir, 'opencode.json');
    const userEntry = { description: 'my own command', template: 'do $ARGUMENTS now' };
    fs.writeFileSync(configPath, `${JSON.stringify({ command: { codeloop: userEntry } }, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(configPath, 'utf8');

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir
    });

    assert.strictEqual(result.commandRegistered, false);
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), before);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).command.codeloop, userEntry);
    assert.strictEqual(fs.existsSync(`${configPath}.codeloop.bak`), false);
  });

  test('running install twice is idempotent for the command entry', () => {
    const options = {
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir
    };

    const first = installOpenCodeIntegration(options);
    assert.strictEqual(first.commandRegistered, true);
    const afterFirst = fs.readFileSync(first.configPath, 'utf8');

    const second = installOpenCodeIntegration(options);
    assert.strictEqual(second.commandRegistered, false);
    assert.strictEqual(second.installedPath, first.installedPath);
    assert.strictEqual(fs.readFileSync(second.configPath, 'utf8'), afterFirst);
  });

  test('prefers an existing opencode.jsonc over opencode.json', () => {
    const jsoncPath = path.join(tempConfigDir, 'opencode.jsonc');
    const jsonPath = path.join(tempConfigDir, 'opencode.json');
    fs.writeFileSync(jsoncPath, '{}\n', 'utf8');
    fs.writeFileSync(jsonPath, '{}\n', 'utf8');

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir
    });

    assert.strictEqual(result.configPath, jsoncPath);
    assert.strictEqual(fs.readFileSync(jsonPath, 'utf8'), '{}\n', 'the .json file is left alone');
  });

  test('parses JSONC with line comments, block comments and trailing commas without corrupting the file', () => {
    const configPath = path.join(tempConfigDir, 'opencode.jsonc');
    const raw = [
      '{',
      '  // the model used by every agent',
      '  "model": "anthropic/claude-sonnet-4",',
      '  /* inline block comment */',
      '  "mcp": {',
      '    "local": { "type": "local", "command": ["node", "server.js"] },',
      '  },',
      '  "$schema": "https://opencode.ai/config.json"',
      '}',
      ''
    ].join('\n');
    fs.writeFileSync(configPath, raw, 'utf8');

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir
    });

    assert.strictEqual(result.commandRegistered, true);
    assert.strictEqual(result.configPath, configPath);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(parsed.model, 'anthropic/claude-sonnet-4');
    assert.strictEqual(parsed.mcp.local.command[1], 'server.js');
    assert.strictEqual(parsed.$schema, 'https://opencode.ai/config.json');
    assert.ok(parsed.command.codeloop.template.includes('$ARGUMENTS'));
    // Comments cannot survive a parse/merge/re-serialize cycle; a backup must exist.
    assert.strictEqual(fs.existsSync(`${configPath}.codeloop.bak`), true);
    assert.strictEqual(fs.readFileSync(`${configPath}.codeloop.bak`, 'utf8'), raw);
  });

  test('registers into a BOM-prefixed config instead of warning about a syntax error', () => {
    const configPath = path.join(tempConfigDir, 'opencode.jsonc');
    // Windows editors prepend U+FEFF; `JSON.parse` rejects it, so before the fix the
    // install refused to register and warned about a "parse error" that did not exist.
    const raw = '\uFEFF{\n  "model": "anthropic/claude-sonnet-4"\n}\n';
    fs.writeFileSync(configPath, raw, 'utf8');

    const registration = ensureOpenCodeCommandRegistration(tempConfigDir);

    assert.strictEqual(registration.registered, true, registration.warning ?? '');
    assert.strictEqual(registration.warning, null);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(parsed.model, 'anthropic/claude-sonnet-4');
    assert.ok(parsed.command.codeloop);
  });

  test('does not mistake a URL inside a string literal for a comment', () => {
    const configPath = path.join(tempConfigDir, 'opencode.jsonc');
    const raw = '{\n  "docs": "https://example.com/a//b/*not-a-comment*/",\n  "x": 1\n}\n';
    fs.writeFileSync(configPath, raw, 'utf8');

    const registration = ensureOpenCodeCommandRegistration(tempConfigDir);

    assert.strictEqual(registration.registered, true);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(parsed.docs, 'https://example.com/a//b/*not-a-comment*/');
    assert.ok(parsed.command.codeloop);
  });

  test('backs up an existing config that contained comments before rewriting', () => {
    const configPath = path.join(tempConfigDir, 'opencode.jsonc');
    const raw = '{\n  // keep me\n  "model": "x"\n}\n';
    fs.writeFileSync(configPath, raw, 'utf8');

    const registration = ensureOpenCodeCommandRegistration(tempConfigDir);

    assert.strictEqual(registration.registered, true);
    assert.strictEqual(registration.warning, null);
    assert.strictEqual(fs.readFileSync(`${configPath}.codeloop.bak`, 'utf8'), raw);
    assert.ok(JSON.parse(fs.readFileSync(configPath, 'utf8')).command.codeloop);
  });

  test('never clobbers an unparseable config', () => {
    const configPath = path.join(tempConfigDir, 'opencode.jsonc');
    const raw = '{ this is not json';
    fs.writeFileSync(configPath, raw, 'utf8');

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir
    });

    assert.strictEqual(result.commandRegistered, false);
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), raw);
    assert.ok(result.degradedReason);
    assert.ok(result.degradedReason.includes('left untouched'));
    assert.ok(result.warnings.some((w: string) => w.includes('left untouched')));
  });

  test('refuses to merge when the config has a non-object command value', () => {
    const configPath = path.join(tempConfigDir, 'opencode.json');
    const raw = '{ "command": "nope" }';
    fs.writeFileSync(configPath, raw, 'utf8');

    const registration = ensureOpenCodeCommandRegistration(tempConfigDir);

    assert.strictEqual(registration.registered, false);
    assert.ok(registration.warning);
    assert.ok(registration.warning.includes('left untouched'));
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), raw);
  });

  test('preserves unrelated config keys and other command entries', () => {
    const configPath = path.join(tempConfigDir, 'opencode.json');
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ model: 'anthropic/claude-sonnet-4', command: { other: { template: 'x' } } }, null, 2)}\n`,
      'utf8'
    );

    const registration = ensureOpenCodeCommandRegistration(tempConfigDir);

    assert.strictEqual(registration.registered, true);
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.strictEqual(parsed.model, 'anthropic/claude-sonnet-4');
    assert.deepStrictEqual(parsed.command.other, { template: 'x' });
    assert.ok(parsed.command.codeloop);
  });

  test('honours registerCommand: false and creates no config file', () => {
    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir,
      registerCommand: false
    });

    assert.strictEqual(result.commandRegistered, false);
    assert.strictEqual(result.configPath, null);
    assert.strictEqual(fs.readdirSync(tempConfigDir).length, 0);
  });

  test('reads the command payload from integrations/opencode/codeloop-command.json', () => {
    const asset = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'opencode', 'codeloop-command.json'), 'utf8')
    );
    assert.ok(typeof asset.description === 'string' && asset.description.length > 0);
    assert.ok(asset.template.includes('$ARGUMENTS'));

    const result = installOpenCodeIntegration({
      baseDir: REPO_ROOT,
      targetDir: tempTargetDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir,
      registerCommand: false
    });
    assert.strictEqual(result.commandRegistered, false);
  });

  // -------------------------------------------------------------------------
  // Legacy residue cleanup
  // -------------------------------------------------------------------------

  test('removes the legacy ~/.opencode/skills/codeloop.md residue on a global install', () => {
    const legacyDir = path.join(tempHomeDir, '.opencode', 'skills');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'codeloop.md');
    fs.symlinkSync(path.join(tempBaseDir, 'gone', 'codeloop-skill.md'), legacyPath);

    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      homeDir: tempHomeDir,
      configDir: tempConfigDir
    });

    assert.strictEqual(fs.existsSync(legacyPath), false);
    assert.throws(() => fs.lstatSync(legacyPath), /ENOENT/);
    assert.ok(result.installedPath.startsWith(tempConfigDir));
  });

  // -------------------------------------------------------------------------
  // Skill asset (AC1)
  // -------------------------------------------------------------------------

  test('skill frontmatter declares metadata["opencode/slash"] = "true"', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, 'integrations', 'opencode', 'codeloop-skill.md'),
      'utf8'
    );
    assert.ok(raw.startsWith('---\n'));
    const frontmatter = raw.slice(4, raw.indexOf('\n---', 4));
    assert.ok(/^name:\s*codeloop\s*$/m.test(frontmatter), 'skill name must match the install directory');
    assert.ok(/opencode\/slash:\s*"true"/.test(frontmatter));
  });

  test('skill asset no longer advertises the removed gates subcommand', () => {
    const raw = fs.readFileSync(
      path.join(REPO_ROOT, 'integrations', 'opencode', 'codeloop-skill.md'),
      'utf8'
    );
    assert.ok(!/`codeloop gates?`/.test(raw), 'the `codeloop gates` bullet was removed from the CLI');
    assert.ok(raw.includes('codeloop next --json'));
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  test('parseArguments parses opencode subcommand and --model flag', () => {
    const parsed1 = parseArguments(['opencode', 'install']);
    assert.strictEqual(parsed1.command, 'opencode');
    assert.strictEqual(parsed1.options.opencodeSubcommand, 'install');

    const parsed2 = parseArguments(['--model', 'ornith:9b-128k', 'plan', '42']);
    assert.strictEqual(parsed2.options.model, 'ornith:9b-128k');
    assert.strictEqual(parsed2.command, 'plan');
    assert.strictEqual(parsed2.options.issue, '42');
  });

  test('runCli opencode install executes successfully without touching the real $HOME', async () => {
    // Capture the real home BEFORE redirecting it so the non-pollution assertion is real.
    const realHome = os.homedir();
    const snapshotRealHome = () => ({
      legacy: listTree(path.join(realHome, '.opencode')),
      config: listTree(path.join(realHome, '.config', 'opencode'))
    });
    const before = snapshotRealHome();

    const prevHome = process.env.HOME;
    const original = console.log;
    try {
      console.log = () => {};
      // os.homedir() honours $HOME on POSIX.
      process.env.HOME = tempHomeDir;
      const exitCode = await runCli(['opencode', 'install']);
      assert.strictEqual(exitCode, 0);

      const configDir = path.join(tempHomeDir, '.config', 'opencode');
      assert.strictEqual(fs.existsSync(path.join(configDir, 'skills', 'codeloop', 'SKILL.md')), true);
      assert.ok(fs.existsSync(path.join(configDir, 'opencode.json')));
    } finally {
      console.log = original;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }

    // Regression guard: the pre-#218 test wrote into the developer's real home directory.
    assert.deepStrictEqual(snapshotRealHome(), before);
  });

  test('runCli opencode install surfaces a degraded install without failing', async () => {
    const prevHome = process.env.HOME;
    const original = console.log;
    const lines: string[] = [];
    try {
      console.log = (...args) => lines.push(args.join(' '));
      process.env.HOME = tempHomeDir;
      const configDir = path.join(tempHomeDir, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'opencode.jsonc'), '{ not json', 'utf8');

      const exitCode = await runCli(['opencode', 'install']);
      assert.strictEqual(exitCode, 0);
      const output = lines.join('\n');
      assert.ok(output.includes('Workspace:'));
      assert.ok(output.includes('Command  :'));
      assert.ok(output.includes('left untouched'));
      assert.strictEqual(fs.readFileSync(path.join(configDir, 'opencode.jsonc'), 'utf8'), '{ not json');
    } finally {
      console.log = original;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});
