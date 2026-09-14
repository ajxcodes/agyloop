/**
 * agyloop - ReviewVerdict Value Object
 *
 * Immutable, self-validating value object representing the outcome of the AI Review stage.
 * Emits and parses machine-readable REVIEW_* tokens, Markdown self-correction context,
 * and bridges AI PR review reports to the orchestrator lifecycle.
 *
 * Pure domain value object: 100% free of filesystem, child processes, or network I/O.
 */

import {
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  ReviewVerdictState,
  TOKEN_REVIEW_STATUS,
  TOKEN_REVIEW_SUMMARY,
  TOKEN_UNFULFILLED_AC,
  TOKEN_REMEDIATION_GUIDANCE,
  HEADER_REVIEW_VERDICT_REPORT,
  LABEL_REVIEW_STATUS,
  LABEL_REVIEW_SUMMARY,
  LABEL_UNFULFILLED_AC,
  LABEL_REMEDIATION_GUIDANCE,
  SECTION_REVIEW_SELF_CORRECTION_TITLE,
  REGEX_REVIEW_STATUS_TOKEN,
  REGEX_REVIEW_SUMMARY_TOKEN,
  REGEX_UNFULFILLED_AC_TOKEN,
  REGEX_REMEDIATION_GUIDANCE_TOKEN
} from '../constants';
import { ReviewerSubagentError, ValidationError } from '../errors';
import { AiReviewReport } from './ai-review-report';
import { AiReviewFinding } from './ai-review-finding';

export interface ReviewVerdictProps {
  readonly status: ReviewVerdictState;
  readonly summary: string;
  readonly unfulfilledCriteria?: readonly string[];
  readonly remediationGuidance?: readonly string[];
  readonly confidenceLevel?: string | null;
  readonly findings?: readonly AiReviewFinding[];
}

export interface ReviewVerdictSerialized {
  readonly status: ReviewVerdictState;
  readonly summary: string;
  readonly unfulfilledCriteria: readonly string[];
  readonly remediationGuidance: readonly string[];
  readonly confidenceLevel: string | null;
  readonly findingsCount: number;
}

function isNoneOrEmpty(value: string | undefined | null): boolean {
  if (!value) return true;
  const trimmed = value.trim().toLowerCase();
  return (
    trimmed === '' ||
    trimmed === 'none' ||
    trimmed === 'none.' ||
    trimmed === 'n/a' ||
    trimmed === 'nil' ||
    trimmed === 'no unfulfilled criteria'
  );
}

function cleanBulletItem(rawLine: string): string {
  return rawLine
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .trim();
}

export class ReviewVerdict {
  public readonly status: ReviewVerdictState;
  public readonly summary: string;
  public readonly unfulfilledCriteria: readonly string[];
  public readonly remediationGuidance: readonly string[];
  public readonly confidenceLevel: string | null;
  public readonly findings: readonly AiReviewFinding[];

  constructor(props: ReviewVerdictProps) {
    if (!props || typeof props !== 'object') {
      throw new ValidationError('props', props, 'ReviewVerdict props must be an object.');
    }

    if (props.status !== VERDICT_APPROVED && props.status !== VERDICT_CHANGES_REQUESTED) {
      throw new ValidationError(
        'status',
        props.status,
        `Invalid review verdict status '${props.status}'. Must be '${VERDICT_APPROVED}' or '${VERDICT_CHANGES_REQUESTED}'.`
      );
    }

    if (typeof props.summary !== 'string' || props.summary.trim().length === 0) {
      throw new ValidationError('summary', props.summary, 'Review summary must be a non-empty string.');
    }

    this.status = props.status;
    this.summary = props.summary.trim();

    const criteria = (props.unfulfilledCriteria || [])
      .map((c) => (typeof c === 'string' ? cleanBulletItem(c) : ''))
      .filter((c) => !isNoneOrEmpty(c));
    this.unfulfilledCriteria = Object.freeze(criteria);

    const remediation = (props.remediationGuidance || [])
      .map((r) => (typeof r === 'string' ? cleanBulletItem(r) : ''))
      .filter((r) => !isNoneOrEmpty(r));
    this.remediationGuidance = Object.freeze(remediation);

    this.confidenceLevel = props.confidenceLevel ?? null;
    this.findings = props.findings ? Object.freeze([...props.findings]) : Object.freeze([]);

    Object.freeze(this);
  }

  public isApproved(): boolean {
    return this.status === VERDICT_APPROVED;
  }

  public isChangesRequested(): boolean {
    return this.status === VERDICT_CHANGES_REQUESTED;
  }

  public formatStructuredTokens(): string {
    const lines: string[] = [
      `${TOKEN_REVIEW_STATUS}: ${this.status}`,
      `${TOKEN_REVIEW_SUMMARY}: ${this.summary}`
    ];

    lines.push(`${TOKEN_UNFULFILLED_AC}:`);
    if (this.unfulfilledCriteria.length === 0) {
      lines.push('- None');
    } else {
      for (const item of this.unfulfilledCriteria) {
        lines.push(`- ${item}`);
      }
    }

    lines.push(`${TOKEN_REMEDIATION_GUIDANCE}:`);
    if (this.remediationGuidance.length === 0) {
      lines.push('- None');
    } else {
      for (const item of this.remediationGuidance) {
        lines.push(`- ${item}`);
      }
    }

    return lines.join('\n');
  }

  public formatReportText(): string {
    let report = `${HEADER_REVIEW_VERDICT_REPORT}\n`;
    report += `${LABEL_REVIEW_STATUS.padEnd(20)}: ${this.status}\n`;
    report += `${LABEL_REVIEW_SUMMARY.padEnd(20)}: ${this.summary}\n`;

    if (this.confidenceLevel) {
      report += `Confidence Level    : ${this.confidenceLevel}\n`;
    }

    if (this.unfulfilledCriteria.length > 0) {
      report += `\n${LABEL_UNFULFILLED_AC}:\n`;
      for (const item of this.unfulfilledCriteria) {
        report += `  • ${item}\n`;
      }
    }

    if (this.remediationGuidance.length > 0) {
      report += `\n${LABEL_REMEDIATION_GUIDANCE}:\n`;
      for (const item of this.remediationGuidance) {
        report += `  • ${item}\n`;
      }
    }

    return report.trim();
  }

  public formatSelfCorrectionPayload(): string {
    if (this.isApproved()) {
      return '';
    }

    let payload = `${SECTION_REVIEW_SELF_CORRECTION_TITLE}\n`;
    payload += `The previous AI Review requested changes. Address these items before continuing:\n\n`;
    payload += `**Review Summary**: ${this.summary}\n\n`;

    if (this.unfulfilledCriteria.length > 0) {
      payload += `**Unfulfilled Acceptance Criteria**:\n`;
      for (const ac of this.unfulfilledCriteria) {
        payload += `- ${ac}\n`;
      }
      payload += `\n`;
    }

    if (this.remediationGuidance.length > 0) {
      payload += `**Required Remediation Actions**:\n`;
      for (const guide of this.remediationGuidance) {
        payload += `- ${guide}\n`;
      }
      payload += `\n`;
    }

    return payload.trim();
  }

  public toJSON(): ReviewVerdictSerialized {
    return {
      status: this.status,
      summary: this.summary,
      unfulfilledCriteria: this.unfulfilledCriteria,
      remediationGuidance: this.remediationGuidance,
      confidenceLevel: this.confidenceLevel,
      findingsCount: this.findings.length
    };
  }

  public static create(props: ReviewVerdictProps): ReviewVerdict {
    return new ReviewVerdict(props);
  }

  public static parse(text: string | null | undefined): ReviewVerdict {
    if (!text || typeof text !== 'string') {
      throw new ReviewerSubagentError(
        'parse',
        'Review subagent output cannot be empty or non-string.'
      );
    }

    // 1. Extract status token
    let status: ReviewVerdictState | undefined;
    const statusMatch = text.match(REGEX_REVIEW_STATUS_TOKEN);
    if (statusMatch) {
      const parsed = statusMatch[1].toUpperCase() as ReviewVerdictState;
      if (parsed === VERDICT_APPROVED || parsed === VERDICT_CHANGES_REQUESTED) {
        status = parsed;
      }
    }

    if (!status) {
      // Check fallback textual patterns
      const fallbackMatch = text.match(/(?:Review\s+Status|Verdict|Status)\s*:\s*(APPROVED|CHANGES_REQUESTED)/i);
      if (fallbackMatch) {
        status = fallbackMatch[1].toUpperCase() as ReviewVerdictState;
      }
    }

    if (!status) {
      throw new ReviewerSubagentError(
        'parse',
        `Could not determine review verdict status from output. Expected '${TOKEN_REVIEW_STATUS}: ${VERDICT_APPROVED}' or '${TOKEN_REVIEW_STATUS}: ${VERDICT_CHANGES_REQUESTED}'.`,
        { rawSnippet: text.substring(0, 300) }
      );
    }

    // 2. Extract summary
    let summary = '';
    const summaryMatch = text.match(REGEX_REVIEW_SUMMARY_TOKEN);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    } else {
      const fallbackSummary = text.match(/(?:Summary|Review\s+Summary)\s*:\s*(.+)$/im);
      if (fallbackSummary) {
        summary = fallbackSummary[1].trim();
      } else {
        summary = status === VERDICT_APPROVED
          ? 'Review passed: All standards and acceptance criteria met.'
          : 'Review requested changes: Unfulfilled criteria or defects detected.';
      }
    }

    // 3. Extract unfulfilled criteria and remediation guidance list blocks
    const lines = text.split('\n');
    const unfulfilledCriteria: string[] = [];
    const remediationGuidance: string[] = [];

    type CaptureMode = 'none' | 'unfulfilled' | 'remediation';
    let mode: CaptureMode = 'none';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.match(/^UNFULFILLED_AC:/i) || line.match(/^Unfulfilled\s+(?:Acceptance\s+)?Criteria:/i)) {
        mode = 'unfulfilled';
        const inline = line.replace(/^[^:]+:\s*/, '').trim();
        if (inline && !isNoneOrEmpty(inline)) {
          unfulfilledCriteria.push(cleanBulletItem(inline));
        }
        continue;
      }

      if (line.match(/^REMEDIATION_GUIDANCE:/i) || line.match(/^Remediation\s+(?:Guidance|Actions):/i)) {
        mode = 'remediation';
        const inline = line.replace(/^[^:]+:\s*/, '').trim();
        if (inline && !isNoneOrEmpty(inline)) {
          remediationGuidance.push(cleanBulletItem(inline));
        }
        continue;
      }

      // Check if entering a new section or header
      if (line.match(/^[A-Z_]+:\s*/) || line.startsWith('#') || line.startsWith('===')) {
        mode = 'none';
        continue;
      }

      if (mode === 'unfulfilled') {
        if (line.startsWith('-') || line.startsWith('*') || line.match(/^\d+\./)) {
          const item = cleanBulletItem(line);
          if (!isNoneOrEmpty(item)) {
            unfulfilledCriteria.push(item);
          }
        }
      } else if (mode === 'remediation') {
        if (line.startsWith('-') || line.startsWith('*') || line.match(/^\d+\./)) {
          const item = cleanBulletItem(line);
          if (!isNoneOrEmpty(item)) {
            remediationGuidance.push(item);
          }
        }
      }
    }

    return new ReviewVerdict({
      status,
      summary,
      unfulfilledCriteria,
      remediationGuidance
    });
  }

  public static fromAiReviewReport(report: AiReviewReport): ReviewVerdict {
    if (!report || !(report instanceof AiReviewReport)) {
      throw new ValidationError('report', report, 'Valid AiReviewReport instance required.');
    }

    const passing = report.isPassing();
    const status = passing ? VERDICT_APPROVED : VERDICT_CHANGES_REQUESTED;

    const unfulfilledCriteria: string[] = [];
    const remediationGuidance: string[] = [];

    const blockingFindings = report.findings.filter((f) => f.isBlocking());
    for (const finding of blockingFindings) {
      unfulfilledCriteria.push(`[${finding.path}:${finding.line}] ${finding.body}`);
      remediationGuidance.push(`Fix [${finding.path}:${finding.line}]: Address ${finding.severity} finding`);
    }

    return new ReviewVerdict({
      status,
      summary: report.summary || (passing ? 'All review standards and checks passed.' : 'Review identified blocking issues.'),
      unfulfilledCriteria,
      remediationGuidance,
      confidenceLevel: report.confidence ? report.confidence.level : null,
      findings: report.findings
    });
  }
}
