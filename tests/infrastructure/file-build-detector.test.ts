/**
 * agyloop - FileBuildDetector Infrastructure Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  FileBuildDetector,
  ECOSYSTEM_NODE,
  ECOSYSTEM_GO,
  ECOSYSTEM_RUST,
  ECOSYSTEM_PYTHON,
  ECOSYSTEM_GRADLE,
  ECOSYSTEM_MAVEN,
  ECOSYSTEM_DOTNET,
  ECOSYSTEM_UNKNOWN,
  DEFAULT_GATE_COMMANDS
} = require('../../dist');

describe('FileBuildDetector (Infrastructure Layer)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-build-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('detects Node.js project with npm and default scripts', async () => {
    const pkgJson = {
      name: 'node-test',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test'
      }
    };
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson), 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.ecosystems.length, 1);
    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_NODE);
    assert.strictEqual(result.primaryEcosystem.packageManager, 'npm');
    assert.strictEqual(result.commands.length, 2);
    assert.strictEqual(result.commands[0].command, 'npm run typecheck');
    assert.strictEqual(result.commands[1].command, 'npm test');
  });

  test('detects pnpm package manager from pnpm-lock.yaml', async () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_NODE);
    assert.strictEqual(result.primaryEcosystem.packageManager, 'pnpm');
    assert.strictEqual(result.commands[0].command, 'pnpm test');
  });

  test('detects yarn package manager from yarn.lock', async () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }), 'utf8');
    fs.writeFileSync(path.join(tempDir, 'yarn.lock'), '', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.packageManager, 'yarn');
    assert.strictEqual(result.commands[0].command, 'yarn test');
  });

  test('detects bun package manager from bun.lockb', async () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }), 'utf8');
    fs.writeFileSync(path.join(tempDir, 'bun.lockb'), '', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.packageManager, 'bun');
    assert.strictEqual(result.commands[0].command, 'bun test');
  });

  test('detects Playwright via playwright.config.ts and script', async () => {
    const pkgJson = {
      scripts: {
        typecheck: 'tsc',
        test: 'vitest',
        'test:e2e': 'playwright test'
      }
    };
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson), 'utf8');
    fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'playwright.config.ts'), 'export default {}', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.commands.length, 3);
    assert.strictEqual(result.commands[0].command, 'pnpm run typecheck');
    assert.strictEqual(result.commands[1].command, 'pnpm test');
    assert.strictEqual(result.commands[2].id, 'playwright');
    assert.strictEqual(result.commands[2].command, 'pnpm run test:e2e');
  });

  test('detects Playwright via playwright.config.js with runner fallback', async () => {
    const pkgJson = {
      scripts: {
        test: 'vitest'
      }
    };
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson), 'utf8');
    fs.writeFileSync(path.join(tempDir, 'playwright.config.js'), 'module.exports = {}', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.commands.length, 2);
    assert.strictEqual(result.commands[0].command, 'npm test');
    assert.strictEqual(result.commands[1].id, 'playwright');
    assert.strictEqual(result.commands[1].command, 'npx playwright test');
  });

  test('detects Go project and commands', async () => {
    fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module example.com/app\n\ngo 1.22\n', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_GO);
    assert.strictEqual(result.commands.length, 2);
    assert.strictEqual(result.commands[0].command, 'go vet ./...');
    assert.strictEqual(result.commands[1].command, 'go test ./...');
  });

  test('detects Rust project and commands', async () => {
    fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname = "rust_app"\nversion = "0.1.0"\n', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_RUST);
    assert.strictEqual(result.commands.length, 2);
    assert.strictEqual(result.commands[0].command, 'cargo check');
    assert.strictEqual(result.commands[1].command, 'cargo test');
  });

  test('detects Python project with pytest', async () => {
    fs.writeFileSync(path.join(tempDir, 'pyproject.toml'), '[tool.pytest.ini_options]\nminversion = "6.0"\n', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_PYTHON);
    assert.strictEqual(result.commands.length, 1);
    assert.strictEqual(result.commands[0].command, 'pytest');
  });

  test('detects Python project with unittest fallback', async () => {
    fs.writeFileSync(path.join(tempDir, 'requirements.txt'), 'requests==2.28.0\nflask==2.2.0\n', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_PYTHON);
    assert.strictEqual(result.commands.length, 1);
    assert.strictEqual(result.commands[0].command, 'python -m unittest');
  });

  test('detects Gradle project with gradlew wrapper', async () => {
    fs.writeFileSync(path.join(tempDir, 'build.gradle.kts'), '// gradle', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'gradlew'), '#!/bin/sh', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_GRADLE);
    assert.strictEqual(result.commands.length, 2);
    assert.strictEqual(result.commands[0].command, './gradlew check');
    assert.strictEqual(result.commands[1].command, './gradlew test');
  });

  test('detects Gradle project without wrapper', async () => {
    fs.writeFileSync(path.join(tempDir, 'build.gradle'), '// gradle', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_GRADLE);
    assert.strictEqual(result.commands.length, 2);
    assert.strictEqual(result.commands[0].command, 'gradle check');
    assert.strictEqual(result.commands[1].command, 'gradle test');
  });

  test('detects Maven project with pom.xml', async () => {
    fs.writeFileSync(path.join(tempDir, 'pom.xml'), '<project></project>', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_MAVEN);
    assert.strictEqual(result.commands.length, 1);
    assert.strictEqual(result.commands[0].command, 'mvn test');
  });

  test('detects .NET project with .csproj', async () => {
    fs.writeFileSync(path.join(tempDir, 'App.csproj'), '<Project></Project>', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_DOTNET);
    assert.strictEqual(result.commands.length, 1);
    assert.strictEqual(result.commands[0].command, 'dotnet test');
  });

  test('detects polyglot multi-ecosystem repository with deterministic prioritization', async () => {
    // Monorepo with Go backend and Node frontend
    fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module app\n', 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', test: 'npm test' } }),
      'utf8'
    );

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.ecosystems.length, 2);
    // Node comes before Go in ECOSYSTEM_PRIORITY_ORDER
    assert.strictEqual(result.ecosystems[0].type, ECOSYSTEM_NODE);
    assert.strictEqual(result.ecosystems[1].type, ECOSYSTEM_GO);
    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_NODE);

    // Commands should include both
    const cmdStrings = result.commands.map((c: { command: string }) => c.command);
    assert.ok(cmdStrings.includes('npm run typecheck'));
    assert.ok(cmdStrings.includes('go test ./...'));
  });

  test('falls back safely for unrecognized repository', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Just docs\n', 'utf8');

    const detector = new FileBuildDetector();
    const result = await detector.detect(tempDir);

    assert.strictEqual(result.ecosystems.length, 0);
    assert.strictEqual(result.primaryEcosystem.type, ECOSYSTEM_UNKNOWN);
    assert.deepStrictEqual(result.commands, DEFAULT_GATE_COMMANDS);
  });

  describe('resolveCommands precedence', () => {
    test('explicit commands override config and auto-detection', async () => {
      fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module app\n', 'utf8');

      const detector = new FileBuildDetector();
      const resolved = await detector.resolveCommands(
        tempDir,
        {
          models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
          options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true, gateCommands: ['echo from-config'] }
        },
        ['echo from-cli']
      );

      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].command, 'echo from-cli');
    });

    test('config overrides take precedence over auto-detection', async () => {
      fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module app\n', 'utf8');

      const detector = new FileBuildDetector();
      const resolved = await detector.resolveCommands(
        tempDir,
        {
          models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
          options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true, gateCommands: ['echo config-override'] }
        }
      );

      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].command, 'echo config-override');
    });

    test('supports quality_gates.commands config override', async () => {
      fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), '[package]\nname = "test"\n', 'utf8');

      const detector = new FileBuildDetector();
      const config = {
        models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
        options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true },
        quality_gates: {
          commands: ['cargo clippy', 'cargo test --release']
        }
      } as any;

      const resolved = await detector.resolveCommands(tempDir, config);
      assert.strictEqual(resolved.length, 2);
      assert.strictEqual(resolved[0].command, 'cargo clippy');
      assert.strictEqual(resolved[1].command, 'cargo test --release');
    });
  });
});
