/**
 * agyloop - ReviewConfidence Value Object
 *
 * Immutable representation of an AI Review confidence rating and explanation.
 * Strictly avoids magic strings by using domain constants.
 */

import {
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_LOW,
  REVIEW_CONFIDENCE_LEVELS,
  ReviewConfidenceLevel
} from '../constants';
import { ValidationError } from '../errors';

function normalizeConfidenceLevel(raw: string): ReviewConfidenceLevel {
  const normalized = raw.trim().toLowerCase();
  if (normalized === CONFIDENCE_HIGH.toLowerCase()) {
    return CONFIDENCE_HIGH;
  }
  if (normalized === CONFIDENCE_MEDIUM.toLowerCase()) {
    return CONFIDENCE_MEDIUM;
  }
  if (normalized === CONFIDENCE_LOW.toLowerCase()) {
    return CONFIDENCE_LOW;
  }
  throw new ValidationError(
    'confidenceLevel',
    raw,
    `Confidence level must be one of: ${REVIEW_CONFIDENCE_LEVELS.join(', ')}.`
  );
}

export class ReviewConfidence {
  public readonly level: ReviewConfidenceLevel;
  public readonly explanation: string;

  constructor(level: string, explanation: string = '') {
    if (typeof level !== 'string' || !level.trim()) {
      throw new ValidationError('confidenceLevel', level, 'Confidence level must be a non-empty string.');
    }
    if (typeof explanation !== 'string') {
      throw new ValidationError('confidenceExplanation', explanation, 'Confidence explanation must be a string.');
    }

    this.level = normalizeConfidenceLevel(level);
    this.explanation = explanation.trim();

    Object.freeze(this);
  }

  public isHigh(): boolean {
    return this.level === CONFIDENCE_HIGH;
  }

  public isMedium(): boolean {
    return this.level === CONFIDENCE_MEDIUM;
  }

  public isLow(): boolean {
    return this.level === CONFIDENCE_LOW;
  }

  public equals(other: ReviewConfidence | null | undefined): boolean {
    if (!other) return false;
    return this.level === other.level && this.explanation === other.explanation;
  }

  public toString(): string {
    if (this.explanation) {
      return `${this.level} - ${this.explanation}`;
    }
    return this.level;
  }

  public static create(level: string, explanation: string = ''): ReviewConfidence {
    return new ReviewConfidence(level, explanation);
  }

  public static high(explanation: string = ''): ReviewConfidence {
    return new ReviewConfidence(CONFIDENCE_HIGH, explanation);
  }

  public static medium(explanation: string = ''): ReviewConfidence {
    return new ReviewConfidence(CONFIDENCE_MEDIUM, explanation);
  }

  public static low(explanation: string = ''): ReviewConfidence {
    return new ReviewConfidence(CONFIDENCE_LOW, explanation);
  }

  public static tryFrom(raw: unknown): ReviewConfidence | null {
    if (!raw) return null;
    if (raw instanceof ReviewConfidence) return raw;

    if (typeof raw === 'string') {
      try {
        return new ReviewConfidence(raw);
      } catch {
        return null;
      }
    }

    if (typeof raw === 'object' && raw !== null) {
      const candidate = raw as { level?: unknown; confidenceLevel?: unknown; explanation?: unknown; confidenceExplanation?: unknown };
      const level = candidate.level ?? candidate.confidenceLevel;
      const explanation = candidate.explanation ?? candidate.confidenceExplanation;
      if (typeof level === 'string') {
        try {
          return new ReviewConfidence(level, typeof explanation === 'string' ? explanation : '');
        } catch {
          return null;
        }
      }
    }

    return null;
  }
}
