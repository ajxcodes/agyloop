/**
 * agyloop - WorktreeManager Port Interface (Ports Layer)
 *
 * Inversion of control contract for git worktree provisioning, isolation,
 * and automated lifecycle teardown.
 *
 * Strictly adheres to Hexagonal Architecture: zero direct I/O, depends only on Domain.
 */

import { WorktreeDescriptor } from '../domain';

export interface CreateWorktreeOptions {
  readonly taskId: string | number;
  readonly baseBranch?: string;
  readonly title?: string | null;
  readonly slug?: string | null;
  readonly workspaceDir?: string;
  readonly worktreesDir?: string;
  readonly branchPrefix?: string;
  readonly linkNodeModules?: boolean;
}

export interface RemoveWorktreeOptions {
  readonly worktreePath: string;
  readonly workspaceDir?: string;
  readonly force?: boolean;
  readonly prune?: boolean;
}

export interface PruneWorktreesOptions {
  readonly workspaceDir?: string;
  readonly expire?: string;
}

export interface ListWorktreesOptions {
  readonly workspaceDir?: string;
}

export interface EnsureGitIgnoreOptions {
  readonly workspaceDir?: string;
  readonly entry?: string;
}

export interface CleanOrphanedOptions {
  readonly workspaceDir?: string;
}

export interface WorktreeManagerPort {
  /**
   * Resolves the relative or absolute worktree path for a given task ID.
   */
  resolveTaskWorktreePath(
    workspaceDir: string,
    taskId: string | number,
    worktreesDir?: string
  ): string;

  /**
   * Resolves the deterministic branch name for a given task ID and slug/title.
   */
  resolveTaskBranchName(
    taskId: string | number,
    slug?: string | null,
    prefix?: string
  ): string;

  /**
   * Ensures that .worktrees/ is present in .gitignore of the repository.
   * Appends it if missing and returns true if modified.
   */
  ensureGitIgnore(options?: EnsureGitIgnoreOptions): Promise<boolean>;

  /**
   * Inspects the base branch (current checked-out branch or fallback) of the workspace.
   */
  resolveBaseBranch(workspaceDir?: string): Promise<string>;

  /**
   * Creates an isolated worktree under .worktrees/<task-id> on a dedicated branch.
   * Auto-adds .worktrees/ to .gitignore and optionally symlinks root dependencies if present.
   */
  createWorktree(options: CreateWorktreeOptions): Promise<WorktreeDescriptor>;

  /**
   * Detaches and removes an isolated worktree directory and prunes dangling metadata.
   */
  removeWorktree(options: RemoveWorktreeOptions): Promise<void>;

  /**
   * Prunes dangling worktree metadata and orphaned locks via git worktree prune.
   */
  pruneWorktrees(options?: PruneWorktreesOptions): Promise<void>;

  /**
   * Lists active git worktrees registered with the repository.
   */
  listWorktrees(options?: ListWorktreesOptions): Promise<readonly WorktreeDescriptor[]>;

  /**
   * Cleans orphaned or stale worktrees/locks and returns count pruned.
   */
  cleanOrphanedWorktrees(options?: CleanOrphanedOptions): Promise<number>;
}
