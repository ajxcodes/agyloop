/**
 * agyloop - FileBuildDetector Infrastructure Tests
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('node:net');
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
  DEFAULT_GATE_COMMANDS,
  CMD_ID_ACT,
  CMD_LABEL_ACT
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

  describe('Act & Container Quality Gates (AC1 - AC5)', () => {
    test('AC1: detects .github/workflows directory and checks act binary presence', () => {
      const workflowsDir = path.join(tempDir, '.github', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'ci.yml'), 'name: CI\n', 'utf8');

      const detector = new FileBuildDetector();
      assert.strictEqual(fs.existsSync(path.join(tempDir, '.github', 'workflows')), true);
      assert.strictEqual(typeof detector.hasActBinary(), 'boolean');
      assert.strictEqual(typeof FileBuildDetector.hasActBinary(), 'boolean');
    });

    test('AC2: parses .agyloop.json options for containerGates and act config overrides', async () => {
      const workflowsDir = path.join(tempDir, '.github', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDir, 'test.yml'), 'name: Test\n', 'utf8');

      const detector = new FileBuildDetector();
      // Stub hasActBinary and the runtime probe to ensure deterministic resolution
      detector.hasActBinary = () => true;
      detector.resolveContainerSocket = () => ({ socketPath: 'unix:///var/run/docker.sock', runtime: 'docker' });

      const config = {
        models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
        options: {
          commitAfter: false,
          gateTimeoutSeconds: 300,
          autoApproveInYolo: true,
          enableMcpInPlanner: true,
          containerGates: true,
          act: {
            enabled: true,
            workflow: '.github/workflows/test.yml',
            job: 'test-job'
          }
        }
      };

      const resolved = await detector.resolveCommands(tempDir, config);
      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].id, CMD_ID_ACT);
      assert.strictEqual(resolved[0].label, CMD_LABEL_ACT);
      assert.strictEqual(resolved[0].command, 'act -W .github/workflows/test.yml -j test-job');
    });

    test('AC3: detects Docker vs Podman daemon socket and appends --container-daemon-socket for Podman', async () => {
      const workflowsDir = path.join(tempDir, '.github', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });

      const detector = new FileBuildDetector();
      detector.hasActBinary = () => true;

      // When Podman socket is resolved (the probe must honour this seam).
      detector.resolveContainerRuntime = () => 'podman';
      detector.resolveContainerSocket = () => ({
        socketPath: 'unix:///run/user/1000/podman/podman.sock',
        runtime: 'podman'
      });

      const config = {
        models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
        options: {
          commitAfter: false,
          gateTimeoutSeconds: 300,
          autoApproveInYolo: true,
          enableMcpInPlanner: true,
          act: {
            enabled: true,
            workflow: '.github/workflows/ci.yml'
          }
        }
      };

      const resolved = await detector.resolveCommands(tempDir, config);
      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(
        resolved[0].command,
        'act -W .github/workflows/ci.yml --container-daemon-socket unix:///run/user/1000/podman/podman.sock'
      );
    });

    test('AC4: act command replaces or precedes standard gate commands when container gates are active', async () => {
      // Create node package so normal detect would return npm test
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
      const workflowsDir = path.join(tempDir, '.github', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });

      const detector = new FileBuildDetector();
      detector.hasActBinary = () => true;
      detector.resolveContainerRuntime = () => 'docker';
      detector.resolveContainerSocket = () => ({ socketPath: 'unix:///var/run/docker.sock', runtime: 'docker' });

      const detected = await detector.detect(tempDir, {
        models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
        options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true, containerGates: true }
      });

      assert.strictEqual(detected.commands[0].id, CMD_ID_ACT);
    });

    test('AC5: gracefully falls back to host verification commands if act or container socket is unavailable', async () => {
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
      const workflowsDir = path.join(tempDir, '.github', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });

      const detector = new FileBuildDetector();
      // Case A: Act binary missing
      detector.hasActBinary = () => false;
      detector.resolveContainerSocket = () => ({ socketPath: 'unix:///var/run/docker.sock', runtime: 'docker' });

      const resolvedNoAct = await detector.resolveCommands(tempDir, {
        models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
        options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true, containerGates: true }
      });
      assert.strictEqual(resolvedNoAct.length, 1);
      assert.strictEqual(resolvedNoAct[0].command, 'npm test');

      // Case B: no usable container runtime (#295 — a missing socket is not
      // evidence; the runtime health probe decides and fails closed here).
      detector.hasActBinary = () => true;
      detector.resolveContainerSocket = () => null;
      detector.probeContainerRuntime = () => null;

      const resolvedNoSocket = await detector.resolveCommands(tempDir, {
        models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
        options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true, containerGates: true }
      });
      assert.strictEqual(resolvedNoSocket.length, 1);
      assert.strictEqual(resolvedNoSocket[0].command, 'npm test');

      // Case C: containerGates explicitly set to false
      detector.hasActBinary = () => true;
      detector.resolveContainerSocket = () => ({ socketPath: 'unix:///var/run/docker.sock', runtime: 'docker' });
      const resolvedDisabled = await detector.resolveCommands(tempDir, {
        models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
        options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true, containerGates: false }
      });
      assert.strictEqual(resolvedDisabled.length, 1);
      assert.strictEqual(resolvedDisabled[0].command, 'npm test');
    });

    test('isBinaryAvailable uses where on win32 and which on other platforms', () => {
      const childProcess = require('child_process');
      const originalSpawnSync = childProcess.spawnSync;
      const originalPlatform = process.platform;

      let capturedCmd: string | null = null;
      let capturedArgs: string[] = [];

      try {
        childProcess.spawnSync = (cmd: string, args: string[]) => {
          capturedCmd = cmd;
          capturedArgs = args;
          return { status: 0 };
        };

        // Test non-win32 platform
        Object.defineProperty(process, 'platform', { value: 'linux' });
        assert.strictEqual(FileBuildDetector.isBinaryAvailable('docker'), true);
        assert.strictEqual(capturedCmd, 'which');
        assert.deepStrictEqual(capturedArgs, ['docker']);

        // Test win32 platform
        Object.defineProperty(process, 'platform', { value: 'win32' });
        assert.strictEqual(FileBuildDetector.isBinaryAvailable('docker'), true);
        assert.strictEqual(capturedCmd, 'where');
        assert.deepStrictEqual(capturedArgs, ['docker']);
      } finally {
        childProcess.spawnSync = originalSpawnSync;
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('DOCKER_HOST endpoint resolution (Issue #232)', () => {
    const savedEnv: { DOCKER_HOST?: string; XDG_RUNTIME_DIR?: string } = {};

    beforeEach(() => {
      savedEnv.DOCKER_HOST = process.env.DOCKER_HOST;
      savedEnv.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
      // Isolate the podman branch with an empty XDG runtime dir
      process.env.XDG_RUNTIME_DIR = path.join(tempDir, 'xdg');
      fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
    });

    afterEach(() => {
      if (savedEnv.DOCKER_HOST === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = savedEnv.DOCKER_HOST;
      if (savedEnv.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedEnv.XDG_RUNTIME_DIR;
    });

    /**
     * Runs `body` with `/var/run/docker.sock` stubbed absent (host-machine determinism)
     * and `console.warn` captured. ALWAYS restores both in a finally block (rule: sibling
     * tests share the same process, so stubs must never leak).
     */
    async function withIsolatedFs<T>(body: (warnings: string[]) => T): Promise<T> {
      const originalExistsSync = fs.existsSync;
      const originalWarn = console.warn;
      const warnings: string[] = [];
      fs.existsSync = (p: any) => (String(p) === '/var/run/docker.sock' ? false : originalExistsSync(p));
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        return await body(warnings);
      } finally {
        fs.existsSync = originalExistsSync;
        console.warn = originalWarn;
      }
    }

    test('T1: a dead DOCKER_HOST unix socket resolves to null WITHOUT a warning (#295: pure)', async () => {
      process.env.DOCKER_HOST = `unix://${path.join(tempDir, 'missing.sock')}`;

      await withIsolatedFs(async (warnings) => {
        assert.strictEqual(FileBuildDetector.resolveContainerSocket(), null);
        assert.deepStrictEqual(warnings, [], 'socket resolution must not warn; resolveActCommand owns the warning');
      });
    });

    test('T2: DOCKER_HOST pointing at a non-socket path resolves to null WITHOUT a warning', async () => {
      const regularFile = path.join(tempDir, 'not-a-socket');
      fs.writeFileSync(regularFile, 'definitely not a socket', 'utf8');
      process.env.DOCKER_HOST = `unix://${regularFile}`;

      await withIsolatedFs(async (warnings) => {
        assert.strictEqual(FileBuildDetector.resolveContainerSocket(), null);
        assert.deepStrictEqual(warnings, [], 'a non-socket path is not a warning site');
      });
    });

    test('T3: live unix socket passes through verbatim with runtime docker', async () => {
      const liveSock = path.join(tempDir, 'live.sock');
      process.env.DOCKER_HOST = `unix://${liveSock}`;
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(liveSock, resolve);
      });
      try {
        await withIsolatedFs(async () => {
          assert.deepStrictEqual(FileBuildDetector.resolveContainerSocket(), {
            socketPath: `unix://${liveSock}`,
            runtime: 'docker'
          });
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(liveSock, { force: true });
      }
    });

    test('T4: non-unix DOCKER_HOST schemes pass through unchanged', async () => {
      process.env.DOCKER_HOST = 'tcp://127.0.0.1:2375';

      await withIsolatedFs(async () => {
        assert.deepStrictEqual(FileBuildDetector.resolveContainerSocket(), {
          socketPath: 'tcp://127.0.0.1:2375',
          runtime: 'docker'
        });
      });
    });

    test('T5: DOCKER_HOST unset with no local sockets resolves to null', async () => {
      delete process.env.DOCKER_HOST;

      await withIsolatedFs(async () => {
        assert.strictEqual(FileBuildDetector.resolveContainerSocket(), null);
      });
    });

    test('T6: a DEAD runtime skips the act gate and falls back to host commands', async () => {
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });
      process.env.DOCKER_HOST = `unix://${path.join(tempDir, 'missing.sock')}`;

      const detector = new FileBuildDetector();
      detector.hasActBinary = () => true;
      // #295: the runtime is what decides availability, and this one is dead.
      detector.resolveContainerRuntime = () => 'docker';
      detector.probeContainerRuntime = () => null;
      const config = {
        models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
        options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true }
      };

      await withIsolatedFs(async (warnings) => {
        assert.strictEqual(detector.resolveActCommand(tempDir, config), null);
        assert.strictEqual(warnings.length, 1, 'exactly one container warning, at gate selection only');
        assert.ok(warnings[0].includes('no usable container runtime'));

        const resolved = await detector.resolveCommands(tempDir, config);
        assert.strictEqual(resolved.length, 1);
        assert.strictEqual(resolved[0].command, 'npm test');
        assert.ok(resolved.every((c: { id: string }) => c.id !== CMD_ID_ACT));
      });
    });

    test('T7: a HEALTHY runtime with no socket probes as fork-exec and act gets no socket flag (#295)', async () => {
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });
      process.env.XDG_RUNTIME_DIR = path.join(tempDir, 'xdg');
      fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
      process.env.DOCKER_HOST = `unix://${path.join(tempDir, 'missing.sock')}`;

      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const podman = path.join(binDir, 'podman');
      fs.writeFileSync(podman, '#!/bin/sh\nexit 0\n', 'utf8');
      fs.chmodSync(podman, 0o755);
      const prevPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;

      try {
        await withIsolatedFs(async () => {
          const probe = FileBuildDetector.probeContainerRuntime();
          assert.deepStrictEqual(probe, {
            runtime: 'podman',
            socketPath: null,
            connection: 'fork-exec'
          });

          const detector = new FileBuildDetector();
          detector.hasActBinary = () => true;
          const actCommand = detector.resolveActCommand(tempDir, {
            models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
            options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true }
          });
          assert.strictEqual(actCommand.id, CMD_ID_ACT);
          assert.strictEqual(actCommand.command, 'act');
          assert.ok(!actCommand.command.includes('--container-daemon-socket'));
        });
      } finally {
        process.env.PATH = prevPath;
      }
    });

    test('T8: a runtime that FAILS its native probe is a clear skip, never a hard failure (#295/#232)', async () => {
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });
      process.env.XDG_RUNTIME_DIR = path.join(tempDir, 'xdg');
      fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true });
      process.env.DOCKER_HOST = `unix://${path.join(tempDir, 'missing.sock')}`;

      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const podman = path.join(binDir, 'podman');
      fs.writeFileSync(podman, '#!/bin/sh\nexit 1\n', 'utf8');
      fs.chmodSync(podman, 0o755);
      const prevPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;

      try {
        await withIsolatedFs(async (warnings) => {
          assert.strictEqual(FileBuildDetector.probeContainerRuntime(), null);

          const detector = new FileBuildDetector();
          detector.hasActBinary = () => true;
          const config = {
            models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
            options: { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true }
          };
          assert.strictEqual(detector.resolveActCommand(tempDir, config), null);
          assert.strictEqual(warnings.length, 1);

          const resolved = await detector.resolveCommands(tempDir, config);
          assert.strictEqual(resolved.length, 1);
          assert.strictEqual(resolved[0].command, 'npm test');
        });
      } finally {
        process.env.PATH = prevPath;
      }
    });

    test('T9: a read-only command emits no container warning (#295: warning only at gate selection)', () => {
      const { spawnSync } = require('node:child_process');
      const repoRoot = path.resolve(__dirname, '..', '..');
      fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), { recursive: true });
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const podman = path.join(binDir, 'podman');
      fs.writeFileSync(podman, '#!/bin/sh\nexit 1\n', 'utf8');
      fs.chmodSync(podman, 0o755);
      fs.mkdirSync(path.join(tempDir, '.home'), { recursive: true });

      const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'codeloop.js'), 'status'], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          HOME: path.join(tempDir, '.home'),
          DOCKER_HOST: `unix://${path.join(tempDir, 'missing.sock')}`,
          XDG_RUNTIME_DIR: path.join(tempDir, 'xdg'),
          AGY_SUBAGENT: ''
        }
      });

      assert.ok(
        !`${result.stderr}`.includes('container'),
        `a read-only command must not warn about the container runtime, got:\n${result.stderr}`
      );
    });
  });
});

describe('FileBuildDetector - lint and command-plan provenance (issue #298)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agyloop-build-lint-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writePackage(scripts: Record<string, string>, lockfile?: string): void {
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'lint-probe', scripts }), 'utf8');
    if (lockfile) {
      fs.writeFileSync(path.join(tempDir, lockfile), '', 'utf8');
    }
  }

  function configWith(commands: string[]): any {
    return {
      models: { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' },
      options: {
        commitAfter: false,
        gateTimeoutSeconds: 300,
        autoApproveInYolo: true,
        enableMcpInPlanner: true,
        gateCommands: commands
      }
    };
  }

  test('FBD-L1: the Node detector emits typecheck, lint, test in that order', async () => {
    writePackage({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'node --test' });

    const detected = await new FileBuildDetector().detect(tempDir);

    assert.deepStrictEqual(
      detected.commands.map((cmd: any) => cmd.command),
      ['npm run typecheck', 'npm run lint', 'npm test']
    );
    assert.deepStrictEqual(
      detected.commands.map((cmd: any) => cmd.id),
      ['typecheck', 'lint', 'test']
    );
  });

  test('FBD-L2: no lint script means no lint command', async () => {
    writePackage({ typecheck: 'tsc --noEmit', test: 'node --test' });

    const detected = await new FileBuildDetector().detect(tempDir);

    assert.ok(!detected.commands.some((cmd: any) => cmd.command.split(/\s+/).includes('lint')));
  });

  test('FBD-P1: precedence is explicit > plan > config > auto-detect', async () => {
    writePackage({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'node --test' });
    const detector = new FileBuildDetector();

    const explicit = await detector.resolveCommandPlan(tempDir, configWith(['echo config']), {
      explicitCommands: ['echo explicit'],
      planTargets: ['echo plan']
    });
    assert.strictEqual(explicit.source, 'explicit');
    assert.strictEqual(explicit.commands[0].command, 'echo explicit');

    const plan = await detector.resolveCommandPlan(tempDir, configWith(['echo config']), {
      planTargets: ['echo plan']
    });
    assert.strictEqual(plan.source, 'plan');
    assert.deepStrictEqual(
      plan.commands.map((cmd: any) => cmd.command),
      ['echo plan', 'npm run lint']
    );

    const config = await detector.resolveCommandPlan(tempDir, configWith(['echo config']));
    assert.strictEqual(config.source, 'config');

    const detected = await detector.resolveCommandPlan(tempDir);
    assert.strictEqual(detected.source, 'auto-detect');
    assert.deepStrictEqual(
      detected.commands.map((cmd: any) => cmd.command),
      ['npm run typecheck', 'npm run lint', 'npm test']
    );
  });

  test('FBD-P2: plan targets keep their order and mandatory lint is appended last', async () => {
    writePackage({ lint: 'eslint .', test: 'node --test' });
    const detector = new FileBuildDetector();

    const resolved = await detector.resolveCommandPlan(tempDir, undefined, {
      planTargets: ['npm run build', 'npm test'],
      planPath: '/repo/artifacts/plans/41/implementation_plan.md'
    });

    assert.strictEqual(resolved.source, 'plan');
    assert.strictEqual(resolved.lintRequired, true);
    assert.strictEqual(resolved.lintCommand, 'npm run lint');
    assert.deepStrictEqual(resolved.appended, ['npm run lint']);
    assert.deepStrictEqual(
      resolved.commands.map((cmd: any) => cmd.command),
      ['npm run build', 'npm test', 'npm run lint']
    );
    assert.strictEqual(resolved.planPath, '/repo/artifacts/plans/41/implementation_plan.md');
  });

  test('FBD-P3: no plan targets falls back with a visible detail', async () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# docs', 'utf8');
    const detector = new FileBuildDetector();

    const resolved = await detector.resolveCommandPlan(tempDir);

    assert.strictEqual(resolved.source, 'default');
    assert.ok(resolved.sourceDetail.includes('safe default'));
    assert.deepStrictEqual(
      resolved.commands.map((cmd: any) => cmd.command),
      DEFAULT_GATE_COMMANDS.map((cmd: any) => cmd.command)
    );
    assert.deepStrictEqual(resolved.appended, []);
  });
});
