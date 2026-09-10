/**
 * agyloop - FileBuildDetector Adapter
 *
 * Concrete filesystem inspection adapter implementing BuildDetectorPort.
 * Inspects repository marker files, lockfiles, and package manifests to dynamically
 * infer project ecosystems, package managers, and verification command sets.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  Ecosystem,
  GateCommandDefinition,
  BuildDetectionError,
  ECOSYSTEM_NODE,
  ECOSYSTEM_PYTHON,
  ECOSYSTEM_GO,
  ECOSYSTEM_RUST,
  ECOSYSTEM_GRADLE,
  ECOSYSTEM_MAVEN,
  ECOSYSTEM_DOTNET,
  ECOSYSTEM_PRIORITY_ORDER,
  PKG_MGR_PNPM,
  PKG_MGR_YARN,
  PKG_MGR_BUN,
  PKG_MGR_NPM,
  PackageManagerName,
  MARKER_PACKAGE_JSON,
  MARKER_PNPM_LOCK,
  MARKER_YARN_LOCK,
  MARKER_BUN_LOCK,
  MARKER_PACKAGE_LOCK,
  MARKER_PLAYWRIGHT_CONFIG_TS,
  MARKER_PLAYWRIGHT_CONFIG_JS,
  MARKER_PLAYWRIGHT_CONFIG_MJS,
  MARKER_PLAYWRIGHT_CONFIG_CJS,
  PLAYWRIGHT_CONFIG_MARKERS,
  PLAYWRIGHT_SCRIPT_CANDIDATES,
  MARKER_GO_MOD,
  MARKER_CARGO_TOML,
  MARKER_PYPROJECT_TOML,
  MARKER_PYTEST_INI,
  MARKER_SETUP_PY,
  MARKER_REQUIREMENTS_TXT,
  MARKER_GRADLEW,
  MARKER_GRADLEW_BAT,
  MARKER_BUILD_GRADLE,
  MARKER_BUILD_GRADLE_KTS,
  MARKER_SETTINGS_GRADLE,
  MARKER_SETTINGS_GRADLE_KTS,
  MARKER_POM_XML,
  MARKER_EXT_CSPROJ,
  MARKER_EXT_SLN,
  MARKER_EXT_FSPROJ,
  CMD_GO_VET,
  CMD_GO_TEST,
  CMD_CARGO_CHECK,
  CMD_CARGO_TEST,
  CMD_GRADLEW_CHECK,
  CMD_GRADLEW_TEST,
  CMD_GRADLE_CHECK,
  CMD_GRADLE_TEST,
  CMD_MAVEN_TEST,
  CMD_DOTNET_TEST,
  CMD_PYTEST,
  CMD_PYTHON_UNITTEST,
  CMD_PLAYWRIGHT_TEST,
  DEFAULT_GATE_COMMANDS
} from '../domain';

import { BuildDetectorPort, DetectedProject, AgyLoopConfig } from '../ports';

export class FileBuildDetector implements BuildDetectorPort {
  /**
   * Inspects workspace markers and lockfiles to detect ecosystems and verification commands.
   */
  public async detect(workspaceDir: string): Promise<DetectedProject> {
    const resolvedDir = path.resolve(workspaceDir || process.cwd());

    try {
      if (!fs.existsSync(resolvedDir)) {
        throw new BuildDetectionError(
          resolvedDir,
          `Workspace directory does not exist: '${resolvedDir}'`
        );
      }
    } catch (err: unknown) {
      if (err instanceof BuildDetectionError) throw err;
      throw new BuildDetectionError(
        resolvedDir,
        `Failed to access workspace directory '${resolvedDir}'`,
        {},
        err
      );
    }

    try {
      const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
      const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));

      const detectedEcosystems: Ecosystem[] = [];
      const ecosystemCommands: GateCommandDefinition[] = [];

      // 1. Node / TypeScript / JavaScript Detection
      if (fileNames.has(MARKER_PACKAGE_JSON)) {
        const { ecosystem, commands } = this.detectNodeEcosystem(resolvedDir, fileNames);
        detectedEcosystems.push(ecosystem);
        ecosystemCommands.push(...commands);
      }

      // 2. Go Detection
      if (fileNames.has(MARKER_GO_MOD)) {
        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_GO,
            markerFiles: [MARKER_GO_MOD],
            confidence: 1.0,
            priority: 2
          })
        );
        ecosystemCommands.push(
          { id: 'go-vet', label: 'Go Vet Analysis', command: CMD_GO_VET },
          { id: 'go-test', label: 'Go Automated Test Suite', command: CMD_GO_TEST }
        );
      }

      // 3. Rust Detection
      if (fileNames.has(MARKER_CARGO_TOML)) {
        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_RUST,
            markerFiles: [MARKER_CARGO_TOML],
            confidence: 1.0,
            priority: 3
          })
        );
        ecosystemCommands.push(
          { id: 'cargo-check', label: 'Cargo Compilation Check', command: CMD_CARGO_CHECK },
          { id: 'cargo-test', label: 'Cargo Automated Test Suite', command: CMD_CARGO_TEST }
        );
      }

      // 4. Python Detection
      const pythonMarkers: string[] = [];
      if (fileNames.has(MARKER_PYPROJECT_TOML)) pythonMarkers.push(MARKER_PYPROJECT_TOML);
      if (fileNames.has(MARKER_PYTEST_INI)) pythonMarkers.push(MARKER_PYTEST_INI);
      if (fileNames.has(MARKER_SETUP_PY)) pythonMarkers.push(MARKER_SETUP_PY);
      if (fileNames.has(MARKER_REQUIREMENTS_TXT)) pythonMarkers.push(MARKER_REQUIREMENTS_TXT);

      if (pythonMarkers.length > 0) {
        const { ecosystem, commands } = this.detectPythonEcosystem(resolvedDir, pythonMarkers);
        detectedEcosystems.push(ecosystem);
        ecosystemCommands.push(...commands);
      }

      // 5. Gradle Detection (Java / Kotlin)
      const gradleMarkers: string[] = [];
      if (fileNames.has(MARKER_BUILD_GRADLE)) gradleMarkers.push(MARKER_BUILD_GRADLE);
      if (fileNames.has(MARKER_BUILD_GRADLE_KTS)) gradleMarkers.push(MARKER_BUILD_GRADLE_KTS);
      if (fileNames.has(MARKER_SETTINGS_GRADLE)) gradleMarkers.push(MARKER_SETTINGS_GRADLE);
      if (fileNames.has(MARKER_SETTINGS_GRADLE_KTS)) gradleMarkers.push(MARKER_SETTINGS_GRADLE_KTS);

      if (gradleMarkers.length > 0) {
        const hasWrapper = fileNames.has(MARKER_GRADLEW) || fileNames.has(MARKER_GRADLEW_BAT);
        if (hasWrapper) {
          gradleMarkers.push(MARKER_GRADLEW);
        }

        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_GRADLE,
            markerFiles: gradleMarkers,
            confidence: 1.0,
            priority: 5
          })
        );

        if (hasWrapper) {
          ecosystemCommands.push(
            { id: 'gradle-check', label: 'Gradle Check', command: CMD_GRADLEW_CHECK },
            { id: 'gradle-test', label: 'Gradle Test Suite', command: CMD_GRADLEW_TEST }
          );
        } else {
          ecosystemCommands.push(
            { id: 'gradle-check', label: 'Gradle Check', command: CMD_GRADLE_CHECK },
            { id: 'gradle-test', label: 'Gradle Test Suite', command: CMD_GRADLE_TEST }
          );
        }
      }

      // 6. Maven Detection (Java)
      if (fileNames.has(MARKER_POM_XML)) {
        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_MAVEN,
            markerFiles: [MARKER_POM_XML],
            confidence: 1.0,
            priority: 6
          })
        );
        ecosystemCommands.push({
          id: 'maven-test',
          label: 'Maven Test Suite',
          command: CMD_MAVEN_TEST
        });
      }

      // 7. .NET Detection (C# / F# / VB)
      const dotnetFiles = Array.from(fileNames).filter(
        (f) =>
          f.endsWith(MARKER_EXT_CSPROJ) ||
          f.endsWith(MARKER_EXT_SLN) ||
          f.endsWith(MARKER_EXT_FSPROJ)
      );

      if (dotnetFiles.length > 0) {
        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_DOTNET,
            markerFiles: dotnetFiles,
            confidence: 1.0,
            priority: 7
          })
        );
        ecosystemCommands.push({
          id: 'dotnet-test',
          label: '.NET Automated Test Suite',
          command: CMD_DOTNET_TEST
        });
      }

      // Sort detected ecosystems deterministically according to ECOSYSTEM_PRIORITY_ORDER
      detectedEcosystems.sort((a, b) => {
        const orderA = ECOSYSTEM_PRIORITY_ORDER.indexOf(a.type);
        const orderB = ECOSYSTEM_PRIORITY_ORDER.indexOf(b.type);
        const posA = orderA === -1 ? 999 : orderA;
        const posB = orderB === -1 ? 999 : orderB;
        return posA - posB;
      });

      const primaryEcosystem =
        detectedEcosystems.length > 0 ? detectedEcosystems[0] : Ecosystem.unknown();

      const commands =
        ecosystemCommands.length > 0 ? ecosystemCommands : DEFAULT_GATE_COMMANDS;

      return {
        workspaceDir: resolvedDir,
        ecosystems: detectedEcosystems,
        primaryEcosystem,
        commands,
        hasOverrides: false
      };
    } catch (err: unknown) {
      if (err instanceof BuildDetectionError) throw err;
      throw new BuildDetectionError(
        resolvedDir,
        `Unexpected error during ecosystem detection: ${err instanceof Error ? err.message : String(err)}`,
        {},
        err
      );
    }
  }

  /**
   * Resolves the concrete verification commands following strict precedence:
   * 1. explicitCommands parameter
   * 2. config overrides (gateCommands / quality_gates.commands)
   * 3. auto-detected ecosystem commands
   * 4. default gate commands fallback
   */
  public async resolveCommands(
    workspaceDir: string,
    config?: AgyLoopConfig,
    explicitCommands?: readonly string[] | readonly GateCommandDefinition[]
  ): Promise<readonly GateCommandDefinition[]> {
    // 1. Explicit CLI / parameter commands (Highest precedence)
    if (explicitCommands && explicitCommands.length > 0) {
      return this.normalizeCommands(explicitCommands, 'custom');
    }

    // 2. Explicit configuration overrides (.agyloop.json / config.default.json)
    const configuredCommands = this.extractConfiguredCommands(config);
    if (configuredCommands && configuredCommands.length > 0) {
      return this.normalizeCommands(configuredCommands, 'config');
    }

    // 3. Auto-detected commands from workspace filesystem markers
    const detected = await this.detect(workspaceDir);
    if (detected.commands && detected.commands.length > 0) {
      return detected.commands;
    }

    // 4. Safe fallback
    return DEFAULT_GATE_COMMANDS;
  }

  private detectNodeEcosystem(
    workspaceDir: string,
    fileNames: Set<string>
  ): { ecosystem: Ecosystem; commands: GateCommandDefinition[] } {
    let pkgMgr: PackageManagerName = PKG_MGR_NPM;
    const markers: string[] = [MARKER_PACKAGE_JSON];

    if (fileNames.has(MARKER_PNPM_LOCK)) {
      pkgMgr = PKG_MGR_PNPM;
      markers.push(MARKER_PNPM_LOCK);
    } else if (fileNames.has(MARKER_YARN_LOCK)) {
      pkgMgr = PKG_MGR_YARN;
      markers.push(MARKER_YARN_LOCK);
    } else if (fileNames.has(MARKER_BUN_LOCK)) {
      pkgMgr = PKG_MGR_BUN;
      markers.push(MARKER_BUN_LOCK);
    } else if (fileNames.has(MARKER_PACKAGE_LOCK)) {
      markers.push(MARKER_PACKAGE_LOCK);
    }

    // Read package.json scripts
    let scripts: Record<string, string> = {};
    const pkgJsonPath = path.join(workspaceDir, MARKER_PACKAGE_JSON);
    try {
      const content = fs.readFileSync(pkgJsonPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null) {
        scripts = parsed.scripts;
      }
    } catch {
      // If parsing fails, proceed with default fallbacks
    }

    const commands: GateCommandDefinition[] = [];

    // Check typecheck script
    if (scripts.typecheck) {
      commands.push({
        id: 'typecheck',
        label: `TypeScript Compilation & Typecheck (${pkgMgr})`,
        command: `${pkgMgr} run typecheck`
      });
    }

    // Check build script (if no typecheck script or build present)
    if (scripts.build && !scripts.typecheck) {
      commands.push({
        id: 'build',
        label: `Build Script (${pkgMgr})`,
        command: `${pkgMgr} run build`
      });
    }

    // Check test script
    if (scripts.test) {
      // Check if it's the default npm init stub
      const isDefaultStub = scripts.test.includes('no test specified');
      if (!isDefaultStub) {
        commands.push({
          id: 'test',
          label: `Automated Test Suite (${pkgMgr})`,
          command: `${pkgMgr} test`
        });
      }
    }

    // Playwright Detection
    const hasPlaywrightConfig = (PLAYWRIGHT_CONFIG_MARKERS as readonly string[]).some((m) =>
      fileNames.has(m)
    );
    if (hasPlaywrightConfig) {
      const matched = (PLAYWRIGHT_CONFIG_MARKERS as readonly string[]).find((m) => fileNames.has(m));
      if (matched) markers.push(matched);
    }

    let playwrightScript: string | null = null;
    for (const cand of PLAYWRIGHT_SCRIPT_CANDIDATES) {
      if (scripts[cand]) {
        playwrightScript = cand;
        break;
      }
    }

    if (playwrightScript) {
      commands.push({
        id: 'playwright',
        label: `Playwright End-to-End Test Suite (${pkgMgr})`,
        command: `${pkgMgr} run ${playwrightScript}`
      });
    } else if (hasPlaywrightConfig) {
      const runnerCmd =
        pkgMgr === PKG_MGR_PNPM
          ? 'pnpm exec playwright test'
          : pkgMgr === PKG_MGR_BUN
            ? 'bunx playwright test'
            : pkgMgr === PKG_MGR_YARN
              ? 'yarn playwright test'
              : CMD_PLAYWRIGHT_TEST;

      commands.push({
        id: 'playwright',
        label: 'Playwright End-to-End Test Suite',
        command: runnerCmd
      });
    }

    // If no commands were inferred from scripts, provide safe default test
    if (commands.length === 0) {
      commands.push({
        id: 'test',
        label: `Automated Test Suite (${pkgMgr})`,
        command: `${pkgMgr} test`
      });
    }

    const ecosystem = new Ecosystem({
      type: ECOSYSTEM_NODE,
      markerFiles: markers,
      packageManager: pkgMgr,
      confidence: 1.0,
      priority: 1
    });

    return { ecosystem, commands };
  }

  private detectPythonEcosystem(
    workspaceDir: string,
    markers: string[]
  ): { ecosystem: Ecosystem; commands: GateCommandDefinition[] } {
    let usesPytest = markers.includes(MARKER_PYTEST_INI);

    if (!usesPytest && markers.includes(MARKER_PYPROJECT_TOML)) {
      try {
        const content = fs.readFileSync(path.join(workspaceDir, MARKER_PYPROJECT_TOML), 'utf8');
        if (content.includes('pytest') || content.includes('[tool.pytest')) {
          usesPytest = true;
        }
      } catch {
        // Ignore read failure
      }
    }

    if (!usesPytest && markers.includes(MARKER_REQUIREMENTS_TXT)) {
      try {
        const content = fs.readFileSync(path.join(workspaceDir, MARKER_REQUIREMENTS_TXT), 'utf8');
        if (content.toLowerCase().includes('pytest')) {
          usesPytest = true;
        }
      } catch {
        // Ignore read failure
      }
    }

    if (!usesPytest && markers.includes(MARKER_SETUP_PY)) {
      try {
        const content = fs.readFileSync(path.join(workspaceDir, MARKER_SETUP_PY), 'utf8');
        if (content.toLowerCase().includes('pytest')) {
          usesPytest = true;
        }
      } catch {
        // Ignore read failure
      }
    }

    const commands: GateCommandDefinition[] = usesPytest
      ? [{ id: 'pytest', label: 'Pytest Automated Test Suite', command: CMD_PYTEST }]
      : [{ id: 'python-unittest', label: 'Python Unittest Suite', command: CMD_PYTHON_UNITTEST }];

    const ecosystem = new Ecosystem({
      type: ECOSYSTEM_PYTHON,
      markerFiles: markers,
      confidence: 1.0,
      priority: 4
    });

    return { ecosystem, commands };
  }

  private extractConfiguredCommands(config?: AgyLoopConfig): readonly unknown[] | null {
    if (!config) return null;

    if (config.options && Array.isArray(config.options.gateCommands) && config.options.gateCommands.length > 0) {
      return config.options.gateCommands;
    }

    const anyConfig = config as unknown as Record<string, unknown>;
    if (anyConfig.quality_gates && typeof anyConfig.quality_gates === 'object') {
      const qg = anyConfig.quality_gates as { commands?: readonly unknown[] };
      if (Array.isArray(qg.commands) && qg.commands.length > 0) {
        return qg.commands;
      }
    }

    if (anyConfig.qualityGates && typeof anyConfig.qualityGates === 'object') {
      const qg = anyConfig.qualityGates as { commands?: readonly unknown[] };
      if (Array.isArray(qg.commands) && qg.commands.length > 0) {
        return qg.commands;
      }
    }

    return null;
  }

  private normalizeCommands(
    commands: readonly unknown[],
    prefix: string
  ): readonly GateCommandDefinition[] {
    return commands.map((cmd, idx) => {
      if (typeof cmd === 'string') {
        return {
          id: `${prefix}-cmd-${idx + 1}`,
          label: `Configured Command ${idx + 1}`,
          command: cmd
        };
      }
      if (cmd && typeof cmd === 'object') {
        const c = cmd as { id?: string; label?: string; command?: string };
        return {
          id: c.id || `${prefix}-cmd-${idx + 1}`,
          label: c.label || `Command ${idx + 1}`,
          command: String(c.command || '')
        };
      }
      return {
        id: `${prefix}-cmd-${idx + 1}`,
        label: `Command ${idx + 1}`,
        command: String(cmd)
      };
    });
  }
}
