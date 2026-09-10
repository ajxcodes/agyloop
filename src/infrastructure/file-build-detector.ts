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
  GRADLE_MARKERS,
  MARKER_POM_XML,
  MARKER_EXT_CSPROJ,
  MARKER_EXT_SLN,
  MARKER_EXT_FSPROJ,
  DOTNET_EXTENSIONS,
  PYTHON_MARKERS,
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
  CMD_PLAYWRIGHT_PNPM,
  CMD_PLAYWRIGHT_BUN,
  CMD_PLAYWRIGHT_YARN,
  DEFAULT_GATE_COMMANDS,
  PRIORITY_ECOSYSTEM_NODE,
  PRIORITY_ECOSYSTEM_GO,
  PRIORITY_ECOSYSTEM_RUST,
  PRIORITY_ECOSYSTEM_PYTHON,
  PRIORITY_ECOSYSTEM_GRADLE,
  PRIORITY_ECOSYSTEM_MAVEN,
  PRIORITY_ECOSYSTEM_DOTNET,
  FALLBACK_ECOSYSTEM_PRIORITY,
  CONFIDENCE_CERTAIN,
  CMD_ID_TYPECHECK,
  CMD_ID_BUILD,
  CMD_ID_TEST,
  CMD_ID_PLAYWRIGHT,
  CMD_ID_GO_VET,
  CMD_ID_GO_TEST,
  CMD_ID_CARGO_CHECK,
  CMD_ID_CARGO_TEST,
  CMD_ID_PYTEST,
  CMD_ID_PYTHON_UNITTEST,
  CMD_ID_GRADLE_CHECK,
  CMD_ID_GRADLE_TEST,
  CMD_ID_MAVEN_TEST,
  CMD_ID_DOTNET_TEST,
  CMD_LABEL_TYPECHECK,
  CMD_LABEL_BUILD,
  CMD_LABEL_TEST,
  CMD_LABEL_PLAYWRIGHT,
  CMD_LABEL_GO_VET,
  CMD_LABEL_GO_TEST,
  CMD_LABEL_CARGO_CHECK,
  CMD_LABEL_CARGO_TEST,
  CMD_LABEL_PYTEST,
  CMD_LABEL_PYTHON_UNITTEST,
  CMD_LABEL_GRADLE_CHECK,
  CMD_LABEL_GRADLE_TEST,
  CMD_LABEL_MAVEN_TEST,
  CMD_LABEL_DOTNET_TEST,
  CMD_PREFIX_CUSTOM,
  CMD_PREFIX_CONFIG,
  SCRIPT_NAME_TYPECHECK,
  SCRIPT_NAME_BUILD,
  SCRIPT_NAME_TEST,
  NPM_DEFAULT_TEST_STUB,
  PYTEST_INDICATOR_KEYWORD,
  PYTEST_CONFIG_HEADER
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
            confidence: CONFIDENCE_CERTAIN,
            priority: PRIORITY_ECOSYSTEM_GO
          })
        );
        ecosystemCommands.push(
          { id: CMD_ID_GO_VET, label: CMD_LABEL_GO_VET, command: CMD_GO_VET },
          { id: CMD_ID_GO_TEST, label: CMD_LABEL_GO_TEST, command: CMD_GO_TEST }
        );
      }

      // 3. Rust Detection
      if (fileNames.has(MARKER_CARGO_TOML)) {
        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_RUST,
            markerFiles: [MARKER_CARGO_TOML],
            confidence: CONFIDENCE_CERTAIN,
            priority: PRIORITY_ECOSYSTEM_RUST
          })
        );
        ecosystemCommands.push(
          { id: CMD_ID_CARGO_CHECK, label: CMD_LABEL_CARGO_CHECK, command: CMD_CARGO_CHECK },
          { id: CMD_ID_CARGO_TEST, label: CMD_LABEL_CARGO_TEST, command: CMD_CARGO_TEST }
        );
      }

      // 4. Python Detection
      const pythonMarkers: string[] = PYTHON_MARKERS.filter((m) => fileNames.has(m));
      if (pythonMarkers.length > 0) {
        const { ecosystem, commands } = this.detectPythonEcosystem(resolvedDir, pythonMarkers);
        detectedEcosystems.push(ecosystem);
        ecosystemCommands.push(...commands);
      }

      // 5. Gradle Detection (Java / Kotlin)
      const gradleMarkers: string[] = GRADLE_MARKERS.filter((m) => fileNames.has(m));
      if (gradleMarkers.length > 0) {
        const hasWrapper = fileNames.has(MARKER_GRADLEW) || fileNames.has(MARKER_GRADLEW_BAT);
        if (hasWrapper) {
          gradleMarkers.push(MARKER_GRADLEW);
        }

        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_GRADLE,
            markerFiles: gradleMarkers,
            confidence: CONFIDENCE_CERTAIN,
            priority: PRIORITY_ECOSYSTEM_GRADLE
          })
        );

        const checkCmd = hasWrapper ? CMD_GRADLEW_CHECK : CMD_GRADLE_CHECK;
        const testCmd = hasWrapper ? CMD_GRADLEW_TEST : CMD_GRADLE_TEST;
        ecosystemCommands.push(
          { id: CMD_ID_GRADLE_CHECK, label: CMD_LABEL_GRADLE_CHECK, command: checkCmd },
          { id: CMD_ID_GRADLE_TEST, label: CMD_LABEL_GRADLE_TEST, command: testCmd }
        );
      }

      // 6. Maven Detection (Java)
      if (fileNames.has(MARKER_POM_XML)) {
        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_MAVEN,
            markerFiles: [MARKER_POM_XML],
            confidence: CONFIDENCE_CERTAIN,
            priority: PRIORITY_ECOSYSTEM_MAVEN
          })
        );
        ecosystemCommands.push({
          id: CMD_ID_MAVEN_TEST,
          label: CMD_LABEL_MAVEN_TEST,
          command: CMD_MAVEN_TEST
        });
      }

      // 7. .NET Detection (C# / F# / VB)
      const dotnetFiles = Array.from(fileNames).filter((f) =>
        DOTNET_EXTENSIONS.some((ext) => f.endsWith(ext))
      );

      if (dotnetFiles.length > 0) {
        detectedEcosystems.push(
          new Ecosystem({
            type: ECOSYSTEM_DOTNET,
            markerFiles: dotnetFiles,
            confidence: CONFIDENCE_CERTAIN,
            priority: PRIORITY_ECOSYSTEM_DOTNET
          })
        );
        ecosystemCommands.push({
          id: CMD_ID_DOTNET_TEST,
          label: CMD_LABEL_DOTNET_TEST,
          command: CMD_DOTNET_TEST
        });
      }

      // Sort detected ecosystems deterministically according to ECOSYSTEM_PRIORITY_ORDER
      detectedEcosystems.sort((a, b) => {
        const orderA = ECOSYSTEM_PRIORITY_ORDER.indexOf(a.type);
        const orderB = ECOSYSTEM_PRIORITY_ORDER.indexOf(b.type);
        const posA = orderA === -1 ? FALLBACK_ECOSYSTEM_PRIORITY : orderA;
        const posB = orderB === -1 ? FALLBACK_ECOSYSTEM_PRIORITY : orderB;
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
      return this.normalizeCommands(explicitCommands, CMD_PREFIX_CUSTOM);
    }

    // 2. Explicit configuration overrides (.agyloop.json / config.default.json)
    const configuredCommands = this.extractConfiguredCommands(config);
    if (configuredCommands && configuredCommands.length > 0) {
      return this.normalizeCommands(configuredCommands, CMD_PREFIX_CONFIG);
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
    const { pkgMgr, lockfileMarker } = this.detectNodePackageManager(fileNames);
    const markers: string[] = [MARKER_PACKAGE_JSON];
    if (lockfileMarker) {
      markers.push(lockfileMarker);
    }

    const scripts = this.readPackageScripts(workspaceDir);
    const commands: GateCommandDefinition[] = [];

    // Check typecheck script
    if (scripts[SCRIPT_NAME_TYPECHECK]) {
      commands.push({
        id: CMD_ID_TYPECHECK,
        label: `${CMD_LABEL_TYPECHECK} (${pkgMgr})`,
        command: `${pkgMgr} run ${SCRIPT_NAME_TYPECHECK}`
      });
    }

    // Check build script (if no typecheck script or build present)
    if (scripts[SCRIPT_NAME_BUILD] && !scripts[SCRIPT_NAME_TYPECHECK]) {
      commands.push({
        id: CMD_ID_BUILD,
        label: `${CMD_LABEL_BUILD} (${pkgMgr})`,
        command: `${pkgMgr} run ${SCRIPT_NAME_BUILD}`
      });
    }

    // Check test script
    if (scripts[SCRIPT_NAME_TEST]) {
      const isDefaultStub = scripts[SCRIPT_NAME_TEST].includes(NPM_DEFAULT_TEST_STUB);
      if (!isDefaultStub) {
        commands.push({
          id: CMD_ID_TEST,
          label: `${CMD_LABEL_TEST} (${pkgMgr})`,
          command: `${pkgMgr} test`
        });
      }
    }

    // Playwright Detection
    const matchedPlaywrightMarker = PLAYWRIGHT_CONFIG_MARKERS.find((m) => fileNames.has(m));
    if (matchedPlaywrightMarker) {
      markers.push(matchedPlaywrightMarker);
    }

    const playwrightScript = PLAYWRIGHT_SCRIPT_CANDIDATES.find((cand) => Boolean(scripts[cand]));
    if (playwrightScript) {
      commands.push({
        id: CMD_ID_PLAYWRIGHT,
        label: `${CMD_LABEL_PLAYWRIGHT} (${pkgMgr})`,
        command: `${pkgMgr} run ${playwrightScript}`
      });
    } else if (matchedPlaywrightMarker) {
      commands.push({
        id: CMD_ID_PLAYWRIGHT,
        label: CMD_LABEL_PLAYWRIGHT,
        command: this.resolvePlaywrightRunner(pkgMgr)
      });
    }

    // If no commands were inferred from scripts, provide safe default test
    if (commands.length === 0) {
      commands.push({
        id: CMD_ID_TEST,
        label: `${CMD_LABEL_TEST} (${pkgMgr})`,
        command: `${pkgMgr} test`
      });
    }

    const ecosystem = new Ecosystem({
      type: ECOSYSTEM_NODE,
      markerFiles: markers,
      packageManager: pkgMgr,
      confidence: CONFIDENCE_CERTAIN,
      priority: PRIORITY_ECOSYSTEM_NODE
    });

    return { ecosystem, commands };
  }

  private detectNodePackageManager(fileNames: Set<string>): {
    pkgMgr: PackageManagerName;
    lockfileMarker?: string;
  } {
    if (fileNames.has(MARKER_PNPM_LOCK)) {
      return { pkgMgr: PKG_MGR_PNPM, lockfileMarker: MARKER_PNPM_LOCK };
    }
    if (fileNames.has(MARKER_YARN_LOCK)) {
      return { pkgMgr: PKG_MGR_YARN, lockfileMarker: MARKER_YARN_LOCK };
    }
    if (fileNames.has(MARKER_BUN_LOCK)) {
      return { pkgMgr: PKG_MGR_BUN, lockfileMarker: MARKER_BUN_LOCK };
    }
    if (fileNames.has(MARKER_PACKAGE_LOCK)) {
      return { pkgMgr: PKG_MGR_NPM, lockfileMarker: MARKER_PACKAGE_LOCK };
    }
    return { pkgMgr: PKG_MGR_NPM };
  }

  private resolvePlaywrightRunner(pkgMgr: PackageManagerName): string {
    switch (pkgMgr) {
      case PKG_MGR_PNPM:
        return CMD_PLAYWRIGHT_PNPM;
      case PKG_MGR_BUN:
        return CMD_PLAYWRIGHT_BUN;
      case PKG_MGR_YARN:
        return CMD_PLAYWRIGHT_YARN;
      case PKG_MGR_NPM:
      default:
        return CMD_PLAYWRIGHT_TEST;
    }
  }

  private readPackageScripts(workspaceDir: string): Record<string, string> {
    const pkgJsonPath = path.join(workspaceDir, MARKER_PACKAGE_JSON);
    try {
      const content = fs.readFileSync(pkgJsonPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null) {
        return parsed.scripts;
      }
    } catch {
      // If parsing fails, return empty scripts
    }
    return {};
  }

  private detectPythonEcosystem(
    workspaceDir: string,
    markers: string[]
  ): { ecosystem: Ecosystem; commands: GateCommandDefinition[] } {
    const usesPytest = this.hasPytestConfigured(workspaceDir, markers);

    const commands: GateCommandDefinition[] = usesPytest
      ? [{ id: CMD_ID_PYTEST, label: CMD_LABEL_PYTEST, command: CMD_PYTEST }]
      : [{ id: CMD_ID_PYTHON_UNITTEST, label: CMD_LABEL_PYTHON_UNITTEST, command: CMD_PYTHON_UNITTEST }];

    const ecosystem = new Ecosystem({
      type: ECOSYSTEM_PYTHON,
      markerFiles: markers,
      confidence: CONFIDENCE_CERTAIN,
      priority: PRIORITY_ECOSYSTEM_PYTHON
    });

    return { ecosystem, commands };
  }

  private hasPytestConfigured(workspaceDir: string, markers: string[]): boolean {
    if (markers.includes(MARKER_PYTEST_INI)) {
      return true;
    }

    const candidateFiles = [
      MARKER_PYPROJECT_TOML,
      MARKER_REQUIREMENTS_TXT,
      MARKER_SETUP_PY
    ];

    return candidateFiles.some(
      (file) =>
        markers.includes(file) &&
        (this.fileContainsCaseInsensitive(path.join(workspaceDir, file), PYTEST_INDICATOR_KEYWORD) ||
          this.fileContainsCaseInsensitive(path.join(workspaceDir, file), PYTEST_CONFIG_HEADER))
    );
  }

  private fileContainsCaseInsensitive(filePath: string, needle: string): boolean {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.toLowerCase().includes(needle.toLowerCase());
    } catch {
      return false;
    }
  }

  private extractConfiguredCommands(config?: AgyLoopConfig): readonly unknown[] | null {
    if (!config) return null;

    const gateCommands = config.options?.gateCommands;
    if (Array.isArray(gateCommands) && gateCommands.length > 0) {
      return gateCommands;
    }

    const anyConfig = config as Record<string, any>;
    const qualityGatesSection = anyConfig.quality_gates || anyConfig.qualityGates;
    if (
      qualityGatesSection &&
      Array.isArray(qualityGatesSection.commands) &&
      qualityGatesSection.commands.length > 0
    ) {
      return qualityGatesSection.commands;
    }

    return null;
  }

  private normalizeCommands(
    commands: readonly unknown[],
    prefix: string
  ): readonly GateCommandDefinition[] {
    return commands.map((cmd, idx) => {
      const defaultId = `${prefix}-cmd-${idx + 1}`;
      const defaultLabel = prefix === CMD_PREFIX_CUSTOM
        ? `Custom Command ${idx + 1}`
        : `Configured Command ${idx + 1}`;

      if (typeof cmd === 'string') {
        return {
          id: defaultId,
          label: defaultLabel,
          command: cmd
        };
      }
      if (cmd && typeof cmd === 'object') {
        const c = cmd as { id?: string; label?: string; command?: string };
        return {
          id: c.id || defaultId,
          label: c.label || defaultLabel,
          command: String(c.command || '')
        };
      }
      return {
        id: defaultId,
        label: defaultLabel,
        command: String(cmd)
      };
    });
  }
}
