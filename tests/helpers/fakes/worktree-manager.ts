/**
 * codeloop - ONE canonical WorktreeManagerPort double (issue #544 / AC2)
 *
 * Retires `WorktreeManagerDouble` / `WorktreeManagerDouble` /
 * `WorktreeManagerDouble`. Recording is always on (`createWorktreeCallCount`
 * plus `calls`), and the descriptor the use-case consumes is produced by the
 * domain `WorktreeDescriptor.create` like the local copies did.
 */

import type { WorktreeManagerPort } from '../../../src/ports';

const { WorktreeDescriptor } = require('../../../dist/domain');

interface FakeWorktreeManagerOptions {
  /** `resolveBaseBranch` result. Default 'main'. */
  baseBranch?: string;
  /** `listBranches` result (issue-branch detection fixtures). */
  branches?: readonly string[];
  /** When truthy, createWorktree THROWS (worktree-refusal fixtures). */
  provokeWorktreeFailure?: Error;
  /** `probeProvisioningState` body (issue #426 fixtures). */
  provisioningState?: unknown;
  /** `resolveRepositoryRoot` body when the suite pins the root. */
  repositoryRoot?: string;
  /** `listWorktrees` body; default empty. */
  worktrees?: readonly unknown[];
}

class FakeWorktreeManager implements WorktreeManagerPort {
  public calls: Record<string, unknown[]> = {
    resolveTaskWorktreePath: [],
    resolveTaskBranchName: [],
    ensureGitIgnore: [],
    resolveBaseBranch: [],
    createWorktree: [],
    removeWorktree: [],
    pruneWorktrees: [],
    listWorktrees: [],
    cleanOrphanedWorktrees: [],
    quarantineWorktree: []
  };

  /** Counts real provisioning attempts so "no worktree was created" is observable. */
  public createWorktreeCallCount = 0;
  public removedWorktrees: Array<Record<string, unknown>> = [];
  public baseBranch: string;
  public branches: readonly string[];
  public provokeWorktreeFailure?: Error;
  public provisioningState: unknown;
  public repositoryRoot?: string;
  public worktrees: readonly unknown[];

  constructor(options: FakeWorktreeManagerOptions = {}) {
    this.baseBranch = options.baseBranch ?? 'main';
    this.branches = options.branches ?? [];
    this.provokeWorktreeFailure = options.provokeWorktreeFailure;
    this.provisioningState = options.provisioningState;
    this.repositoryRoot = options.repositoryRoot;
    this.worktrees = options.worktrees ?? [];
  }

  public async resolveTaskWorktreePath(_workspaceDir: string, taskId: string | number): Promise<string> {
    this.calls.resolveTaskWorktreePath.push([_workspaceDir, taskId]);
    return `/mock/workspace/.worktrees/${String(taskId)}`;
  }

  public resolveTaskBranchName(taskId: string | number, slug?: string | null, prefix?: string): string {
    this.calls.resolveTaskBranchName.push([taskId, slug, prefix]);
    return `${prefix ?? 'task'}/${String(taskId)}`;
  }

  public async ensureGitIgnore(): Promise<boolean> {
    this.calls.ensureGitIgnore.push([]);
    return true;
  }

  public async resolveBaseBranch(_workspaceDir?: string): Promise<string> {
    this.calls.resolveBaseBranch.push([_workspaceDir]);
    return this.baseBranch;
  }

  public async createWorktree(params: never): Promise<never> {
    this.calls.createWorktree.push([params]);
    if (this.provokeWorktreeFailure) {
      throw this.provokeWorktreeFailure;
    }
    this.createWorktreeCallCount++;
    const opt = params as Record<string, unknown>;
    const id = String(opt.taskId ?? 999);
    return WorktreeDescriptor.create({
      taskId: id,
      worktreePath: `/mock/workspace/.worktrees/${id}`,
      branch: `${opt.branchPrefix ?? 'task'}/${id}`,
      baseBranch: (opt.baseBranch as string) ?? 'main'
    }) as never;
  }

  public async removeWorktree(options: never): Promise<void> {
    this.calls.removeWorktree.push([options]);
    this.removedWorktrees.push(options as Record<string, unknown>);
  }

  public async pruneWorktrees(_options?: never): Promise<void> {
    this.calls.pruneWorktrees.push([_options]);
  }

  public async listWorktrees(_options?: never): Promise<never> {
    this.calls.listWorktrees.push([_options]);
    return this.worktrees as never;
  }

  public async cleanOrphanedWorktrees(_options?: never): Promise<number> {
    this.calls.cleanOrphanedWorktrees.push([_options]);
    return 0;
  }

  public async quarantineWorktree(options: never) {
    this.calls.quarantineWorktree.push([options]);
    return { quarantined: false, outcome: 'clean' } as never;
  }

  public async resolveRepositoryRoot(workspaceDir?: string): Promise<never> {
    if (this.repositoryRoot !== undefined) return this.repositoryRoot as never;
    return ((workspaceDir ?? '/mock/workspace').replace(/\/repo$/, '')) as never;
  }

  public async listBranches(_options?: never): Promise<never> {
    return this.branches as never;
  }

  public async probeProvisioningState(_options?: never): Promise<never> {
    return ((this.provisioningState ?? null) as unknown) as never;
  }
}

function createFakeWorktreeManager(options?: FakeWorktreeManagerOptions): FakeWorktreeManager {
  return new FakeWorktreeManager(options ?? {});
}

module.exports = { FakeWorktreeManager, createFakeWorktreeManager };
