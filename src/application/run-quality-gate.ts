/**
 * agyloop - RunQualityGateUseCase
 *
 * Coordinates Quality Gate phase execution:
 * 1. Validates lifecycle stage rules (current stage must be IMPLEMENT or QUALITY_GATE).
 * 2. Advances StateMachine transition: IMPLEMENT -> QUALITY_GATE.
 * 3. Resolves Quality Gate subagent definition and timeout configuration.
 * 4. Executes verification commands via CommandExecutorPort with timeout enforcement.
 * 5. Applies log buffering & filtering isolation barrier to summarize outputs without polluting conversation context.
 * 6. Evaluates overall verdict:
 *    - All pass: transitions to STAGE_REVIEW.
 *    - Any fail: falls back to STAGE_IMPLEMENT.
 * 7. Updates AgyLoop Summary.md with build and test metrics.
 * 8. Checkpoints pipeline state to StateRepository.
 */

import {
  StateMachine,
  STAGE_NONE,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  MODE_STANDARD,
  ROLE_GATE,
  SUMMARY_STAGE_QUALITY_GATES,
  SUMMARY_STATUS_COMPLETED,
  SUMMARY_STATUS_FAILED,
  STATUS_PASSED,
  STATUS_FAILED,
  STATUS_TIMED_OUT,
  STATUS_DISPLAY_TIMED_OUT,
  STATUS_SKIPPED,
  NOTE_EXECUTING_GATES,
  NOTE_GATES_PASSED,
  NOTE_GATES_FAILED,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  DEFAULT_GATE_COMMANDS,
  GateCommandDefinition,
  MAX_FILTERED_LOG_LINES,
  MAX_FILTERED_OUTPUT_CHARS,
  MS_PER_SECOND,
  ECOSYSTEM_UNKNOWN,
  CMD_ID_BUILD,
  CMD_ID_TYPECHECK,
  CMD_ID_TEST,
  CMD_ID_PLAYWRIGHT,
  CMD_ID_E2E,
  CMD_PREFIX_CUSTOM,
  CMD_PREFIX_CONFIG,
  TestMetrics,
  DiagnosticSnippet,
  GateSummaryReport,
  TOKEN_GATE_STATUS,
  TOKEN_BUILD_STATUS,
  TOKEN_FAILURE_FILE,
  TOKEN_FAILING_ASSERTION,
  MSG_COMMAND_FAILED_NO_OUTPUT,
  InvalidTransitionError,
  QualityGateTimeoutError
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  AgyLoopConfig,
  PlanGeneratorPort,
  CommandExecutorPort,
  BuildDetectorPort
} from '../ports';

import { ResolveSubagentUseCase } from './resolve-subagent';

export interface GateCommandReport {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly passed: boolean;
  readonly timedOut: boolean;
  readonly testMetrics?: { total?: number; passed?: number; failed?: number } | TestMetrics | null;
  readonly failureSnippet?: string;
  readonly diagnosticSnippet?: DiagnosticSnippet | null;
}

export interface QualityGateRunParams {
  readonly issue?: number | string | null;
  readonly planPath?: string | null;
  readonly planDir?: string | null;
  readonly commands?: readonly string[] | readonly GateCommandDefinition[];
  readonly timeoutSeconds?: number;
  readonly dryRun?: boolean;
  readonly configPath?: string | null;
  readonly workspaceDir?: string;
}

export interface QualityGateRunResult {
  readonly passed: boolean;
  readonly currentStage: string;
  readonly stateMachine: StateMachine;
  readonly reports: readonly GateCommandReport[];
  readonly totalDurationMs: number;
  readonly summaryReport: string;
  readonly buildStatus: string;
  readonly testsStatus: string;
  readonly buildSystem?: string;
  readonly detectedEcosystems?: readonly string[];
  readonly gateReport?: GateSummaryReport;
  readonly diagnosticSnippet?: DiagnosticSnippet | null;
}

export class RunQualityGateUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator: PlanGeneratorPort;
  private readonly commandExecutor: CommandExecutorPort;
  private readonly buildDetector?: BuildDetectorPort;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort,
    commandExecutor: CommandExecutorPort,
    buildDetector?: BuildDetectorPort,
    resolveSubagentUseCase?: ResolveSubagentUseCase
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.commandExecutor = commandExecutor;
    this.buildDetector = buildDetector;
    this.resolveSubagentUseCase =
      resolveSubagentUseCase ?? new ResolveSubagentUseCase(configRepo);
  }

  public async execute(params: QualityGateRunParams = {}): Promise<QualityGateRunResult> {
    const workspace = params.workspaceDir || process.cwd();

    // 1. Load active pipeline state checkpoint
    const snapshot = await this.stateRepo.load();
    if (!snapshot) {
      throw new InvalidTransitionError(
        STAGE_NONE,
        STAGE_QUALITY_GATE,
        MODE_STANDARD,
        'Cannot run quality gates: No pipeline state found. Run "agyloop implement" first.'
      );
    }

    const sm = StateMachine.fromSnapshot(snapshot);
    const activeIssue = params.issue || sm.issue;
    if (activeIssue) {
      sm.setIssue(activeIssue);
    }

    // 2. Enforce lifecycle transition rules
    if (sm.currentStage === STAGE_IMPLEMENT) {
      sm.transition(STAGE_QUALITY_GATE, { note: NOTE_EXECUTING_GATES });
    } else if (sm.currentStage === STAGE_QUALITY_GATE) {
      // Already at quality gate, re-executing
    } else {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_QUALITY_GATE,
        sm.mode,
        `Cannot run quality gates from stage '${sm.currentStage}'. Pipeline must be in '${STAGE_IMPLEMENT}' (or re-running in '${STAGE_QUALITY_GATE}').`
      );
    }

    // 3. Load config and resolve subagent descriptor & timeouts
    const config = this.configRepo.loadConfig({
      customPath: params.configPath,
      cwd: workspace
    });

    const gateDef = this.resolveSubagentUseCase.execute({
      role: ROLE_GATE,
      customConfig: config,
      workspaceDir: workspace
    });

    const timeoutSeconds =
      params.timeoutSeconds && params.timeoutSeconds > 0
        ? params.timeoutSeconds
        : config.options.gateTimeoutSeconds || DEFAULT_GATE_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds * MS_PER_SECOND;

    // 4. Resolve commands to execute (supporting auto-detection engine and config overrides)
    let commandDefinitions: readonly GateCommandDefinition[];
    let detectedEcosystemNames: string[] = [];
    let primaryEcosystemName: string | undefined;

    if (this.buildDetector) {
      commandDefinitions = await this.buildDetector.resolveCommands(
        workspace,
        config,
        params.commands
      );
      try {
        const detected = await this.buildDetector.detect(workspace);
        detectedEcosystemNames = detected.ecosystems.map((e) => e.toString());
        primaryEcosystemName = detected.primaryEcosystem.toString();
      } catch (err: unknown) {
        // Fall back gracefully if detector metadata extraction encounters an issue
        detectedEcosystemNames = [ECOSYSTEM_UNKNOWN];
        primaryEcosystemName = ECOSYSTEM_UNKNOWN;
      }
    } else {
      commandDefinitions = this.resolveCommands(params.commands, config);
    }

    // 5. Execute commands in isolated shell with log buffering and filtering
    const reports: GateCommandReport[] = [];
    let allPassed = true;
    let totalDurationMs = 0;
    let buildStatus: string = STATUS_PASSED;
    let testsStatus: string = STATUS_PASSED;
    let testsMetricSummary = '';

    for (const cmdDef of commandDefinitions) {
      const execResult = await this.commandExecutor.execute(cmdDef.command, {
        cwd: workspace,
        timeoutMs
      });

      totalDurationMs += execResult.durationMs;
      const passed = execResult.exitCode === 0 && !execResult.timedOut;

      const testMetrics = this.extractTestMetrics(execResult.combinedOutput);
      let failureSnippet: string | undefined;
      let diagnosticSnippet: DiagnosticSnippet | null = null;

      if (!passed) {
        allPassed = false;
        diagnosticSnippet = DiagnosticSnippet.extract(execResult.combinedOutput, execResult.stderr);
        failureSnippet = diagnosticSnippet ? diagnosticSnippet.toString() : this.extractFailureSnippet(execResult.combinedOutput, execResult.stderr);
      }

      if (this.isBuildCommand(cmdDef.id) && !passed) {
        buildStatus = STATUS_FAILED;
      }

      if (this.isTestCommand(cmdDef.id)) {
        if (!passed) {
          testsStatus = STATUS_FAILED;
        } else if (testMetrics && (testMetrics.passed || testMetrics.total)) {
          testsMetricSummary = ` (${testMetrics.passed || testMetrics.total} passed)`;
        }
      }

      reports.push({
        id: cmdDef.id,
        label: cmdDef.label,
        command: cmdDef.command,
        exitCode: execResult.exitCode,
        durationMs: execResult.durationMs,
        passed,
        timedOut: execResult.timedOut,
        testMetrics,
        failureSnippet,
        diagnosticSnippet
      });

      // Fail fast on build/test failure
      if (!passed) {
        break;
      }
    }

    if (testsStatus === STATUS_PASSED && testsMetricSummary) {
      testsStatus = `${STATUS_PASSED}${testsMetricSummary}`;
    }

    const failedReport = reports.find((r) => !r.passed);
    const primaryDiagnostic = failedReport?.diagnosticSnippet ?? (failedReport?.failureSnippet ? DiagnosticSnippet.fromRaw(failedReport.failureSnippet) : null);
    const primaryTestMetrics = reports.find((r) => r.testMetrics)?.testMetrics;
    const testMetricsVO = primaryTestMetrics instanceof TestMetrics
      ? primaryTestMetrics
      : (primaryTestMetrics ? TestMetrics.create(primaryTestMetrics) : null);

    const gateReport = GateSummaryReport.create({
      verdict: allPassed ? STATUS_PASSED : STATUS_FAILED,
      totalDurationMs,
      commands: reports.map((r) => ({
        id: r.id,
        label: r.label,
        command: r.command,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        passed: r.passed,
        timedOut: r.timedOut,
        testMetrics: r.testMetrics instanceof TestMetrics ? r.testMetrics : (r.testMetrics ? TestMetrics.create(r.testMetrics) : null),
        failureSnippet: r.failureSnippet
      })),
      testMetrics: testMetricsVO,
      buildStatus,
      testsStatus,
      diagnosticSnippet: primaryDiagnostic,
      buildSystem: primaryEcosystemName,
      detectedEcosystems: detectedEcosystemNames
    });

    // 6. Enforce State Transition: Success -> REVIEW, Failure -> Fallback to IMPLEMENT
    if (allPassed) {
      sm.transition(STAGE_REVIEW, {
        note: NOTE_GATES_PASSED,
        gateVerdict: STATUS_PASSED,
        gateTokens: gateReport.formatStructuredTokens()
      });
    } else {
      sm.transition(STAGE_IMPLEMENT, {
        note: NOTE_GATES_FAILED,
        gateVerdict: STATUS_FAILED,
        gateTokens: gateReport.formatStructuredTokens(),
        failureSnippet: failedReport?.failureSnippet,
        failureFile: primaryDiagnostic?.fileLocation,
        failingAssertion: primaryDiagnostic?.failingAssertion,
        selfCorrectionPayload: gateReport.formatSelfCorrectionPayload()
      });
    }

    // 7. Update AgyLoop Summary.md via PlanGeneratorPort
    const resolvedPlan = this.planGenerator.resolvePlanFile({
      projectRoot: workspace,
      issue: activeIssue,
      planPath: params.planPath,
      planDir: params.planDir
    });

    const durationStr = `${(totalDurationMs / MS_PER_SECOND).toFixed(1)}s`;
    const gateStatus = allPassed ? SUMMARY_STATUS_COMPLETED : SUMMARY_STATUS_FAILED;

    if (!params.dryRun) {
      await this.stateRepo.save(sm.toSnapshot());

      if (resolvedPlan && resolvedPlan.summaryPath) {
        this.planGenerator.updateSummaryLog(resolvedPlan.summaryPath, {
          stage: SUMMARY_STAGE_QUALITY_GATES,
          subagent: gateDef.name,
          model: gateDef.model,
          status: gateStatus,
          duration: durationStr,
          buildStatus,
          testsStatus,
          buildSystem: primaryEcosystemName,
          detectedEcosystems: detectedEcosystemNames,
          executedCommands: reports.map((r) => r.command),
          reviewNote: allPassed
            ? `All quality gates passed successfully in ${durationStr}.`
            : `Quality gates failed during execution.${primaryDiagnostic?.fileLocation ? ` Failing location: ${primaryDiagnostic.fileLocation}.` : ''} Pipeline reverted to IMPLEMENT.`
        });
      }
    }

    // 8. Generate concise token-minimized summary report
    const summaryReport = gateReport.formatTextReport({
      nextStage: sm.currentStage,
      summaryPath: resolvedPlan?.summaryPath
    });

    return {
      passed: allPassed,
      currentStage: sm.currentStage,
      stateMachine: sm,
      reports,
      totalDurationMs,
      summaryReport,
      buildStatus,
      testsStatus,
      buildSystem: primaryEcosystemName,
      detectedEcosystems: detectedEcosystemNames,
      gateReport,
      diagnosticSnippet: primaryDiagnostic
    };
  }

  private resolveCommands(
    inputCommands?: readonly string[] | readonly GateCommandDefinition[],
    config?: AgyLoopConfig
  ): readonly GateCommandDefinition[] {

    if (inputCommands && inputCommands.length > 0) {
      return inputCommands.map((cmd, idx) => {
        if (typeof cmd === 'string') {
          return {
            id: `${CMD_PREFIX_CUSTOM}-cmd-${idx + 1}`,
            label: `Custom Command ${idx + 1}`,
            command: cmd
          };
        }
        return cmd;
      });
    }

    if (config?.options?.gateCommands && Array.isArray(config.options.gateCommands)) {
      return config.options.gateCommands.map((cmd: string | GateCommandDefinition, idx: number) => {
        if (typeof cmd === 'string') {
          return {
            id: `${CMD_PREFIX_CONFIG}-cmd-${idx + 1}`,
            label: `Configured Command ${idx + 1}`,
            command: cmd
          };
        }
        return cmd;
      });
    }

    return DEFAULT_GATE_COMMANDS;
  }

  private extractTestMetrics(output: string): TestMetrics | null {
    if (!output) return null;
    return TestMetrics.parse(output);
  }

  private extractFailureSnippet(combinedOutput: string, stderr: string): string {
    const diag = DiagnosticSnippet.extract(combinedOutput, stderr);
    return diag ? diag.toString() : MSG_COMMAND_FAILED_NO_OUTPUT;
  }

  private isBuildCommand(cmdId: string): boolean {
    const id = cmdId.toLowerCase();
    return id.includes(CMD_ID_BUILD) || id.includes(CMD_ID_TYPECHECK);
  }

  private isTestCommand(cmdId: string): boolean {
    const id = cmdId.toLowerCase();
    return (
      id.includes(CMD_ID_TEST) ||
      id.includes(CMD_ID_PLAYWRIGHT) ||
      id.includes(CMD_ID_E2E)
    );
  }

  private generateSummaryReport(data: {
    allPassed: boolean;
    totalDurationMs: number;
    reports: readonly GateCommandReport[];
    nextStage: string;
    summaryPath?: string;
    buildSystem?: string;
  }): string {
    const failedReport = data.reports.find((r) => !r.passed);
    const primaryDiagnostic = failedReport?.diagnosticSnippet ?? (failedReport?.failureSnippet ? DiagnosticSnippet.fromRaw(failedReport.failureSnippet) : null);
    const testMetrics = data.reports.find((r) => r.testMetrics)?.testMetrics;
    const testMetricsVO = testMetrics instanceof TestMetrics ? testMetrics : (testMetrics ? TestMetrics.create(testMetrics) : null);

    const reportVO = GateSummaryReport.create({
      verdict: data.allPassed ? STATUS_PASSED : STATUS_FAILED,
      totalDurationMs: data.totalDurationMs,
      commands: data.reports.map((r) => ({
        id: r.id,
        label: r.label,
        command: r.command,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        passed: r.passed,
        timedOut: r.timedOut,
        testMetrics: r.testMetrics instanceof TestMetrics ? r.testMetrics : (r.testMetrics ? TestMetrics.create(r.testMetrics) : null),
        failureSnippet: r.failureSnippet
      })),
      testMetrics: testMetricsVO,
      diagnosticSnippet: primaryDiagnostic,
      buildSystem: data.buildSystem
    });

    return reportVO.formatTextReport({
      nextStage: data.nextStage,
      summaryPath: data.summaryPath
    });
  }
}
