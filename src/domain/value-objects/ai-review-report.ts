/**
 * agyloop - AiReviewReport Value Object
 *
 * Immutable representation of a complete AI PR Review report.
 * Provides structured diagnostic parsing, severity queries, and markdown formatting.
 * Pure domain value object: 100% free of external I/O or child processes.
 */

import {
  BANNER_REVIEW_TITLE,
  BANNER_SUMMARY,
  BANNER_CODE_COMMENTS,
  MSG_NO_ISSUES_FOUND,
  MSG_CLEAN_DIFF_REVIEW,
  REGEX_JSON_CODE_BLOCK
} from '../constants';
import { ValidationError, CritiqueError, AiReviewerError } from '../errors';
import { ReviewConfidence } from './review-confidence';
import { AiReviewFinding, AiReviewFindingProps } from './ai-review-finding';

export interface AiReviewReportProps {
  readonly summary: string;
  readonly confidence: ReviewConfidence;
  readonly findings: readonly AiReviewFinding[];
  readonly resolvedThreads?: readonly string[];
  readonly bypassed?: boolean;
  readonly diagnosticMessage?: string;
  readonly rawOutput?: string;
}

interface RawReviewJsonPayload {
  readonly summary?: unknown;
  readonly confidenceLevel?: unknown;
  readonly confidenceExplanation?: unknown;
  readonly resolvedThreads?: unknown;
  readonly comments?: unknown;
}

function extractJsonString(rawText: string): string {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const codeBlockMatch = trimmed.match(REGEX_JSON_CODE_BLOCK);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

export class AiReviewReport {
  public readonly summary: string;
  public readonly confidence: ReviewConfidence;
  public readonly findings: readonly AiReviewFinding[];
  public readonly resolvedThreads: readonly string[];
  public readonly bypassed: boolean;
  public readonly diagnosticMessage?: string;
  public readonly rawOutput?: string;

  constructor(props: AiReviewReportProps) {
    if (typeof props.summary !== 'string') {
      throw new ValidationError('summary', props.summary, 'Review summary must be a string.');
    }
    if (!(props.confidence instanceof ReviewConfidence)) {
      throw new ValidationError('confidence', props.confidence, 'Review confidence must be a ReviewConfidence instance.');
    }

    this.summary = props.summary.trim();
    this.confidence = props.confidence;
    this.findings = Object.freeze([...(props.findings || [])]);
    this.resolvedThreads = Object.freeze([...(props.resolvedThreads || [])]);
    this.bypassed = Boolean(props.bypassed);
    this.diagnosticMessage = props.diagnosticMessage;
    this.rawOutput = props.rawOutput;

    Object.freeze(this);
  }

  public isPassing(): boolean {
    if (this.bypassed) return false;
    return !this.hasBlockingIssues() && this.confidence.isHigh();
  }

  public hasBlockingIssues(): boolean {
    return this.findings.some((finding) => finding.isBlocking());
  }

  public hasFindings(): boolean {
    return this.findings.length > 0;
  }

  public errorCount(): number {
    return this.findings.filter((f) => f.isError()).length;
  }

  public warningCount(): number {
    return this.findings.filter((f) => f.isWarning()).length;
  }

  public suggestionCount(): number {
    return this.findings.filter((f) => f.isSuggestion()).length;
  }

  public infoCount(): number {
    return this.findings.filter((f) => f.isInfo()).length;
  }

  public formatMarkdownReport(): string {
    const sections: string[] = [
      '====================================',
      BANNER_REVIEW_TITLE,
      '====================================\n',
      `${BANNER_SUMMARY}\n${this.summary}\n`,
      `**Confidence:** ${this.confidence.toString()}\n`
    ];

    if (this.findings.length > 0) {
      sections.push(`${BANNER_CODE_COMMENTS}\n`);
      for (const finding of this.findings) {
        sections.push(finding.formatMarkdown());
      }
    } else {
      sections.push(`${BANNER_CODE_COMMENTS}\n${MSG_NO_ISSUES_FOUND}\n`);
    }

    if (this.diagnosticMessage) {
      sections.push(`\n> **Notice:** ${this.diagnosticMessage}\n`);
    }

    return sections.join('\n');
  }

  public toJSON(): Record<string, unknown> {
    return {
      summary: this.summary,
      confidenceLevel: this.confidence.level,
      confidenceExplanation: this.confidence.explanation,
      resolvedThreads: [...this.resolvedThreads],
      comments: this.findings.map((f) => f.toJSON()),
      bypassed: this.bypassed,
      diagnosticMessage: this.diagnosticMessage
    };
  }

  public static create(props: AiReviewReportProps): AiReviewReport {
    return new AiReviewReport(props);
  }

  public static empty(customMessage: string = MSG_CLEAN_DIFF_REVIEW): AiReviewReport {
    return new AiReviewReport({
      summary: customMessage,
      confidence: ReviewConfidence.high(customMessage),
      findings: [],
      resolvedThreads: [],
      bypassed: false
    });
  }

  public static bypassed(reason: string): AiReviewReport {
    return new AiReviewReport({
      summary: `AI review was bypassed: ${reason}`,
      confidence: ReviewConfidence.low(reason),
      findings: [],
      resolvedThreads: [],
      bypassed: true,
      diagnosticMessage: reason
    });
  }

  public static parse(rawText: string): AiReviewReport {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      throw new CritiqueError('parse', 'Cannot parse empty review payload.');
    }

    const candidateJson = extractJsonString(rawText);
    let parsed: RawReviewJsonPayload;

    try {
      parsed = JSON.parse(candidateJson);
    } catch (err) {
      throw new CritiqueError(
        'parse',
        `Failed to parse review JSON response: ${err instanceof Error ? err.message : String(err)}`,
        { rawSnippet: rawText.substring(0, 300) },
        err
      );
    }

    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    const confidenceLevel =
      typeof parsed.confidenceLevel === 'string' ? parsed.confidenceLevel : 'Medium';
    const confidenceExplanation =
      typeof parsed.confidenceExplanation === 'string' ? parsed.confidenceExplanation : '';

    const confidence = ReviewConfidence.create(confidenceLevel, confidenceExplanation);

    const findings: AiReviewFinding[] = [];
    if (Array.isArray(parsed.comments)) {
      for (const item of parsed.comments) {
        const finding = AiReviewFinding.tryFrom(item);
        if (finding) {
          findings.push(finding);
        }
      }
    }

    const resolvedThreads: string[] = [];
    if (Array.isArray(parsed.resolvedThreads)) {
      for (const thread of parsed.resolvedThreads) {
        if (typeof thread === 'string') {
          resolvedThreads.push(thread);
        }
      }
    }

    return new AiReviewReport({
      summary,
      confidence,
      findings,
      resolvedThreads,
      rawOutput: rawText
    });
  }
}
