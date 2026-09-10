/**
 * agyloop - GateSummaryReport Value Object
 *
 * Immutable representation of a structured Quality Gate report with dual-format capability:
 * - Emits and parses machine-readable GATE_* tokens and Markdown execution matrices.
 * - Bridges Quality Gate subagent verdicts to parent orchestrator and downstream implementer.
 *
 * Pure domain value object: 100% free of filesystem, child processes, or external I/O.
 */

import {
  STATUS_PASSED,
  STATUS_FAILED,
  STATUS_TIMED_OUT,
  STATUS_DISPLAY_TIMED_OUT,
  TOKEN_GATE_STATUS,
  TOKEN_BUILD_STATUS,
  TOKEN_TEST_METRICS,
  TOKEN_FAILURE_FILE,
  TOKEN_FAILING_ASSERTION,
  HEADER_QUALITY_GATE_REPORT,
  LABEL_OVERALL_VERDICT,
  LABEL_BUILD_STATUS,
  LABEL_BUILD_SYSTEM,
  LABEL_TOTAL_DURATION,
  LABEL_NEXT_STAGE,
  LABEL_EXECUTION_MATRIX,
  LABEL_DIAGNOSTIC_FAILURE_DETAILS,
  LABEL_EXECUTION_LOG,
  SECTION_SELF_CORRECTION_TITLE,
  DIVIDER_DASHED,
  MS_PER_SECOND,
  REGEX_GATE_STATUS_TOKEN,
  REGEX_BUILD_STATUS_TOKEN,
  REGEX_TEST_METRICS_TOKEN,
  REGEX_FAILURE_FILE_TOKEN,
  REGEX_FAILING_ASSERTION_TOKEN,
  REGEX_MD_TABLE_ROW
} from '../constants';
import { QualityGateSummaryParseError, ValidationError } from '../errors';
import { TestMetrics, TestMetricsProps } from './test-metrics';
import { DiagnosticSnippet, DiagnosticSnippetProps } from './diagnostic-snippet';

export type GateVerdict = typeof STATUS_PASSED | typeof STATUS_FAILED | typeof STATUS_TIMED_OUT;

export interface GateCommandSummary {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly passed: boolean;
  readonly timedOut: boolean;
  readonly testMetrics?: TestMetrics | null;
  readonly failureSnippet?: string;
}

export interface GateSummaryReportProps {
  readonly verdict: GateVerdict;
  readonly totalDurationMs: number;
  readonly commands: readonly GateCommandSummary[];
  readonly testMetrics?: TestMetrics | null;
  readonly buildStatus?: string;
  readonly testsStatus?: string;
  readonly diagnosticSnippet?: DiagnosticSnippet | null;
  readonly buildSystem?: string;
  readonly detectedEcosystems?: readonly string[];
}

export interface GateSummaryReportSerialized {
  readonly verdict: GateVerdict;
  readonly totalDurationMs: number;
  readonly commands: readonly GateCommandSummary[];
  readonly testMetrics: TestMetricsProps | null;
  readonly buildStatus: string;
  readonly testsStatus: string;
  readonly diagnosticSnippet: (DiagnosticSnippetProps & { lineCount: number }) | null;
  readonly buildSystem?: string;
  readonly detectedEcosystems?: readonly string[];
}

export class GateSummaryReport {
  public readonly verdict: GateVerdict;
  public readonly totalDurationMs: number;
  public readonly commands: readonly GateCommandSummary[];
  public readonly testMetrics: TestMetrics | null;
  public readonly buildStatus: string;
  public readonly testsStatus: string;
  public readonly diagnosticSnippet: DiagnosticSnippet | null;
  public readonly buildSystem?: string;
  public readonly detectedEcosystems?: readonly string[];

  constructor(props: GateSummaryReportProps) {
    if (!props || typeof props !== 'object') {
      throw new ValidationError('props', props, 'GateSummaryReport props must be an object.');
    }

    if (
      props.verdict !== STATUS_PASSED &&
      props.verdict !== STATUS_FAILED &&
      props.verdict !== STATUS_TIMED_OUT
    ) {
      throw new ValidationError('verdict', props.verdict, `Invalid gate verdict: ${props.verdict}`);
    }

    this.verdict = props.verdict;
    this.totalDurationMs = Math.max(0, props.totalDurationMs ?? 0);
    this.commands = Object.freeze([...(props.commands || [])]);
    this.testMetrics = props.testMetrics ?? null;
    this.buildStatus = props.buildStatus ?? (this.verdict === STATUS_PASSED ? STATUS_PASSED : STATUS_FAILED);
    this.testsStatus = props.testsStatus ?? (this.verdict === STATUS_PASSED ? STATUS_PASSED : STATUS_FAILED);
    this.diagnosticSnippet = props.diagnosticSnippet ?? null;
    this.buildSystem = props.buildSystem;
    this.detectedEcosystems = props.detectedEcosystems ? Object.freeze([...props.detectedEcosystems]) : undefined;

    Object.freeze(this);
  }

  public isPassed(): boolean {
    return this.verdict === STATUS_PASSED;
  }

  public isFailed(): boolean {
    return this.verdict === STATUS_FAILED;
  }

  public isTimedOut(): boolean {
    return this.verdict === STATUS_TIMED_OUT;
  }

  public formatTextReport(options: { nextStage?: string; summaryPath?: string } = {}): string {
    const duration = `${(this.totalDurationMs / MS_PER_SECOND).toFixed(2)}s`;

    let report = `${HEADER_QUALITY_GATE_REPORT}\n`;
    report += `${LABEL_OVERALL_VERDICT.padEnd(16)}: ${this.verdict}\n`;
    if (this.buildSystem) {
      report += `${LABEL_BUILD_SYSTEM.padEnd(16)}: ${this.buildSystem}\n`;
    }
    report += `${LABEL_TOTAL_DURATION.padEnd(16)}: ${duration}\n`;
    if (options.nextStage) {
      report += `${LABEL_NEXT_STAGE.padEnd(16)}: ${options.nextStage}\n`;
    }
    report += `\n${LABEL_EXECUTION_MATRIX}\n`;

    this.commands.forEach((cmd, idx) => {
      const status = cmd.timedOut ? STATUS_DISPLAY_TIMED_OUT : cmd.passed ? STATUS_PASSED : STATUS_FAILED;
      const cmdDuration = `${(cmd.durationMs / MS_PER_SECOND).toFixed(2)}s`;
      let details = '';
      if (cmd.testMetrics && cmd.testMetrics.total) {
        details = ` (${cmd.testMetrics.passed}/${cmd.testMetrics.total} tests passed)`;
      } else if (!cmd.passed) {
        details = ` (exit code ${cmd.exitCode})`;
      }
      report += `  ${idx + 1}. [${status}] ${cmd.label}${details} [${cmdDuration}]\n`;
    });

    if (this.diagnosticSnippet) {
      report += `\n${LABEL_DIAGNOSTIC_FAILURE_DETAILS}:\n`;
      report += `${DIVIDER_DASHED}\n`;
      report += `${this.diagnosticSnippet.toString()}\n`;
      report += `${DIVIDER_DASHED}\n`;
    }

    if (options.summaryPath) {
      report += `\n${LABEL_EXECUTION_LOG.padEnd(16)}: ${options.summaryPath}\n`;
    }

    return report.trim();
  }

  public formatStructuredTokens(): string {
    const lines: string[] = [];
    lines.push(`${TOKEN_GATE_STATUS}: ${this.verdict}`);
    lines.push(`${TOKEN_BUILD_STATUS}: ${this.buildStatus}`);

    if (this.testMetrics) {
      lines.push(this.testMetrics.toTokenString());
    }

    if (this.diagnosticSnippet) {
      if (this.diagnosticSnippet.fileLocation) {
        lines.push(`${TOKEN_FAILURE_FILE}: ${this.diagnosticSnippet.fileLocation}`);
      }
      if (this.diagnosticSnippet.failingAssertion) {
        lines.push(`${TOKEN_FAILING_ASSERTION}: ${this.diagnosticSnippet.failingAssertion}`);
      }
    }

    return lines.join('\n');
  }

  public formatSelfCorrectionPayload(): string {
    if (this.isPassed() || !this.diagnosticSnippet) {
      return '';
    }

    let payload = `${SECTION_SELF_CORRECTION_TITLE}\n`;
    payload += `The previous Quality Gate verification failed (${this.verdict}). Address these errors before proceeding:\n\n`;
    payload += `${this.diagnosticSnippet.formatForPrompt()}\n`;

    return payload.trim();
  }

  public toJSON(): GateSummaryReportSerialized {
    return {
      verdict: this.verdict,
      totalDurationMs: this.totalDurationMs,
      commands: this.commands,
      testMetrics: this.testMetrics ? this.testMetrics.toJSON() : null,
      buildStatus: this.buildStatus,
      testsStatus: this.testsStatus,
      diagnosticSnippet: this.diagnosticSnippet ? this.diagnosticSnippet.toJSON() : null,
      buildSystem: this.buildSystem,
      detectedEcosystems: this.detectedEcosystems
    };
  }

  public static create(props: GateSummaryReportProps): GateSummaryReport {
    return new GateSummaryReport(props);
  }

  public static parse(text: string | null | undefined): GateSummaryReport {
    if (!text || typeof text !== 'string') {
      throw new QualityGateSummaryParseError(String(text), 'Input text cannot be empty or non-string.');
    }

    // 1. Parse structured GATE_* tokens
    const statusMatch = text.match(REGEX_GATE_STATUS_TOKEN);
    const buildMatch = text.match(REGEX_BUILD_STATUS_TOKEN);
    const testMetrics = TestMetrics.parse(text);

    let verdict: GateVerdict | undefined;
    if (statusMatch) {
      const parsedStatus = statusMatch[1].toUpperCase();
      if (parsedStatus === STATUS_PASSED || parsedStatus === STATUS_FAILED || parsedStatus === STATUS_TIMED_OUT) {
        verdict = parsedStatus as GateVerdict;
      }
    }

    // Check textual verdict fallback: "Overall Verdict : PASSED" or "Overall Verdict: FAILED"
    if (!verdict) {
      const overallMatch = text.match(/Overall\s+Verdict\s*:\s*(PASSED|FAILED|TIMED_OUT)/i);
      if (overallMatch) {
        verdict = overallMatch[1].toUpperCase() as GateVerdict;
      }
    }

    // 2. Parse markdown table rows: | Command | Exit Code | Duration | Status |
    const commands: GateCommandSummary[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const rowMatch = line.match(REGEX_MD_TABLE_ROW);
      if (rowMatch && !line.includes('---') && !line.toLowerCase().includes('command |')) {
        const cmdName = rowMatch[1].trim();
        const exitCode = parseInt(rowMatch[2].trim(), 10);
        const durationStr = rowMatch[3].trim();
        const statusStr = rowMatch[4].trim().toUpperCase();

        const durationSeconds = parseFloat(durationStr.replace(/[^\d.]/g, '')) || 0;
        const durationMs = Math.round(durationSeconds * MS_PER_SECOND);
        const passed = statusStr === STATUS_PASSED && exitCode === 0;
        const timedOut = statusStr === STATUS_TIMED_OUT || statusStr === STATUS_DISPLAY_TIMED_OUT;

        commands.push({
          id: `cmd-${commands.length + 1}`,
          label: cmdName,
          command: cmdName,
          exitCode: isNaN(exitCode) ? (passed ? 0 : 1) : exitCode,
          durationMs,
          passed,
          timedOut
        });
      }
    }

    // If verdict is still unassigned, infer from commands or testMetrics
    if (!verdict) {
      if (commands.length > 0) {
        verdict = commands.every((c) => c.passed) ? STATUS_PASSED : STATUS_FAILED;
      } else if (testMetrics) {
        verdict = testMetrics.hasFailures() ? STATUS_FAILED : STATUS_PASSED;
      } else {
        throw new QualityGateSummaryParseError(
          text.substring(0, 200),
          'Could not determine gate verdict from structured tokens, markdown table, or metrics.'
        );
      }
    }

    // 3. Extract failure diagnostic snippet if gate failed
    let diagnosticSnippet: DiagnosticSnippet | null = null;
    if (verdict !== STATUS_PASSED) {
      const fileMatch = text.match(REGEX_FAILURE_FILE_TOKEN);
      const assertionMatch = text.match(REGEX_FAILING_ASSERTION_TOKEN);
      diagnosticSnippet = DiagnosticSnippet.extract(text);

      if (diagnosticSnippet && (fileMatch || assertionMatch)) {
        diagnosticSnippet = new DiagnosticSnippet({
          rawContent: diagnosticSnippet.rawContent,
          lines: diagnosticSnippet.lines,
          fileLocation: fileMatch ? fileMatch[1].trim() : diagnosticSnippet.fileLocation,
          failingAssertion: assertionMatch ? assertionMatch[1].trim() : diagnosticSnippet.failingAssertion,
          rootCause: diagnosticSnippet.rootCause
        });
      }
    }

    const buildStatus = buildMatch ? buildMatch[1].toUpperCase() : (verdict === STATUS_PASSED ? STATUS_PASSED : STATUS_FAILED);
    const testsStatus = testMetrics ? (testMetrics.hasFailures() ? STATUS_FAILED : STATUS_PASSED) : buildStatus;

    return new GateSummaryReport({
      verdict,
      totalDurationMs: commands.reduce((acc, c) => acc + c.durationMs, 0),
      commands,
      testMetrics,
      buildStatus,
      testsStatus,
      diagnosticSnippet
    });
  }
}
