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
  STATUS_SKIPPED,
  NOTE_EXECUTING_GATES,
  NOTE_GATES_PASSED,
  NOTE_GATES_FAILED,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  DEFAULT_GATE_COMMANDS,
  GateCommandDefinition,
  MAX_FILTERED_LOG_LINES,
  MAX_FILTERED_OUTPUT_CHARS,
  InvalidTransitionError,
  QualityGateTimeoutError
} from '../domain';
import {
  StateRepository,
  ConfigRepository,
  AgyLoopConfig,
  PlanGeneratorPort,
  CommandExecutorPort
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
  readonly testMetrics?: { total?: number; passed?: number; failed?: number } | null;
  readonly failureSnippet?: string;
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
}

export class RunQualityGateUseCase {
  private readonly stateRepo: StateRepository;
  private readonly configRepo: ConfigRepository;
  private readonly planGenerator: PlanGeneratorPort;
  private readonly commandExecutor: CommandExecutorPort;
  private readonly resolveSubagentUseCase: ResolveSubagentUseCase;

  constructor(
    stateRepo: StateRepository,
    configRepo: ConfigRepository,
    planGenerator: PlanGeneratorPort,
    commandExecutor: CommandExecutorPort,
    resolveSubagentUseCase?: ResolveSubagentUseCase
  ) {
    this.stateRepo = stateRepo;
    this.configRepo = configRepo;
    this.planGenerator = planGenerator;
    this.commandExecutor = commandExecutor;
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
    const timeoutMs = timeoutSeconds * 1000;

    // 4. Resolve commands to execute
    const commandDefinitions = this.resolveCommands(params.commands, config);

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

      if (!passed) {
        allPassed = false;
        failureSnippet = this.extractFailureSnippet(execResult.combinedOutput, execResult.stderr);
      }

      if (cmdDef.id.toLowerCase().includes('build') || cmdDef.id.toLowerCase().includes('typecheck')) {
        if (!passed) buildStatus = STATUS_FAILED;
      }

      if (cmdDef.id.toLowerCase().includes('test')) {
        if (!passed) {
          testsStatus = STATUS_FAILED;
        } else if (testMetrics && testMetrics.total) {
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
        failureSnippet
      });

      // Fail fast on build/test failure
      if (!passed) {
        break;
      }
    }

    if (testsStatus === STATUS_PASSED && testsMetricSummary) {
      testsStatus = `${STATUS_PASSED}${testsMetricSummary}`;
    }

    // 6. Enforce State Transition: Success -> REVIEW, Failure -> Fallback to IMPLEMENT
    if (allPassed) {
      sm.transition(STAGE_REVIEW, { note: NOTE_GATES_PASSED });
    } else {
      sm.transition(STAGE_IMPLEMENT, { note: NOTE_GATES_FAILED });
    }

    // 7. Update AgyLoop Summary.md via PlanGeneratorPort
    const resolvedPlan = this.planGenerator.resolvePlanFile({
      projectRoot: workspace,
      issue: activeIssue,
      planPath: params.planPath,
      planDir: params.planDir
    });

    const durationStr = `${(totalDurationMs / 1000).toFixed(1)}s`;
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
          reviewNote: allPassed
            ? `All quality gates passed successfully in ${durationStr}.`
            : `Quality gates failed during execution. Pipeline reverted to IMPLEMENT.`
        });
      }
    }

    // 8. Generate concise token-minimized summary report
    const summaryReport = this.generateSummaryReport({
      allPassed,
      totalDurationMs,
      reports,
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
      testsStatus
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
            id: `gate-cmd-${idx + 1}`,
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
            id: `config-cmd-${idx + 1}`,
            label: `Configured Command ${idx + 1}`,
            command: cmd
          };
        }
        return cmd;
      });
    }

    return DEFAULT_GATE_COMMANDS;
  }

  private extractTestMetrics(output: string): { total?: number; passed?: number; failed?: number } | null {
    if (!output) return null;

    const testsMatch = output.match(/tests\s+(\d+)/i);
    const passMatch = output.match(/pass\s+(\d+)/i);
    const failMatch = output.match(/fail\s+(\d+)/i);

    if (testsMatch || passMatch || failMatch) {
      return {
        total: testsMatch ? parseInt(testsMatch[1], 10) : undefined,
        passed: passMatch ? parseInt(passMatch[1], 10) : undefined,
        failed: failMatch ? parseInt(failMatch[1], 10) : undefined
      };
    }

    return null;
  }

  private extractFailureSnippet(combinedOutput: string, stderr: string): string {
    const raw = (stderr && stderr.trim().length > 0 ? stderr : combinedOutput) || 'Command failed without output.';
    const lines = raw.split('\n');

    // Filter out common noise lines (empty lines, formatting lines)
    const significantLines = lines.filter((l) => l.trim().length > 0);

    // Grab up to MAX_FILTERED_LOG_LINES from end or error section
    const snippetLines =
      significantLines.length > MAX_FILTERED_LOG_LINES
        ? significantLines.slice(-MAX_FILTERED_LOG_LINES)
        : significantLines;

    let snippet = snippetLines.join('\n');
    if (snippet.length > MAX_FILTERED_OUTPUT_CHARS) {
      snippet = snippet.substring(snippet.length - MAX_FILTERED_OUTPUT_CHARS);
    }

    return snippet.trim();
  }

  private generateSummaryReport(data: {
    allPassed: boolean;
    totalDurationMs: number;
    reports: readonly GateCommandReport[];
    nextStage: string;
    summaryPath?: string;
  }): string {
    const verdict = data.allPassed ? 'PASSED' : 'FAILED';
    const duration = `${(data.totalDurationMs / 1000).toFixed(2)}s`;

    let report = `=== AgyLoop: Quality Gate Report ===\n`;
    report += `Overall Verdict : ${verdict}\n`;
    report += `Total Duration  : ${duration}\n`;
    report += `Next Stage      : ${data.nextStage}\n\n`;

    report += `Execution Matrix:\n`;
    data.reports.forEach((r, idx) => {
      const status = r.timedOut ? 'TIMED OUT' : r.passed ? 'PASSED' : 'FAILED';
      const cmdDuration = `${(r.durationMs / 1000).toFixed(2)}s`;
      let details = '';
      if (r.testMetrics && r.testMetrics.total) {
        details = ` (${r.testMetrics.passed ?? 0}/${r.testMetrics.total} tests passed)`;
      } else if (!r.passed) {
        details = ` (exit code ${r.exitCode})`;
      }
      report += `  ${idx + 1}. [${status}] ${r.label}${details} [${cmdDuration}]\n`;
    });

    const failedReport = data.reports.find((r) => !r.passed);
    if (failedReport && failedReport.failureSnippet) {
      report += `\nDiagnostic Failure Details (${failedReport.label}):\n`;
      report += `----------------------------------------------------------------------\n`;
      report += `${failedReport.failureSnippet}\n`;
      report += `----------------------------------------------------------------------\n`;
    }

    if (data.summaryPath) {
      report += `\nExecution Log   : ${data.summaryPath}\n`;
    }

    return report.trim();
  }
}
