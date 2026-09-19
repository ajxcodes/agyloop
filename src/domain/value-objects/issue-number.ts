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

  /**
   * Infers an issue number from a worktree path.
   * e.g., '.worktrees/45' or '/repo/.worktrees/45/src' -> 45
   */
  public static inferFromPath(pathStr?: string | null): number | null {
    if (!pathStr) return null;
    const match = pathStr.match(/\.worktrees[/\\](\d+)(?:[/\\]|$)/);
    if (match && match[1]) {
      const num = parseInt(match[1], 10);
      if (Number.isSafeInteger(num) && num > 0) {
        return num;
      }
    }
    return null;
  }

  /**
   * Infers an issue number from a task or fix git branch name.
   * e.g., 'task/45', 'fix/45', 'task/45-something' -> 45
   */
  public static inferFromBranch(branchStr?: string | null): number | null {
    if (!branchStr) return null;
    const match = branchStr.match(/(?:^|[/\\])(?:task|fix)\/(\d+)(?:[-_/]|$)/i);
    if (match && match[1]) {
      const num = parseInt(match[1], 10);
      if (Number.isSafeInteger(num) && num > 0) {
        return num;
      }
    }
    return null;
  }

  /**
   * Infers an issue number from available environment context (worktreePath, cwd, branch).
   */
  public static inferFromContext(context?: {
    worktreePath?: string | null;
    cwd?: string | null;
    branch?: string | null;
  }): number | null {
    if (!context) return null;
    const fromWorktree = IssueNumber.inferFromPath(context.worktreePath);
    if (fromWorktree !== null) return fromWorktree;

    const fromCwd = IssueNumber.inferFromPath(context.cwd);
    if (fromCwd !== null) return fromCwd;

    const fromBranch = IssueNumber.inferFromBranch(context.branch);
    if (fromBranch !== null) return fromBranch;

    return null;
  }
}

