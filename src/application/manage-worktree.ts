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
  NOTE_WORKTREE_PRUNED,
  NOTE_WORKTREE_CHECKPOINT_CLEARED,
  NOTE_WORKTREE_CHECKPOINT_CLEARED_SCOPE,
  NOTE_WORKTREE_CHECKPOINT_UNCHANGED,
  NOTE_WORKTREE_CHECKPOINT_UNREADABLE,
  NOTE_WORKTREE_STALE_PRUNED,
  NOTE_WORKTREE_STALE_ABSENT,
  StateMachine,
  StateMachineSnapshot,
  isSamePath
} from '../domain';
import { StateRepository, WorktreeManagerPort } from '../ports';

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
  /** The operator's raw target (task id or token); metadata only. */
  readonly taskId?: string | number;
  /** Descriptor scope: which task checkpoint may be cleared by this removal. */
  readonly issue?: number | string | null;
  /** Forwarded to the manager: internal teardown of an already-gone worktree. */
  readonly tolerateMissing?: boolean;
  /** Forwarded to the manager: a registered worktree outside `.worktrees`. */
  readonly allowExternal?: boolean;
  /** Simulate: run every guard, change nothing (#248). */
  readonly dryRun?: boolean;
}

/** What the removal did to the checkpoint descriptor (issue #282, absorbed #273). */
export type WorktreeDescriptorStatus = 'cleared' | 'not-found' | 'unavailable' | 'corrupt';

export interface TeardownWorktreeData {
  readonly descriptorCleared: boolean;
  readonly descriptorStatus: WorktreeDescriptorStatus;
  /**
   * Every checkpoint file whose descriptor named the removed path and was
   * cleared, in the order the candidates were scanned. Reported instead of a
   * single boolean so the command can never claim more than it did: a legacy
   * layout can carry the SAME descriptor in `.agyloop/state.json` AND
   * `.agyloop/tasks/<id>.json`, and both must be cleared (review iteration 2).
   */
  readonly clearedCheckpoints: readonly string[];
  /** True when this was a simulation: the descriptor is unchanged (#248). */
  readonly wouldClear?: boolean;
}

/** A repair request for a descriptor whose worktree directory is already gone (#282). */
export interface ClearStaleDescriptorParams {
  readonly worktreePath: string;
  /** Descriptor scope: which task checkpoint may be repaired. */
  readonly issue?: number | string | null;
  /** Simulate the repair without saving any checkpoint (#248). */
  readonly dryRun?: boolean;
}

/** Internal result of one descriptor-clearing sweep. */
interface DescriptorClearOutcome {
  readonly status: WorktreeDescriptorStatus;
  readonly cleared: readonly string[];
  /** True only when the operator's own task checkpoint was among the cleared files. */
  readonly taskCheckpointCleared: boolean;
}

export interface PruneWorktreesParams {
  readonly workspaceDir?: string;
  readonly expire?: string;
}

export interface ListWorktreesParams {
  readonly workspaceDir?: string;
  readonly includeExternal?: boolean;
}

export interface CleanWorktreesParams {
  readonly workspaceDir?: string;
  readonly subagents?: boolean;
  readonly all?: boolean;
  /** Simulate the cleanup: report what would be removed, delete nothing (#248). */
  readonly dryRun?: boolean;
}

export interface WorktreeOperationResult<T = void> {
  readonly success: boolean;
  readonly message: string;
  readonly data?: T;
}

export class ManageWorktreeUseCase {
  private readonly worktreeManager: WorktreeManagerPort;
  /**
   * Optional: every existing construction stays valid. When present, `teardown`
   * clears the checkpoint descriptor that pointed at the removed path
   * (issue #282 / absorbed #273). Application-layer rule: this use case uses
   * the repository PORT only — no `fs`, no `path`.
   */
  private readonly stateRepo?: StateRepository;

  constructor(worktreeManager: WorktreeManagerPort, stateRepo?: StateRepository) {
    this.worktreeManager = worktreeManager;
    this.stateRepo = stateRepo;
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
   *
   * Issue #282 (absorbed #273): a successful removal also clears the checkpoint
   * descriptor that pointed AT the removed path, so `branch-info` and
   * `next --json` stop advertising a directory that no longer exists. The
   * clearing is scoped by PATH — never by the operator's token alone — so
   * removing worktree `555` can never clear another task's descriptor.
   *
   * A corrupt/unreadable checkpoint must NOT turn a successful removal into a
   * command failure: the status is reported instead.
   */
  public async teardown(
    params: TeardownWorktreeParams
  ): Promise<WorktreeOperationResult<TeardownWorktreeData>> {
    const dryRun = params.dryRun === true;
    // A dry run still calls the manager — with `dryRun: true` — because THAT is
    // what exercises every guard: a missing, unregistered, symlinked or
    // out-of-scope target must still refuse, and the refusal is the prediction.
    await this.worktreeManager.removeWorktree({
      worktreePath: params.worktreePath,
      workspaceDir: params.workspaceDir,
      force: params.force ?? true,
      prune: params.prune ?? true,
      tolerateMissing: params.tolerateMissing,
      allowExternal: params.allowExternal,
      dryRun
    });

    const outcome = await this.clearDescriptor(params, dryRun);

    if (dryRun) {
      const descriptor =
        outcome.status === 'cleared'
          ? ` and would clear the descriptor in ${outcome.cleared.join(', ')}`
          : outcome.status === 'not-found'
            ? ` and no checkpoint descriptor names it (${NOTE_WORKTREE_CHECKPOINT_UNCHANGED})`
            : outcome.status === 'corrupt'
              ? ` (${NOTE_WORKTREE_CHECKPOINT_UNREADABLE})`
              : '';
      return {
        success: true,
        message: `Would remove the worktree at ${params.worktreePath}${descriptor} — nothing was written.`,
        data: {
          descriptorCleared: false,
          descriptorStatus: outcome.status,
          clearedCheckpoints: [],
          wouldClear: outcome.status === 'cleared'
        }
      };
    }

    let message = `${NOTE_WORKTREE_REMOVED} at ${params.worktreePath}`;
    switch (outcome.status) {
      case 'cleared':
        message += ` — ${ManageWorktreeUseCase.clearedNote(outcome)}`;
        break;
      case 'not-found':
        message += ` — ${NOTE_WORKTREE_CHECKPOINT_UNCHANGED}`;
        break;
      case 'corrupt':
        message += ` — ${NOTE_WORKTREE_CHECKPOINT_UNREADABLE}`;
        break;
      default:
        // 'unavailable': no repository was injected — nothing was attempted,
        // so the historical message must stay byte-identical.
        break;
    }

    return {
      success: true,
      message,
      data: {
        descriptorCleared: outcome.status === 'cleared',
        descriptorStatus: outcome.status,
        clearedCheckpoints: outcome.cleared
      }
    };
  }

  /**
   * Repairs a STALE descriptor: clears the checkpoint that recorded
   * `params.worktreePath` when its directory no longer exists (#282 review
   * iteration 2).
   *
   * This is the remediation `NOTE_WORKTREE_STALE` prints. It exists because the
   * plain removal command must keep refusing a missing directory (AC-2), which
   * would otherwise leave the operator with a diagnosed defect and no supported
   * way to repair it. It touches NO filesystem path: only the checkpoint.
   *
   * `not-found` is a SUCCESS (idempotent cleanup: there is nothing left to
   * clear). `corrupt` / `unavailable` are failures: the descriptor may still be
   * on disk, so the caller must not print a success line.
   */
  public async clearStaleDescriptor(
    params: ClearStaleDescriptorParams
  ): Promise<WorktreeOperationResult<TeardownWorktreeData>> {
    const dryRun = params.dryRun === true;
    const outcome = await this.clearDescriptor(params, dryRun);

    const data = {
      descriptorCleared: !dryRun && outcome.status === 'cleared',
      descriptorStatus: outcome.status,
      clearedCheckpoints: dryRun ? [] : outcome.cleared,
      wouldClear: outcome.status === 'cleared'
    } as const;

    if (dryRun) {
      if (outcome.status === 'corrupt') {
        return {
          success: false,
          message: `${NOTE_WORKTREE_CHECKPOINT_UNREADABLE}: ${params.worktreePath}`,
          data
        };
      }
      return {
        success: true,
        message:
          outcome.status === 'cleared'
            ? `Would clear the stale descriptor at ${params.worktreePath} — nothing was written.`
            : `${NOTE_WORKTREE_STALE_ABSENT}: ${params.worktreePath} (${NOTE_WORKTREE_CHECKPOINT_UNCHANGED})`,
        data
      };
    }

    switch (outcome.status) {
      case 'cleared':
        return {
          success: true,
          message: `${NOTE_WORKTREE_STALE_PRUNED} at ${params.worktreePath} — ${ManageWorktreeUseCase.clearedNote(outcome)}`,
          data
        };
      case 'not-found':
        return {
          success: true,
          message: `${NOTE_WORKTREE_STALE_ABSENT}: ${params.worktreePath} (${NOTE_WORKTREE_CHECKPOINT_UNCHANGED})`,
          data
        };
      case 'corrupt':
        return {
          success: false,
          message: `${NOTE_WORKTREE_CHECKPOINT_UNREADABLE}: ${params.worktreePath}`,
          data
        };
      default:
        return {
          success: false,
          message: `No checkpoint repository is available to prune the descriptor at ${params.worktreePath}.`,
          data
        };
    }
  }

  /**
   * Renders the "cleared" post-condition truthfully.
   *
   * "this task no longer records a worktree" is emitted ONLY when the
   * operator's own task checkpoint was among the cleared files; when the only
   * checkpoint that named the path was a different one (a legacy root
   * `.agyloop/state.json`, for example) the scope is stated and the cleared
   * files are listed. Either way the command names every file it wrote.
   */
  private static clearedNote(outcome: DescriptorClearOutcome): string {
    const note = outcome.taskCheckpointCleared
      ? NOTE_WORKTREE_CHECKPOINT_CLEARED
      : NOTE_WORKTREE_CHECKPOINT_CLEARED_SCOPE;
    return outcome.cleared.length > 0 ? `${note}: ${outcome.cleared.join(', ')}` : note;
  }

  /**
   * Clears EVERY checkpoint descriptor that named `params.worktreePath` (#282).
   *
   * Scope resolution is a WATCHLIST, not a scan of every file: the CLI's own
   * repository, the task checkpoint named by `params.issue`, and every
   * checkpoint whose descriptor path matches. A repository is only ever a WRITE
   * target after it has been shown to carry the matching descriptor (#250: one
   * scope, never re-resolve from an already-scoped repository).
   *
   * The scan clears ALL matches rather than stopping at the first: an older
   * build could leave the same descriptor in both `.agyloop/state.json` and
   * `.agyloop/tasks/<id>.json`, and stopping early left the task checkpoint
   * advertising a removed path while the command announced a full clear
   * (review iteration 2).
   *
   * Never throws: `corrupt` is a reportable outcome, not a removal failure.
   */
  private async clearDescriptor(
    params: ClearStaleDescriptorParams,
    dryRun = false
  ): Promise<DescriptorClearOutcome> {
    const stateRepo = this.stateRepo;
    if (!stateRepo) {
      return { status: 'unavailable', cleared: [], taskCheckpointCleared: false };
    }

    const candidates: StateRepository[] = [];
    const seen = new Set<string>();

    const addCandidate = (repo: StateRepository | null | undefined): void => {
      if (!repo) return;
      let key: string;
      try {
        key = repo.getStateFilePath();
      } catch {
        return;
      }
      if (!key || seen.has(key)) return;
      seen.add(key);
      candidates.push(repo);
    };

    addCandidate(stateRepo);

    const issue = params.issue;
    if (issue !== null && issue !== undefined && String(issue).trim() !== '') {
      try {
        addCandidate(stateRepo.forIssue ? stateRepo.forIssue(issue) : undefined);
      } catch {
        // An unusable token is not a reason to fail the removal.
      }
    }

    // Path-matched scan: the only scans are the snapshots `listAllStates`
    // already returns, and a repository is added only when ITS descriptor
    // matches the path we just removed.
    if (stateRepo.listAllStates) {
      try {
        const all = await stateRepo.listAllStates();
        for (const snapshot of all || []) {
          const descriptorPath = ManageWorktreeUseCase.descriptorPath(snapshot);
          if (!descriptorPath || !isSamePath(descriptorPath, params.worktreePath)) continue;
          if (snapshot.issue === null || snapshot.issue === undefined) continue;
          try {
            addCandidate(stateRepo.forIssue ? stateRepo.forIssue(snapshot.issue) : undefined);
          } catch {
            // Skip an unusable issue; other candidates may still match.
          }
        }
      } catch {
        // A scan failure degrades to the explicitly scoped candidates.
      }
    }

    const taskCheckpointPath = ManageWorktreeUseCase.taskCheckpointPath(stateRepo, issue);
    const cleared: string[] = [];
    let sawUnreadable = false;

    for (const repo of candidates) {
      let checkpointPath: string;
      try {
        checkpointPath = repo.getStateFilePath();
      } catch {
        checkpointPath = '';
      }

      try {
        const snapshot = await repo.load();
        if (!snapshot || !snapshot.worktree) continue;

        const descriptorPath = ManageWorktreeUseCase.descriptorPath(snapshot);
        if (!descriptorPath || !isSamePath(descriptorPath, params.worktreePath)) continue;

        const sm = StateMachine.fromSnapshot(snapshot);
        sm.setWorktree(null);
        // A dry run reports the file it WOULD clear and touches nothing (#248).
        if (!dryRun) {
          await repo.save(sm.toSnapshot());
        }
        if (checkpointPath && !cleared.includes(checkpointPath)) cleared.push(checkpointPath);
      } catch {
        sawUnreadable = true;
      }
    }

    const status: WorktreeDescriptorStatus =
      cleared.length > 0 ? 'cleared' : sawUnreadable ? 'corrupt' : 'not-found';

    return {
      status,
      cleared,
      taskCheckpointCleared: taskCheckpointPath !== null && cleared.includes(taskCheckpointPath)
    };
  }

  /**
   * The checkpoint file that belongs to the operator's task, or `null` when the
   * scope cannot be proven (no issue token, or an adapter without `forIssue`).
   * Used only to make the "this task no longer records a worktree" claim exact.
   */
  private static taskCheckpointPath(
    stateRepo: StateRepository,
    issue: number | string | null | undefined
  ): string | null {
    if (issue === null || issue === undefined || String(issue).trim() === '') return null;
    if (!stateRepo.forIssue) return null;
    try {
      return stateRepo.forIssue(issue).getStateFilePath();
    } catch {
      return null;
    }
  }

  /**
   * Reads the descriptor path out of a snapshot.
   *
   * `StateMachineSnapshot.worktree` is `Record<string, unknown> | null`, so the
   * path is narrowed to a string before it is compared; a descriptor without a
   * usable path is skipped rather than matched loosely.
   */
  private static descriptorPath(snapshot: StateMachineSnapshot | null | undefined): string | null {
    const worktree = snapshot?.worktree;
    if (!worktree || typeof worktree !== 'object') return null;
    const candidate = (worktree as Record<string, unknown>).worktreePath;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
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
      workspaceDir: params.workspaceDir,
      includeExternal: params.includeExternal
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
    const dryRun = params.dryRun === true;
    const count = await this.worktreeManager.cleanOrphanedWorktrees({
      workspaceDir: params.workspaceDir,
      subagents: params.subagents,
      all: params.all,
      dryRun
    });

    return {
      success: true,
      message: dryRun
        ? `Would remove ${count} orphaned worktree director${count === 1 ? 'y' : 'ies'} and prune dangling git registrations.`
        : `Cleaned ${count} orphaned worktree(s) and metadata lock(s).`,
      data: { count }
    };
  }
}
