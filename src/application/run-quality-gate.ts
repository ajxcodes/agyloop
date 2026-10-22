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
  STAGE_COMMIT,
  STAGE_COMPLETED,
  MODE_STANDARD,
  ROLE_GATE,
  SUMMARY_STAGE_QUALITY_GATES,
  SUMMARY_STATUS_COMPLETED,
  SUMMARY_STATUS_FAILED,
  STATUS_PASSED,
  STATUS_FAILED,
  STATUS_VACUOUS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STATUS_TIMED_OUT,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STATUS_DISPLAY_TIMED_OUT,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  STATUS_SKIPPED,
  NOTE_EXECUTING_GATES,
  NOTE_GATES_PASSED,
  NOTE_GATES_FAILED,
  NOTE_RERUN_GATES_COMPLETED,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  DEFAULT_GATE_COMMANDS,
  GateCommandDefinition,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MAX_FILTERED_LOG_LINES,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  TOKEN_GATE_STATUS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  TOKEN_BUILD_STATUS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  TOKEN_FAILURE_FILE,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  TOKEN_FAILING_ASSERTION,
  MSG_COMMAND_FAILED_NO_OUTPUT,
  MSG_GATE_VACUOUS,
  MSG_GATE_UNMEASURABLE,
  LABEL_IMPLEMENTATION_EVIDENCE,
  LABEL_IMPLEMENTATION_EVIDENCE_LINE,
  LABEL_BASE_FRESHNESS,
  LABEL_BASE_FRESHNESS_LINE,
  HEADER_QUALITY_GATE_REPORT,
  LABEL_OVERALL_VERDICT,
  InvalidTransitionError,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
import type { ImplementationDiff } from './detect-implementation-diff';

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
  /**
   * The implementation-evidence verdict (issue #259).
   *
   * This is an INJECTED verdict, not a probe: the gate use case runs no git
   * command of its own. That is deliberate — the lifecycle owns the probe, and
   * a probe inside the gate would silently consume a queued gate command in
   * every consumer that drives this use case with a response queue.
   *
   * When it is present and reports an UNCHANGED tree, the gate refuses to
   * certify: no gate command is executed and the verdict is VACUOUS.
   */
  readonly implementationDiff?: ImplementationDiff | null;
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
  /**
   * True when the gate refused to certify an unimplemented tree (issue #259).
   * A VACUOUS verdict is NOT a failure: nothing was executed and nothing was
   * reverted — the stage was never advanced.
   */
  readonly vacuous?: boolean;
  /** The implementation-evidence verdict this run was given (when any). */
  readonly implementationDiff?: ImplementationDiff | null;
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

    // 1b. Issue #259: the gate refuses to certify an unimplemented tree.
    //
    // A passing suite over an UNCHANGED tree is positive evidence of nothing:
    // the pre-existing tests still pass when no implementation was produced.
    // The gate therefore refuses to certify such a tree — it executes NO gate
    // command, does not transition, does not touch the retry counter, and
    // reports the VACUOUS verdict instead of PASSED.
    //
    // A verdict that carries a `probeError` is NOT a verdict: the probe could
    // not read the tree at all (no git, not a repository, an unreadable
    // directory). There is nothing to certify against, so the gate keeps its
    // pre-existing behaviour instead of inventing a refusal.
    const injectedDiff = params.implementationDiff ?? null;
    // Issue #263: only a MEASURED branch diff can support a branch verdict. A
    // `measurementError` means the branch's own changes could not be measured
    // (no merge-base, the diff failed) — that is not "no changes", so the gate
    // must not report VACUOUS on it.
    const measuredDiff =
      injectedDiff && injectedDiff.probeError === null && (injectedDiff.measurementError ?? null) === null
        ? injectedDiff
        : null;
    if (measuredDiff && !measuredDiff.hasChanges) {
      return this.buildVacuousResult(sm, measuredDiff);
    }

    // 2. Enforce lifecycle transition rules
    if (sm.currentStage === STAGE_IMPLEMENT) {
      sm.transition(STAGE_QUALITY_GATE, { note: NOTE_EXECUTING_GATES });
    } else if (sm.currentStage === STAGE_QUALITY_GATE) {
      // Already at quality gate, re-executing
    } else if (sm.currentStage === STAGE_COMMIT) {
      sm.transition(STAGE_QUALITY_GATE, { note: NOTE_EXECUTING_GATES });
    } else if (sm.currentStage === STAGE_COMPLETED) {
      sm.transition(STAGE_QUALITY_GATE, { note: NOTE_RERUN_GATES_COMPLETED });
    } else {
      throw new InvalidTransitionError(
        sm.currentStage,
        STAGE_QUALITY_GATE,
        sm.mode,
        `Cannot run quality gates from stage '${sm.currentStage}'. Pipeline must be in '${STAGE_IMPLEMENT}', '${STAGE_COMMIT}', '${STAGE_COMPLETED}' (or re-running in '${STAGE_QUALITY_GATE}').`
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      sm.resetImplementGateLoop();
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
      sm.incrementImplementGateLoop();
    }

    // 7. Update AgyLoop Summary.md via PlanGeneratorPort
    const resolvedPlan = this.planGenerator.resolvePlanFile({
      projectRoot: workspace,
      issue: activeIssue,
      planPath: params.planPath,
      planDir: params.planDir || sm.planDir
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
    const rawSummaryReport = gateReport.formatTextReport({
      nextStage: sm.currentStage,
      summaryPath: resolvedPlan?.summaryPath
    });

    // 8b. Issue #259: make "the suite passed" and "the suite passed ON A TREE
    // THAT CONTAINS THE IMPLEMENTATION" two different statements. Issue #263
    // adds the base-freshness advisory and the unmeasurable-branch warning to
    // the same block. The block is purely additive: when there is nothing to
    // add, the report is byte-identical to what it always was.
    const summaryReport = injectedDiff
      ? this.withImplementationEvidence(rawSummaryReport, injectedDiff)
      : rawSummaryReport;

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
      diagnosticSnippet: primaryDiagnostic,
      vacuous: false,
      implementationDiff: injectedDiff
    };
  }

  /**
   * Builds the VACUOUS verdict: the gate refused to certify a tree that
   * contains no implementation.
   *
   * No gate command ran, no transition happened, the retry counter is
   * untouched, and the summary log is NOT written (nothing ran, so there is
   * nothing to log). The verdict line is VACUOUS — never PASSED — so the
   * operator can tell "refused" from "failed".
   *
   * The report is built as a plain string on purpose: a `GateSummaryReport`
   * would have to widen the `GateVerdict` union, and this issue must not
   * change any shared contract.
   *
   * `buildStatus` / `testsStatus` carry `STATUS_VACUOUS`, not `STATUS_FAILED`:
   * no build and no test ran, so there is no outcome to report — only the
   * refusal to certify.
   */
  private buildVacuousResult(
    sm: StateMachine,
    implementationDiff: ImplementationDiff
  ): QualityGateRunResult {
    const baseRef = implementationDiff.baseRef;

    let summaryReport = `${HEADER_QUALITY_GATE_REPORT}\n`;
    summaryReport += `${LABEL_OVERALL_VERDICT.padEnd(16)}: ${STATUS_VACUOUS}\n`;
    summaryReport += `  ⚠ ${MSG_GATE_VACUOUS.replace('{baseRef}', baseRef)}\n`;
    // The evidence line is always part of a VACUOUS report (it states the
    // measured count of 0); the freshness advisory follows it when the base
    // branch has advanced (issue #263).
    summaryReport += this.buildEvidenceLines(implementationDiff, {
      evidenceIndent: '  ',
      alwaysIncludeEvidenceLine: true
    }).join('\n');

    return {
      passed: false,
      vacuous: true,
      currentStage: sm.currentStage,
      stateMachine: sm,
      reports: [],
      totalDurationMs: 0,
      summaryReport,
      // Issue #259: a VACUOUS verdict is neither a pass nor a failure — NO
      // gate command ran, so there is no build and no test outcome to record.
      // `STATUS_FAILED` would claim a failure for an event that never
      // happened (the same false-claim class this issue removes); the honest
      // token is the refusal itself.
      buildStatus: STATUS_VACUOUS,
      testsStatus: STATUS_VACUOUS,
      gateReport: undefined,
      diagnosticSnippet: null,
      implementationDiff
    };
  }

  /**
   * Inserts the implementation-evidence block into a gate report that DID run.
   * The block sits directly under the verdict so the reader sees, in one
   * glance, that the suite was executed against a tree that actually contains
   * the implementation — and, when the base branch has advanced, how far
   * behind that tree is (issue #263).
   *
   * Returns the report unchanged when the block is empty, so a measured,
   * up-to-date tree produces exactly the pre-#263 text.
   */
  private withImplementationEvidence(
    summaryReport: string,
    implementationDiff: ImplementationDiff
  ): string {
    const addedLines = this.buildEvidenceLines(implementationDiff);
    if (addedLines.length === 0) {
      return summaryReport;
    }

    const lines = summaryReport.split('\n');
    const verdictIndex = lines.findIndex((line) => line.startsWith(LABEL_OVERALL_VERDICT));

    if (verdictIndex === -1) {
      return `${summaryReport}\n${addedLines.join('\n')}`;
    }

    lines.splice(verdictIndex + 1, 0, ...addedLines);
    return lines.join('\n');
  }

  /**
   * Builds the evidence block shared by the running-gate report and the
   * VACUOUS report (so the two cannot drift):
   *
   *   1. `Implementation : N file(s) changed relative to '<baseRef>'`;
   *   2. `Base freshness : …` when the base ref has advanced since the branch
   *      point (advisory — never blocks a pass);
   *   3. the `⚠ Could not measure …` warning when the branch diff is
   *      unmeasurable (issue #263).
   *
   * The count is computed from the same two arrays the probe measured, so the
   * printed number and the measured number cannot disagree (AC5).
   */
  private buildEvidenceLines(
    implementationDiff: ImplementationDiff,
    options: { evidenceIndent?: string; alwaysIncludeEvidenceLine?: boolean } = {}
  ): string[] {
    const lines: string[] = [];
    const indent = options.evidenceIndent ?? '';

    if (options.alwaysIncludeEvidenceLine || implementationDiff.hasChanges) {
      const changedFileCount =
        implementationDiff.trackedChangedFiles.length + implementationDiff.untrackedFiles.length;
      lines.push(
        `${indent}${LABEL_IMPLEMENTATION_EVIDENCE_LINE.replace('{label}', LABEL_IMPLEMENTATION_EVIDENCE)
          .replace('{count}', String(changedFileCount))
          .replace('{baseRef}', implementationDiff.baseRef)}`
      );
    }

    const baseAheadCommits = implementationDiff.baseAheadCommits ?? 0;
    const mergeBase = implementationDiff.mergeBase ?? null;
    if (baseAheadCommits > 0 && mergeBase !== null) {
      // The LOCAL ref only (no `git fetch`): a base that moved only on the
      // remote is not detected.
      lines.push(
        `  ${LABEL_BASE_FRESHNESS_LINE.replace('{label}', LABEL_BASE_FRESHNESS)
          .replace('{ahead}', String(baseAheadCommits))
          .replace('{baseRef}', implementationDiff.baseRef)
          .replace('{own}', String(implementationDiff.ownCommits ?? 0))
          .replace('{mergeBase}', mergeBase.slice(0, 7))}`
      );
    }

    const measurementError = implementationDiff.measurementError ?? null;
    if (measurementError !== null) {
      lines.push(`  ⚠ ${MSG_GATE_UNMEASURABLE.replace('{error}', measurementError)}`);
    }

    return lines;
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
