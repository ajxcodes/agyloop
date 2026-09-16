/**
 * agyloop - ManageWorktreeUseCase (Application Layer)
 *
 * Coordinates Git worktree isolation lifecycle operations:
 * - Provisioning isolated task worktrees
 * - Teardown and cleanup upon task completion
 * - Stale worktree and lock pruning
 * - Active worktree inspection
 *
 * Strictly decoupled from direct I/O: depends only on Domain and Ports.
 */

import {
  WorktreeDescriptor,
  DEFAULT_WORKTREES_DIR,
  NOTE_WORKTREE_CREATED,
  NOTE_WORKTREE_REMOVED,
  NOTE_WORKTREE_PRUNED
} from '../domain';
import { WorktreeManagerPort } from '../ports';

export interface ProvisionWorktreeParams {
  readonly taskId: string | number;
  readonly baseBranch?: string;
  readonly title?: string | null;
  readonly slug?: string | null;
  readonly workspaceDir?: string;
  readonly worktreesDir?: string;
  readonly branchPrefix?: string;
  readonly linkNodeModules?: boolean;
}

export interface TeardownWorktreeParams {
  readonly worktreePath: string;
  readonly workspaceDir?: string;
  readonly force?: boolean;
  readonly prune?: boolean;
}

export interface PruneWorktreesParams {
  readonly workspaceDir?: string;
  readonly expire?: string;
}

export interface ListWorktreesParams {
  readonly workspaceDir?: string;
}

export interface CleanWorktreesParams {
  readonly workspaceDir?: string;
}

export interface WorktreeOperationResult<T = void> {
  readonly success: boolean;
  readonly message: string;
  readonly data?: T;
}

export class ManageWorktreeUseCase {
  private readonly worktreeManager: WorktreeManagerPort;

  constructor(worktreeManager: WorktreeManagerPort) {
    this.worktreeManager = worktreeManager;
  }

  /**
   * Provisions a dedicated, isolated git worktree for a task.
   */
  public async provision(
    params: ProvisionWorktreeParams
  ): Promise<WorktreeOperationResult<WorktreeDescriptor>> {
    const descriptor = await this.worktreeManager.createWorktree({
      taskId: params.taskId,
      baseBranch: params.baseBranch,
      title: params.title,
      slug: params.slug,
      workspaceDir: params.workspaceDir,
      worktreesDir: params.worktreesDir || DEFAULT_WORKTREES_DIR,
      branchPrefix: params.branchPrefix,
      linkNodeModules: params.linkNodeModules
    });

    return {
      success: true,
      message: `${NOTE_WORKTREE_CREATED} at ${descriptor.worktreePath} on branch ${descriptor.branch}`,
      data: descriptor
    };
  }

  /**
   * Detaches and removes a task worktree and prunes dangling metadata.
   */
  public async teardown(params: TeardownWorktreeParams): Promise<WorktreeOperationResult> {
    await this.worktreeManager.removeWorktree({
      worktreePath: params.worktreePath,
      workspaceDir: params.workspaceDir,
      force: params.force ?? true,
      prune: params.prune ?? true
    });

    return {
      success: true,
      message: `${NOTE_WORKTREE_REMOVED} at ${params.worktreePath}`
    };
  }

  /**
   * Prunes dangling worktrees and lock metadata.
   */
  public async prune(params: PruneWorktreesParams = {}): Promise<WorktreeOperationResult> {
    await this.worktreeManager.pruneWorktrees({
      workspaceDir: params.workspaceDir,
      expire: params.expire
    });

    return {
      success: true,
      message: NOTE_WORKTREE_PRUNED
    };
  }

  /**
   * Lists all active isolated worktrees registered in the repository.
   */
  public async list(
    params: ListWorktreesParams = {}
  ): Promise<WorktreeOperationResult<readonly WorktreeDescriptor[]>> {
    const worktrees = await this.worktreeManager.listWorktrees({
      workspaceDir: params.workspaceDir
    });

    return {
      success: true,
      message: `Found ${worktrees.length} active isolated worktree(s).`,
      data: worktrees
    };
  }

  /**
   * Cleans orphaned or stale worktrees/locks and returns count pruned.
   */
  public async clean(
    params: CleanWorktreesParams = {}
  ): Promise<WorktreeOperationResult<{ count: number }>> {
    const count = await this.worktreeManager.cleanOrphanedWorktrees({
      workspaceDir: params.workspaceDir
    });

    return {
      success: true,
      message: `Cleaned ${count} orphaned worktree(s) and metadata lock(s).`,
      data: { count }
    };
  }
}
