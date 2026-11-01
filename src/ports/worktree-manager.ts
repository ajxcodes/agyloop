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
  /**
   * Run every guard (root refusal, containment, existence, symlink,
   * registration, prunable) and report what WOULD be removed, but perform no
   * side effect (issue #248). A missing/unregistered/symlinked target still
   * refuses — that is the point of exercising the guards on a dry run.
   *
   * Default `false`.
   */
  readonly dryRun?: boolean;
  /**
   * Resolve successfully when the directory is already gone (internal
   * teardown of a worktree that was deleted out of band). Operator commands
   * MUST leave this false: a missing target is a failure, not a success (#282).
   *
   * Default `false`.
   */
  readonly tolerateMissing?: boolean;
  /**
   * Permit a target OUTSIDE `<repo>/.worktrees` — only for a worktree
   * REGISTERED to THIS repository (internal teardown of an adopted/external
   * worktree). The operator command never opts in: an unvetted path is refused
   * before any side effect (#282).
   *
   * Default `false`.
   */
  readonly allowExternal?: boolean;
}

export interface PruneWorktreesOptions {
  readonly workspaceDir?: string;
  readonly expire?: string;
}

export interface ListWorktreesOptions {
  readonly workspaceDir?: string;
  readonly includeExternal?: boolean;
}

export interface EnsureGitIgnoreOptions {
  readonly workspaceDir?: string;
  readonly entry?: string;
}

/**
 * Outcome of a quarantine attempt (issue #266 AC-4 / AC-6).
 *
 * `quarantined === true` iff `outcome` is `'stashed'` or `'branch'`: a failed
 * `git stash` must never be counted as quarantined.
 */
export interface QuarantineWorktreeResult {
  readonly quarantined: boolean;
  /** Machine-readable cause. `quarantined === true` iff 'stashed' | 'branch'. */
  readonly outcome?: 'stashed' | 'branch' | 'clean' | 'missing' | 'failed';
  readonly branch?: string;
  readonly stashed?: boolean;
  /** e.g. 'stash@{0}' — the ONLY value `git stash pop` accepts. */
  readonly stashRef?: string;
  /** The generated message, so an operator whose index shifted can re-find it. */
  readonly stashMessage?: string;
  readonly error?: string;
}

export interface CleanOrphanedOptions {
  readonly workspaceDir?: string;
  readonly subagents?: boolean;
  readonly all?: boolean;
  /**
   * Report how many orphans WOULD be removed without pruning registrations,
   * deleting directories or removing subagent worktrees (issue #248).
   *
   * Default `false`.
   */
  readonly dryRun?: boolean;
}

export interface ListBranchesOptions {
  readonly workspaceDir?: string;
  readonly remote?: boolean;
}

export interface ProvisioningStateProbeOptions {
  readonly workspaceDir?: string;
}

/**
 * Input to the pre-write workspace guard (issue #428).
 *
 * `workspaceDir` defaults to `process.cwd()`; `issue` only shapes the refusal
 * message and may be omitted when the caller has no issue yet.
 */
export interface AssertWorkspaceProvisionableOptions {
  readonly workspaceDir?: string;
  readonly issue?: number | null;
}

/**
 * Failure-aware answer to "what existed BEFORE provisioning?" (issue #426).
 *
 * Both fields are `null` EXACTLY when the underlying read failed. `[]` is only
 * ever a successful read that found nothing — never a failure marker — because
 * the refusal teardown turns "nothing existed" into "this invocation created
 * it" and deletes. `listWorktrees()`/`listBranches()` cannot make that promise
 * (they answer `[]` on a non-zero git exit), which is why provenance does not
 * use them.
 */
export interface ProvisioningStateProbe {
  /** Registered worktree paths, external ones included. `null` = the read failed. */
  readonly worktreePaths: readonly string[] | null;
  /** Local branch names (no remotes). `null` = the read failed. */
  readonly localBranches: readonly string[] | null;
}

export interface CreateBranchOptions {
  readonly branchName: string;
  readonly startPoint: string;
  readonly workspaceDir?: string;
}

export interface DeleteBranchOptions {
  readonly branchName: string;
  readonly workspaceDir?: string;
}

export interface GetCommitsOptions {
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly workspaceDir?: string;
}

export interface IsAncestorOptions {
  readonly ancestorBranch: string;
  readonly descendantBranch: string;
  readonly workspaceDir?: string;
}

export interface PushBranchOptions {
  readonly branchName: string;
  readonly remote?: string;
  readonly workspaceDir?: string;
  readonly setUpstream?: boolean;
}

export interface WorktreeManagerPort {
  /**
   * Resolves the worktree path for a task ID inside `<repo>/.worktrees`.
   *
   * `taskId` is a SINGLE PATH SEGMENT matching `[A-Za-z0-9._-]+`, and never
   * `.`, `..` or a leading `-`. Absolute paths, separators and anything else
   * that could escape the container are REJECTED (issue #282) instead of being
   * joined: `path.resolve(root, '.worktrees', absoluteTarget)` would otherwise
   * discard the base and hand back the caller's arbitrary path.
   *
   * `worktreesDir` is repository-relative (default `.worktrees`); an absolute
   * value is rejected.
   */
  resolveTaskWorktreePath(
    workspaceDir: string,
    taskId: string | number,
    worktreesDir?: string
  ): Promise<string>;

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
   *
   * A non-zero `git` exit is reported as `[]`, so a failed read is
   * indistinguishable from an empty registry here. Provenance MUST NOT be read
   * from this method — use `probeProvisioningState` (issue #426).
   */
  listWorktrees(options?: ListWorktreesOptions): Promise<readonly WorktreeDescriptor[]>;

  /**
   * Cleans orphaned or stale worktrees/locks and returns count pruned.
   */
  cleanOrphanedWorktrees(options?: CleanOrphanedOptions): Promise<number>;

  /**
   * Stashes or quarantines dirty changes in a worktree to prevent data loss.
   *
   * The result carries the RECOVERY REFERENCE (issue #266 AC-4): an operator
   * whose abort relocated their work must be told how to get it back. Before
   * the fix the manager returned a bare `quarantined: true` and a failed
   * `git stash` was reported as success (AC-6).
   */
  quarantineWorktree?(options: {
    worktreePath: string;
    taskId?: string | number;
    quarantineBranch?: boolean;
    workspaceDir?: string;
  }): Promise<QuarantineWorktreeResult>;

  /**
   * Resolves the PRIMARY repository root (the main worktree) that owns
   * `workspaceDir` — the root whose `.agyloop` holds the operator's
   * checkpoints. Optional: adapters that cannot probe git may omit it, and the
   * CLI falls back to the configured workspace.
   */
  resolveRepositoryRoot?(workspaceDir?: string): Promise<string>;

  /**
   * Clears stale .git/index.lock if present.
   */
  clearIndexLock?(workspaceDir?: string): Promise<boolean>;

  /**
   * Lists local and optionally remote branches in the repository.
   *
   * A non-zero `git` exit is reported as `[]`, so a failed read is
   * indistinguishable from an empty list here. Provenance MUST NOT be read from
   * this method — use `probeProvisioningState` (issue #426).
   */
  listBranches?(options?: ListBranchesOptions): Promise<readonly string[]>;

  /**
   * Pre-provisioning provenance probe (issue #426).
   *
   * Optional: an adapter that cannot answer truthfully omits it, and the
   * refusal teardown then removes nothing and says so instead of guessing.
   * `null` means the read failed; `[]` means a successful read found nothing.
   */
  probeProvisioningState?(options?: ProvisioningStateProbeOptions): Promise<ProvisioningStateProbe>;

  /**
   * Refuses a workspace that cannot host a worktree, before any state is
   * written (issue #428).
   *
   * The guard judges the workspace the OPERATOR named (`workspaceDir`, else
   * the cwd) and writes nothing: it only probes git and throws the same
   * `WorktreeCreationError('createWorktree', …)` that `createWorktree` throws.
   * `RunLifecycleUseCase` calls it before the first checkpoint save, so a
   * refusal's "Nothing was written." is measured rather than asserted.
   *
   * Optional: an adapter that cannot probe git omits it, and the lifecycle
   * then keeps its previous ordering (the refusal happens in `createWorktree`).
   */
  assertWorkspaceProvisionable?(options?: AssertWorkspaceProvisionableOptions): Promise<void>;

  /**
   * Creates a branch from a specified start point.
   */
  createBranch?(options: CreateBranchOptions): Promise<void>;

  /**
   * Deletes a local branch (issue #420).
   *
   * The CALLER owns provenance: it must prove the branch was created by the
   * operation being undone, because a deletion is not recoverable from here.
   * The adapter independently refuses a blank name and any branch currently
   * checked out in a worktree (including the root), so the base branch and a
   * descriptor-held branch can never be deleted through this call.
   *
   * Optional: adapters that cannot delete branches omit it, and the caller
   * must then leave the branch alone instead of assuming it was removed.
   */
  deleteBranch?(options: DeleteBranchOptions): Promise<void>;

  /**
   * Returns commit messages between two branches (baseBranch..headBranch).
   */
  getCommitsBetween?(options: GetCommitsOptions): Promise<readonly string[]>;

  /**
   * Checks whether ancestorBranch has been merged into descendantBranch.
   */
  isAncestor?(options: IsAncestorOptions): Promise<boolean>;

  /**
   * Pushes a local branch to remote repository (typically best-effort for collector branches).
   */
  pushBranch?(options: PushBranchOptions): Promise<boolean>;
}
