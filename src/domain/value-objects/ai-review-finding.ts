/**
 * agyloop - AiReviewFinding Value Object
 *
 * Immutable representation of an individual AI PR Review finding/comment.
 * Categorizes comments by severity (critical, error, warning, suggestion, info).
 */

import {
  ReviewSeverity,
  REVIEW_SEVERITIES,
  SEVERITY_CRITICAL,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  SEVERITY_SUGGESTION,
  SEVERITY_INFO,
  SEVERITY_ICONS
} from '../constants';
import { ValidationError } from '../errors';

export interface AiReviewFindingProps {
  readonly path: string;
  readonly line: number;
  readonly severity: ReviewSeverity | string;
  readonly body?: string;
  readonly message?: string;
  readonly rule?: string;
}

function normalizeSeverity(raw: string): ReviewSeverity {
  const lower = raw.trim().toLowerCase();
  for (const s of REVIEW_SEVERITIES) {
    if (lower === s) {
      return s;
    }
  }
  // If unrecognized, default to info or throw ValidationError
  throw new ValidationError(
    'severity',
    raw,
    `Severity must be one of: ${REVIEW_SEVERITIES.join(', ')}.`
  );
}

export class AiReviewFinding {
  public readonly path: string;
  public readonly line: number;
  public readonly severity: ReviewSeverity;
  public readonly body: string;
  public readonly message?: string;
  public readonly rule?: string;

  constructor(props: AiReviewFindingProps) {
    if (typeof props.path !== 'string' || !props.path.trim()) {
      throw new ValidationError('path', props.path, 'Finding file path must be a non-empty string.');
    }
    if (typeof props.line !== 'number' || !Number.isSafeInteger(props.line) || props.line < 0) {
      throw new ValidationError('line', props.line, 'Finding line must be a non-negative integer.');
    }

    const resolvedBody = (
      (typeof props.body === 'string' && props.body.trim()) ? props.body.trim() :
      (typeof props.message === 'string' && props.message.trim()) ? props.message.trim() :
      (typeof props.rule === 'string' && props.rule.trim()) ? props.rule.trim() :
      (props.body === undefined && props.message === undefined && props.rule === undefined ? 'Review issue' : '')
    );

    if (!resolvedBody) {
      throw new ValidationError('body', props.body, 'Finding body must be a non-empty string.');
    }

    this.path = props.path.trim();
    this.line = props.line;
    this.severity = normalizeSeverity(props.severity);
    this.body = resolvedBody;
    this.message = props.message;
    this.rule = props.rule;

    Object.freeze(this);
  }

  public isBlocking(): boolean {
    return this.severity === SEVERITY_CRITICAL || this.severity === SEVERITY_ERROR;
  }

  public isCritical(): boolean {
    return this.severity === SEVERITY_CRITICAL;
  }

  public isError(): boolean {
    return this.severity === SEVERITY_ERROR || this.severity === SEVERITY_CRITICAL;
  }

  public isWarning(): boolean {
    return this.severity === SEVERITY_WARNING;
  }

  public isSuggestion(): boolean {
    return this.severity === SEVERITY_SUGGESTION;
  }

  public isInfo(): boolean {
    return this.severity === SEVERITY_INFO;
  }

  public getIcon(): string {
    return SEVERITY_ICONS[this.severity] || SEVERITY_ICONS[SEVERITY_INFO];
  }

  public formatMarkdown(): string {
    const icon = this.getIcon();
    const lineStr = this.line > 0 ? ` (Line ${this.line})` : '';
    return `### ${icon} ${this.path}${lineStr}\n${this.body}\n`;
  }

  public equals(other: AiReviewFinding | null | undefined): boolean {
    if (!other) return false;
    return (
      this.path === other.path &&
      this.line === other.line &&
      this.severity === other.severity &&
      this.body === other.body
    );
  }

  public toJSON(): Record<string, unknown> {
    return {
      path: this.path,
      line: this.line,
      severity: this.severity,
      body: this.body
    };
  }

  public static create(props: AiReviewFindingProps): AiReviewFinding {
    return new AiReviewFinding(props);
  }

  public static tryFrom(raw: unknown): AiReviewFinding | null {
    if (!raw || typeof raw !== 'object') return null;
    if (raw instanceof AiReviewFinding) return raw;

    const candidate = raw as {
      path?: unknown;
      line?: unknown;
      severity?: unknown;
      body?: unknown;
      message?: unknown;
      rule?: unknown;
    };
    if (
      typeof candidate.path === 'string' &&
      typeof candidate.line === 'number' &&
      typeof candidate.severity === 'string' &&
      (typeof candidate.body === 'string' || typeof candidate.message === 'string' || typeof candidate.rule === 'string')
    ) {
      try {
        return new AiReviewFinding({
          path: candidate.path,
          line: candidate.line,
          severity: candidate.severity,
          body: typeof candidate.body === 'string' ? candidate.body : undefined,
          message: typeof candidate.message === 'string' ? candidate.message : undefined,
          rule: typeof candidate.rule === 'string' ? candidate.rule : undefined
        });
      } catch {
        return null;
      }
    }

    return null;
  }
}
