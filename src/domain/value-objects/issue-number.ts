/**
 * agyloop - IssueNumber Value Object
 *
 * Self-validating value object enforcing positive integers for GitHub issue numbers.
 */

import { ValidationError } from '../errors';

export class IssueNumber {
  public readonly value: number;

  constructor(raw: number | string) {
    let parsed: number;

    if (typeof raw === 'number') {
      parsed = raw;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new ValidationError('issueNumber', raw, 'Issue number must contain only digits.');
      }
      parsed = parseInt(trimmed, 10);
    } else {
      throw new ValidationError('issueNumber', raw, 'Issue number must be a number or numeric string.');
    }

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new ValidationError(
        'issueNumber',
        raw,
        'Issue number must be a positive integer greater than zero.'
      );
    }

    this.value = parsed;
    Object.freeze(this);
  }

  public equals(other: IssueNumber | null | undefined): boolean {
    if (!other) return false;
    return this.value === other.value;
  }

  public toString(): string {
    return this.value.toString();
  }

  public static from(value: number | string): IssueNumber {
    return new IssueNumber(value);
  }

  public static tryFrom(value: number | string | null | undefined): IssueNumber | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    try {
      return new IssueNumber(value);
    } catch {
      return null;
    }
  }
}
