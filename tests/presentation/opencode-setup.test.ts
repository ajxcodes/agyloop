const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { installOpenCodeIntegration } = require('../../dist/presentation/opencode-setup');
const { runCli, parseArguments } = require('../../dist/presentation/cli');

describe('OpenCode Setup & CLI Integration', () => {
  let tempBaseDir: string;
  let tempTargetDir: string;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-base-'));
    tempTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeloop-target-'));

    // Create mock integration asset in base dir
    const opencodeDir = path.join(tempBaseDir, 'integrations', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(path.join(opencodeDir, 'codeloop-skill.md'), '# Mock CodeLoop Skill\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
    fs.rmSync(tempTargetDir, { recursive: true, force: true });
  });

  test('installOpenCodeIntegration creates symlink/file in target directory', () => {
    const result = installOpenCodeIntegration({
      baseDir: tempBaseDir,
      targetDir: tempTargetDir
    });

    assert.ok(result.success);
    assert.strictEqual(fs.existsSync(result.installedPath), true);
    assert.strictEqual(path.basename(result.installedPath), 'codeloop.md');
    const content = fs.readFileSync(result.installedPath, 'utf8');
    assert.ok(content.includes('# Mock CodeLoop Skill'));
  });

  test('parseArguments parses opencode subcommand and --model flag', () => {
    const parsed1 = parseArguments(['opencode', 'install']);
    assert.strictEqual(parsed1.command, 'opencode');
    assert.strictEqual(parsed1.options.opencodeSubcommand, 'install');

    const parsed2 = parseArguments(['--model', 'ornith:9b-128k', 'plan', '42']);
    assert.strictEqual(parsed2.options.model, 'ornith:9b-128k');
    assert.strictEqual(parsed2.command, 'plan');
    assert.strictEqual(parsed2.options.issue, '42');
  });

  test('runCli opencode install executes successfully', async () => {
    const exitCode = await runCli(['opencode', 'install']);
    assert.strictEqual(exitCode, 0);
  });
});
