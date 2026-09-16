/**
 * agyloop - WorktreeDescriptor Value Object (Domain Layer)
 *
 * Immutable, self-validating value object representing an isolated git worktree session.
 * Pure domain value object: zero external dependencies, zero direct I/O.
 */

import { ValidationError } from '../errors';
import { DEFAULT_WORKTREES_DIR, DEFAULT_TASK_BRANCH_PREFIX } from '../constants';

export interface WorktreeDescriptorProps {
  readonly taskId: string | number;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly slug?: string;
  readonly isIsolated?: boolean;
}

export class WorktreeDescriptor {
  public readonly taskId: string;
  public readonly worktreePath: string;
  public readonly branch: string;
  public readonly baseBranch: string;
  public readonly slug: string;
  public readonly isIsolated: boolean;

  constructor(props: WorktreeDescriptorProps) {
    if (!props.taskId && props.taskId !== 0) {
      throw new ValidationError('taskId', props.taskId, 'Worktree taskId must not be empty.');
    }
    const cleanTaskId = String(props.taskId).trim();
    if (!cleanTaskId) {
      throw new ValidationError('taskId', props.taskId, 'Worktree taskId must not be blank.');
    }

    const cleanPath = (props.worktreePath || '').trim();
    if (!cleanPath) {
      throw new ValidationError('worktreePath', props.worktreePath, 'Worktree path must not be blank.');
    }

    const cleanBranch = (props.branch || '').trim();
    if (!cleanBranch) {
      throw new ValidationError('branch', props.branch, 'Worktree branch must not be blank.');
    }

    const cleanBase = (props.baseBranch || '').trim();
    if (!cleanBase) {
      throw new ValidationError('baseBranch', props.baseBranch, 'Worktree baseBranch must not be blank.');
    }

    this.taskId = cleanTaskId;
    this.worktreePath = cleanPath;
    this.branch = cleanBranch;
    this.baseBranch = cleanBase;
    this.slug = props.slug !== undefined ? props.slug.trim() : WorktreeDescriptor.extractSlugFromBranch(cleanBranch, cleanTaskId);
    this.isIsolated = props.isIsolated ?? true;

    Object.freeze(this);
  }

  /**
   * Generates a clean URL/branch-safe kebab-case slug from arbitrary title string.
   */
  public static slugify(text: string): string {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, '') // remove bracketed tags like [Feature]
      .replace(/[^a-z0-9]+/g, '-') // convert non-alphanumeric chars to hyphens
      .replace(/^-+|-+$/g, '') // strip leading and trailing hyphens
      .replace(/-+/g, '-'); // collapse multiple hyphens
  }

  /**
   * Formats deterministic task branch name: task/<task-id>-<slug> or task/<task-id>
   */
  public static formatBranchName(
    taskId: string | number,
    slug?: string,
    prefix: string = DEFAULT_TASK_BRANCH_PREFIX
  ): string {
    const cleanId = String(taskId).trim();
    const cleanSlug = slug ? WorktreeDescriptor.slugify(slug) : '';
    const branchSuffix = cleanSlug ? `${cleanId}-${cleanSlug}` : cleanId;
    return `${prefix}${branchSuffix}`;
  }

  /**
   * Formats standard worktree relative directory path: .worktrees/<task-id>
   */
  public static formatWorktreePath(
    taskId: string | number,
    baseDir: string = DEFAULT_WORKTREES_DIR
  ): string {
    const cleanId = String(taskId).trim();
    const cleanDir = baseDir.replace(/\/+$/, '');
    return `${cleanDir}/${cleanId}`;
  }

  private static extractSlugFromBranch(branch: string, taskId: string): string {
    const cleanBranch = branch.replace(/^.*task\//, '');
    const prefix = `${taskId}-`;
    if (cleanBranch.startsWith(prefix)) {
      return cleanBranch.substring(prefix.length);
    }
    return cleanBranch === taskId ? '' : cleanBranch;
  }

  public equals(other: WorktreeDescriptor | null | undefined): boolean {
    if (!other) return false;
    return (
      this.taskId === other.taskId &&
      this.worktreePath === other.worktreePath &&
      this.branch === other.branch &&
      this.baseBranch === other.baseBranch
    );
  }

  public toJSON(): Record<string, unknown> {
    return {
      taskId: this.taskId,
      worktreePath: this.worktreePath,
      branch: this.branch,
      baseBranch: this.baseBranch,
      slug: this.slug,
      isIsolated: this.isIsolated
    };
  }
}
