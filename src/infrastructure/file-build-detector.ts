/**
 * agyloop - FileBuildDetector Adapter
 *
 * Concrete filesystem inspection adapter implementing BuildDetectorPort.
 * Inspects repository marker files, lockfiles, and package manifests to dynamically
 * infer project ecosystems, package managers, and verification command sets.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_PLAYWRIGHT_CONFIG_TS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_PLAYWRIGHT_CONFIG_JS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_PLAYWRIGHT_CONFIG_MJS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_BUILD_GRADLE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_BUILD_GRADLE_KTS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_SETTINGS_GRADLE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_SETTINGS_GRADLE_KTS,
  GRADLE_MARKERS,
  MARKER_POM_XML,
  MARKER_GITHUB_WORKFLOWS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_EXT_CSPROJ,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MARKER_EXT_SLN,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  CMD_ID_LINT,
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
  CMD_ID_ACT,
  CMD_LABEL_TYPECHECK,
  CMD_LABEL_BUILD,
  CMD_LABEL_LINT,
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
  CMD_LABEL_ACT,
  CONTAINER_PROBE_TIMEOUT_MS,
  CMD_PREFIX_CUSTOM,
  CMD_PREFIX_CONFIG,
  CMD_LABEL_CUSTOM,
  CMD_LABEL_CONFIG,
  CMD_ID_PLAN_TARGET_PREFIX,
  CMD_LABEL_PLAN_TARGET,
  GATE_COMMAND_SOURCE_EXPLICIT,
  GATE_COMMAND_SOURCE_PLAN,
  GATE_COMMAND_SOURCE_CONFIG,
  GATE_COMMAND_SOURCE_ACT,
  GATE_COMMAND_SOURCE_AUTO_DETECT,
  GATE_COMMAND_SOURCE_DEFAULT,
  GateCommandPlan,
  GateCommandSource,
  isLintCommand,
  SCRIPT_NAME_TYPECHECK,
  SCRIPT_NAME_BUILD,
  SCRIPT_NAME_LINT,
  SCRIPT_NAME_TEST,
  NPM_DEFAULT_TEST_STUB,
  PYTEST_INDICATOR_KEYWORD,
  PYTEST_CONFIG_HEADER
} from '../domain';

import {
  BuildDetectorPort,
  DetectedProject,
  AgyLoopConfig,
  GateCommandResolutionOptions,
  ContainerRuntimeProbe
} from '../ports';

export class FileBuildDetector implements BuildDetectorPort {
  /**
   * Inspects workspace markers and lockfiles to detect ecosystems and verification commands.
   */
  public async detect(workspaceDir: string, config?: AgyLoopConfig): Promise<DetectedProject> {
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

      // Act Container Gate Resolution
      const actCommand = this.resolveActCommand(resolvedDir, config);
      if (actCommand) {
        ecosystemCommands.push(actCommand);
      }

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
   * 2. approved plan targets
   * 3. config overrides (gateCommands / quality_gates.commands)
   * 4. act container gate
   * 5. auto-detected ecosystem commands
   * 6. default gate commands fallback
   *
   * Thin compatibility wrapper over `resolveCommandPlan` (issue #298): there is
   * exactly ONE precedence implementation.
   */
  public async resolveCommands(
    workspaceDir: string,
    config?: AgyLoopConfig,
    explicitCommands?: readonly string[] | readonly GateCommandDefinition[]
  ): Promise<readonly GateCommandDefinition[]> {
    const plan = await this.resolveCommandPlan(workspaceDir, config, { explicitCommands });
    return plan.commands;
  }

  /**
   * Resolves the verification command list WITH provenance (issue #298).
   *
   * Detected Node lint is non-optional: when the workspace declares a `lint`
   * script and the chosen list omits it, the detected command is appended at
   * the end and recorded in `appended`. Plan order is otherwise untouched.
   */
  public async resolveCommandPlan(
    workspaceDir: string,
    config?: AgyLoopConfig,
    options: GateCommandResolutionOptions = {}
  ): Promise<GateCommandPlan> {
    const detected = await this.detectBestEffort(workspaceDir, config);
    const detectedLint = detected?.commands.find((cmd) => cmd.id === CMD_ID_LINT) ?? null;
    const planPath = options.planPath ?? null;

    const finalize = (
      commands: readonly GateCommandDefinition[],
      source: GateCommandSource,
      sourceDetail: string
    ): GateCommandPlan => this.buildCommandPlan(commands, source, sourceDetail, planPath, detectedLint);

    // 1. Explicit CLI / parameter commands (Highest precedence)
    if (options.explicitCommands && options.explicitCommands.length > 0) {
      return finalize(
        this.normalizeCommands(options.explicitCommands, CMD_PREFIX_CUSTOM),
        GATE_COMMAND_SOURCE_EXPLICIT,
        'explicit commands (CLI --commands / caller parameter)'
      );
    }

    // 2. Approved plan Quality Gate Targets
    if (options.planTargets && options.planTargets.length > 0) {
      const planCommands = options.planTargets.map((command, idx) => ({
        id: `${CMD_ID_PLAN_TARGET_PREFIX}${idx + 1}`,
        label: `${CMD_LABEL_PLAN_TARGET} ${idx + 1}`,
        command
      }));
      return finalize(
        planCommands,
        GATE_COMMAND_SOURCE_PLAN,
        planPath
          ? `approved plan Quality Gate Targets from ${planPath}`
          : 'approved plan Quality Gate Targets'
      );
    }

    // 3. Explicit configuration overrides (.agyloop.json / config.default.json)
    const configuredCommands = this.extractConfiguredCommands(config);
    if (configuredCommands && configuredCommands.length > 0) {
      return finalize(
        this.normalizeCommands(configuredCommands, CMD_PREFIX_CONFIG),
        GATE_COMMAND_SOURCE_CONFIG,
        'configuration gateCommands / quality_gates.commands override'
      );
    }

    // 4. Act Container Gate Resolution (if enabled/configured or auto-detected with containerGates: true)
    const actCommand = this.resolveActCommand(workspaceDir, config);
    if (actCommand) {
      return finalize([actCommand], GATE_COMMAND_SOURCE_ACT, 'act container gate');
    }

    // 5. Auto-detected commands from workspace filesystem markers
    if (detected && detected.ecosystems.length > 0) {
      return finalize(
        detected.commands,
        GATE_COMMAND_SOURCE_AUTO_DETECT,
        `auto-detected from workspace markers (${detected.primaryEcosystem.toString()})`
      );
    }

    // 6. Safe fallback
    return finalize(
      DEFAULT_GATE_COMMANDS,
      GATE_COMMAND_SOURCE_DEFAULT,
      'safe default; no ecosystem markers matched'
    );
  }

  /**
   * Detection for provenance/lint only. Best-effort: a probe failure must not
   * turn an explicit or plan-sourced command list into an exception.
   */
  private async detectBestEffort(
    workspaceDir: string,
    config?: AgyLoopConfig
  ): Promise<DetectedProject | null> {
    try {
      return await this.detect(workspaceDir, config);
    } catch {
      return null;
    }
  }

  private buildCommandPlan(
    commands: readonly GateCommandDefinition[],
    source: GateCommandSource,
    sourceDetail: string,
    planPath: string | null,
    detectedLint: GateCommandDefinition | null
  ): GateCommandPlan {
    const finalCommands: GateCommandDefinition[] = [...commands];
    const appended: string[] = [];
    let lintRequired = false;
    let lintCommand: string | null = null;

    if (detectedLint !== null) {
      lintRequired = true;
      const existingLint = finalCommands.find((cmd) => isLintCommand(cmd));
      if (existingLint) {
        lintCommand = existingLint.command;
      } else {
        finalCommands.push(detectedLint);
        appended.push(detectedLint.command);
        lintCommand = detectedLint.command;
      }
    }

    return {
      commands: finalCommands,
      source,
      sourceDetail,
      appended,
      lintRequired,
      lintCommand,
      planPath
    };
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

    // Check lint script (issue #298: a Node gate can never pass without lint)
    if (scripts[SCRIPT_NAME_LINT]) {
      commands.push({
        id: CMD_ID_LINT,
        label: `${CMD_LABEL_LINT} (${pkgMgr})`,
        command: `${pkgMgr} run ${SCRIPT_NAME_LINT}`
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        ? `${CMD_LABEL_CUSTOM} ${idx + 1}`
        : `${CMD_LABEL_CONFIG} ${idx + 1}`;

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

  /**
   * Resolves the container runtime CLI ('podman' | 'docker' | null).
   */
  public static resolveContainerRuntime(): 'podman' | 'docker' | null {
    if (FileBuildDetector.isBinaryAvailable('podman')) {
      return 'podman';
    }
    if (FileBuildDetector.isBinaryAvailable('docker')) {
      return 'docker';
    }
    return null;
  }

  public resolveContainerRuntime(): 'podman' | 'docker' | null {
    return FileBuildDetector.resolveContainerRuntime();
  }

  /**
   * Resolves the container daemon socket path and type.
   * Priority:
   * 1. Podman socket: unix://$XDG_RUNTIME_DIR/podman/podman.sock or /run/user/<uid>/podman/podman.sock
   * 2. Docker host env: DOCKER_HOST — unix-style endpoints (`unix://…` or a bare absolute
   *    path) are verified against the filesystem (must exist and be a socket) before being
   *    returned; on failure resolution falls through to the /var/run/docker.sock check.
   *    Non-unix schemes (`tcp://`, `ssh://`, `http(s)://`, …) cannot be verified via the
   *    filesystem and pass through unchanged.
   * 3. Docker socket: /var/run/docker.sock
   * Returns null when no verifiable socket is available.
   *
   * PURE as of issue #295: it emits NO warnings. A missing socket is no longer
   * evidence that the runtime is unusable (rootless podman has none), so
   * warning here was noise on every read-only command. `resolveActCommand` owns
   * the one warning, and only where the gate is actually being selected.
   */
  public static resolveContainerSocket(): { socketPath: string; runtime: 'podman' | 'docker' } | null {
    // Check Podman socket
    const xdgRuntime = process.env.XDG_RUNTIME_DIR;
    if (xdgRuntime) {
      const podmanSock = path.join(xdgRuntime, 'podman', 'podman.sock');
      if (fs.existsSync(podmanSock)) {
        return { socketPath: `unix://${podmanSock}`, runtime: 'podman' };
      }
    }

    // Check Docker Host env (guard unix sockets; pass through remote endpoints)
    const dockerHost = process.env.DOCKER_HOST;
    if (dockerHost) {
      const unixPath = dockerHost.startsWith('unix://')
        ? dockerHost.slice('unix://'.length)
        : dockerHost.startsWith('/') ? dockerHost : null;

      if (unixPath === null) {
        // tcp://, ssh://, http(s):// — not verifiable via filesystem; preserve legacy pass-through
        return { socketPath: dockerHost, runtime: 'docker' };
      }

      try {
        const st = fs.statSync(unixPath); // statSync (not lstat) follows symlinks
        if (st.isSocket()) {
          return { socketPath: dockerHost, runtime: 'docker' };
        }
      } catch {
        // Missing socket: not fatal (#295). The runtime probe below decides.
      }
      // fall through to /var/run/docker.sock (and ultimately null)
    }

    // Check standard Docker socket
    const standardDockerSock = '/var/run/docker.sock';
    if (fs.existsSync(standardDockerSock)) {
      return { socketPath: `unix://${standardDockerSock}`, runtime: 'docker' };
    }

    return null;
  }

  public resolveContainerSocket(): { socketPath: string; runtime: 'podman' | 'docker' } | null {
    return FileBuildDetector.resolveContainerSocket();
  }

  /**
   * Probes container runtime HEALTH (issue #295), never just a socket file.
   *
   * A working rootless podman answers `podman info` over a fork/exec helper and
   * has no socket unless `podman system service` was started — so
   * availability-by-socket-file reported it absent on every run and silently
   * dropped the act container gate.
   *
   * Returns `null` when there is no runtime, or when the runtime does not
   * answer at all: a dead runtime is a CLEAR SKIP, never a hard failure (#232).
   */
  public static probeContainerRuntime(): ContainerRuntimeProbe | null {
    return new FileBuildDetector().probeContainerRuntime();
  }

  /**
   * Probes container runtime HEALTH (issue #295), never just a socket file.
   *
   * Instance method on purpose: `resolveContainerRuntime()` and
   * `resolveContainerSocket()` are the seams tests (and alternate detectors)
   * override, and `resolveActCommand` must see the same answers it would get
   * from them.
   */
  public probeContainerRuntime(): ContainerRuntimeProbe | null {
    const runtime = this.resolveContainerRuntime();
    if (runtime === null) {
      return null;
    }

    const socketInfo = this.resolveContainerSocket();
    if (socketInfo !== null) {
      return {
        runtime: socketInfo.runtime,
        socketPath: socketInfo.socketPath,
        connection: 'socket'
      };
    }

    // No socket: ask the runtime itself whether it is usable.
    const probeArgs =
      runtime === 'podman'
        ? ['info', '--format', '{{.Host.Security.Rootless}}']
        : ['info', '--format', '{{.ServerVersion}}'];

    try {
      const res = child_process.spawnSync(runtime, probeArgs, {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: CONTAINER_PROBE_TIMEOUT_MS
      });
      if (res.status === 0) {
        return { runtime, socketPath: null, connection: 'fork-exec' };
      }
    } catch {
      // Spawn failure = unusable runtime.
    }

    return null;
  }

  /**
   * Checks if the `act` CLI binary is available on PATH.
   */
  public static hasActBinary(): boolean {
    return FileBuildDetector.isBinaryAvailable('act');
  }

  public hasActBinary(): boolean {
    return FileBuildDetector.hasActBinary();
  }

  /**
   * Checks if a command / binary is available on PATH.
   */
  public static isBinaryAvailable(binary: string): boolean {
    try {
      const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
      const res = child_process.spawnSync(lookupCmd, [binary], {
        stdio: ['ignore', 'ignore', 'ignore'],
        encoding: 'utf8'
      });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  public isBinaryAvailable(binary: string): boolean {
    return FileBuildDetector.isBinaryAvailable(binary);
  }

  /**
   * Inspects configuration and repository to resolve an `act` verification command if applicable.
   * Returns null if container gates are disabled, workflows are missing, act is missing, or no socket is found.
   */
  public resolveActCommand(workspaceDir: string, config?: AgyLoopConfig): GateCommandDefinition | null {
    const options = config?.options;

    // Check if containerGates is explicitly disabled
    if (options?.containerGates === false) {
      return null;
    }

    const actConfig = options?.act;
    if (actConfig?.enabled === false) {
      return null;
    }

    // Verify .github/workflows directory presence
    const workflowsDir = path.join(workspaceDir, MARKER_GITHUB_WORKFLOWS);
    if (!fs.existsSync(workflowsDir)) {
      return null;
    }

    // Verify act binary is installed
    if (!this.hasActBinary()) {
      return null;
    }

    // Verify a USABLE container runtime (#295). This is the ONLY place the
    // container-gate warning is emitted: read-only commands never call
    // `resolveActCommand`, so they are silent.
    const probe = this.probeContainerRuntime();
    if (!probe) {
      console.warn('[agyloop] Warning: no usable container runtime; skipping the act container gate.');
      return null;
    }

    // Construct act command arguments
    let cmd = 'act';
    if (actConfig?.workflow) {
      cmd += ` -W ${actConfig.workflow}`;
    }
    if (actConfig?.job) {
      cmd += ` -j ${actConfig.job}`;
    }

    // A socket connection must be named; act's default is fork/exec, which is
    // exactly right for a healthy rootless runtime with no socket.
    if (probe.connection === 'socket' && probe.runtime === 'podman') {
      cmd += ` --container-daemon-socket ${probe.socketPath}`;
    }

    return {
      id: CMD_ID_ACT,
      label: CMD_LABEL_ACT,
      command: cmd
    };
  }
}
