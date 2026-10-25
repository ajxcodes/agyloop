/**
 * agyloop - AbortPipelineUseCase (Application Layer)
 *
 * Coordinates the Emergency Abort Protocol:
 * 1. Process Signal Propagation: abruptly terminates active subagents and child processes.
 * 2. Stale Git Lock Removal: safely deletes .git/index.lock if present.
 * 3. Worktree Quarantine: safely stashes uncommitted work or commits to a quarantine branch.
 * 4. Container Sandbox Teardown: terminates & removes ephemeral containers matching 'codeloop-sandbox-*' or label 'app=codeloop'.
 * 5. Audit Logging: appends an explicit '### [ABORTED]' entry to AgyLoop Summary.md.
 */

import {
  StateRepository,
  CommandExecutorPort,
  WorktreeManagerPort,
  PlanGeneratorPort
} from '../ports';
import {
  StateMachineSnapshot,
  isSamePath,
  isPathInsideRoot,
  NOTE_ABORT_QUARANTINE_DISABLED,
  NOTE_ABORT_QUARANTINE_UNSUPPORTED,
  NOTE_ABORT_WORKTREE_CLEAN,
  NOTE_ABORT_WORKTREE_CWD,
  NOTE_ABORT_WORKTREE_NOT_REGISTERED
} from '../domain';

export interface AbortPipelineParams {
  readonly workspaceDir?: string;
  readonly issue?: number | string | null;
  readonly force?: boolean;
  readonly quarantine?: boolean;
  readonly reason?: string;
  readonly activeSubagent?: string;
  /**
   * `--no-quarantine` / `--keep-worktrees` (issue #266 AC-5): tear the run down
   * without relocating the worktree's uncommitted work.
   *
   * TODO(#248): `--dry-run` never reaches this use case; once that wiring
   * exists it should map onto this flag. No behaviour here.
   */
  readonly noQuarantine?: boolean;
  /** Injectable cwd (defaults to `process.cwd()`) so the skip-cwd guard is testable. */
  readonly currentDir?: string;
}

/** One worktree the abort relocated, with the reference needed to restore it. */
export interface AbortQuarantineEntry {
  readonly worktreePath: string;
  readonly branch?: string;
  readonly stashed?: boolean;
  readonly stashRef?: string;
  readonly stashMessage?: string;
}

export interface AbortPipelineResult {
  readonly success: boolean;
  readonly processesTerminated: number;
  readonly terminatedProcessesCount?: number;
  readonly indexLockRemoved: boolean;
  /**
   * ONLY the checkpoint's own worktree may appear here (issue #266 AC-1): the
   * emergency abort used to quarantine every registered worktree, including
   * other tasks' and external ones.
   */
  readonly worktreesQuarantined: AbortQuarantineEntry[];
  /** Worktrees deliberately left untouched, each with the reason. */
  readonly worktreesQuarantineSkipped: Array<{ worktreePath: string; reason: string }>;
  /** Quarantine attempts that failed atomically (AC-6). Never counted as quarantined. */
  readonly worktreesQuarantineFailed: Array<{ worktreePath: string; error: string }>;
  /** The descriptor path the checkpoint recorded, or null when it recorded none. */
  readonly worktreeScopePath: string | null;
  readonly containersTerminated: string[];
  readonly auditLogged: boolean;
  readonly durationMs: number;
}

export class AbortPipelineUseCase {
  private readonly stateRepo: StateRepository;
  private readonly commandExecutor: CommandExecutorPort;
  private readonly worktreeManager: WorktreeManagerPort;
  private readonly planGenerator?: PlanGeneratorPort;

  constructor(dependencies: {
    stateRepo: StateRepository;
    commandExecutor: CommandExecutorPort;
    worktreeManager: WorktreeManagerPort;
    planGenerator?: PlanGeneratorPort;
  }) {
    this.stateRepo = dependencies.stateRepo;
    this.commandExecutor = dependencies.commandExecutor;
    this.worktreeManager = dependencies.worktreeManager;
    this.planGenerator = dependencies.planGenerator;
  }

  public async execute(params: AbortPipelineParams = {}): Promise<AbortPipelineResult> {
    const startTime = Date.now();
    const workspace = params.workspaceDir;

    // 1. Process Signal Propagation
    let processesTerminated = 0;
    try {
      if (this.commandExecutor.killAll) {
        processesTerminated = this.commandExecutor.killAll(params.force ? 'SIGKILL' : 'SIGTERM');
        if (processesTerminated > 0) {
          console.debug(`[abort] Terminated ${processesTerminated} active child process(es).`);
        }
      }
    } catch (err: unknown) {
      console.debug(`[abort] Warning: failed to propagate process signals: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Clear Stale .git/index.lock
    let indexLockRemoved = false;
    try {
      if (this.worktreeManager.clearIndexLock) {
        indexLockRemoved = await this.worktreeManager.clearIndexLock(workspace);
      }
    } catch {
      // Non-fatal
    }

    // 3. Worktree Quarantine & Safe Teardown
    //
    // Issue #266 (live #250 instance): this step used to quarantine EVERY
    // worktree `listWorktrees({ includeExternal: true })` returned, so aborting
    // one task emptied every other task's in-flight work. Only the checkpoint's
    // OWN worktree may be touched, external worktrees never are (AC-3), and the
    // directory the abort was invoked from is left alone (AC-8).
    let snapshot: StateMachineSnapshot | null = null;
    try {
      // Corrupt ⇒ null, never fatal (#250 B1).
      snapshot = await this.stateRepo.load();
    } catch {
      // Left null: a checkpoint that cannot be read selects no worktree.
    }

    const quarantine = await this.quarantineOwnWorktree(params, workspace, snapshot);
    const worktreesQuarantined = quarantine.quarantined;
    const worktreesQuarantineSkipped = quarantine.skipped;
    const worktreesQuarantineFailed = quarantine.failed;
    const worktreeScopePath = quarantine.scopePath;

    // 4. Container Sandbox Teardown (Docker / Podman)
    const containersTerminated: string[] = [];
    await this.cleanupContainers(containersTerminated);

    // 5. Audit Checkpoint in Summary
    let auditLogged = false;
    try {
      const currentStage = snapshot?.currentStage || 'UNKNOWN';
      const issue = params.issue ?? snapshot?.issue;

      let summaryPath: string | null = null;
      if (this.planGenerator && issue) {
        const resolved = this.planGenerator.resolvePlanFile({
          projectRoot: workspace,
          issue
        });
        if (resolved && resolved.summaryPath) {
          summaryPath = resolved.summaryPath;
        }
      }

      if (summaryPath && this.planGenerator) {
        const timestamp = new Date().toISOString();
        auditLogged = this.planGenerator.updateSummaryLog(summaryPath, {
          abortEvent: {
            timestamp,
            stage: currentStage,
            subagent: params.activeSubagent || 'CLI/Orchestrator',
            filesTouched: worktreesQuarantined.map((w) => w.worktreePath),
            teardownMetrics: {
              processesTerminated,
              terminatedProcessesCount: processesTerminated,
              indexLockRemoved,
              containersTerminated: containersTerminated.length,
              worktreesQuarantined: worktreesQuarantined.length,
              worktreesQuarantineFailed: worktreesQuarantineFailed.length,
              worktreesQuarantineSkipped: worktreesQuarantineSkipped.length
            },
            reason: params.reason || (params.force ? 'Forced Emergency Abort' : 'Emergency Abort Signal Received')
          }
        });
      }
    } catch {
      // Non-fatal
    }

    const durationMs = Date.now() - startTime;
    return {
      success: true,
      processesTerminated,
      terminatedProcessesCount: processesTerminated,
      indexLockRemoved,
      worktreesQuarantined,
      worktreesQuarantineSkipped,
      worktreesQuarantineFailed,
      worktreeScopePath,
      containersTerminated,
      auditLogged,
      durationMs
    };
  }

  /**
   * Selects and quarantines the ONE worktree this checkpoint owns (issue #266).
   *
   * Decision order, each step reported to the operator rather than silently
   * skipped:
   *
   *   1. no recorded descriptor          → nothing selected (`scopePath: null`);
   *   2. `--no-quarantine`               → skipped (AC-5);
   *   3. the cwd is inside that worktree → skipped (AC-8, the #250 incident);
   *   4. the adapter has no quarantine   → skipped;
   *   5. the path is not registered      → skipped (AC-3: a stale descriptor or
   *                                        an external worktree is never a
   *                                        destructive target);
   *   6. otherwise                       → quarantine and report the reference.
   *
   * `includeExternal` is deliberately NOT passed: a destructive operation never
   * widens past `<repo>/.worktrees` (AC-3).
   *
   * Never throws: a git failure is reported as a failure, not a teardown abort.
   */
  private async quarantineOwnWorktree(
    params: AbortPipelineParams,
    workspace: string | undefined,
    snapshot: StateMachineSnapshot | null
  ): Promise<{
    quarantined: AbortQuarantineEntry[];
    skipped: Array<{ worktreePath: string; reason: string }>;
    failed: Array<{ worktreePath: string; error: string }>;
    scopePath: string | null;
  }> {
    const quarantined: AbortQuarantineEntry[] = [];
    const skipped: Array<{ worktreePath: string; reason: string }> = [];
    const failed: Array<{ worktreePath: string; error: string }> = [];
    const ownPath = AbortPipelineUseCase.recordedWorktreePath(snapshot);

    if (!ownPath) {
      return { quarantined, skipped, failed, scopePath: null };
    }

    const scopePath = ownPath;

    if (params.noQuarantine) {
      skipped.push({ worktreePath: ownPath, reason: NOTE_ABORT_QUARANTINE_DISABLED });
      return { quarantined, skipped, failed, scopePath };
    }

    const cwd = params.currentDir ?? process.cwd();
    if (isSamePath(cwd, ownPath) || isPathInsideRoot(cwd, ownPath)) {
      skipped.push({ worktreePath: ownPath, reason: NOTE_ABORT_WORKTREE_CWD });
      return { quarantined, skipped, failed, scopePath };
    }

    const quarantineWorktree = this.worktreeManager.quarantineWorktree;
    if (!quarantineWorktree) {
      skipped.push({ worktreePath: ownPath, reason: NOTE_ABORT_QUARANTINE_UNSUPPORTED });
      return { quarantined, skipped, failed, scopePath };
    }

    try {
      // Ownership check (#266 §2.3): `quarantineWorktree` has no containment
      // check of its own, so the path is acted on ONLY when this repository
      // reports it as a registered worktree.
      const listed = await this.worktreeManager.listWorktrees({ workspaceDir: workspace });
      const own = listed.find((wt) => isSamePath(wt.worktreePath, ownPath));
      if (!own) {
        skipped.push({ worktreePath: ownPath, reason: NOTE_ABORT_WORKTREE_NOT_REGISTERED });
        return { quarantined, skipped, failed, scopePath };
      }

      const res = await quarantineWorktree.call(this.worktreeManager, {
        worktreePath: own.worktreePath,
        taskId: own.taskId,
        quarantineBranch: params.quarantine,
        workspaceDir: workspace
      });

      if (res.quarantined) {
        quarantined.push({
          worktreePath: own.worktreePath,
          branch: res.branch,
          stashed: res.stashed,
          stashRef: res.stashRef,
          stashMessage: res.stashMessage
        });
      } else if (res.error) {
        failed.push({ worktreePath: own.worktreePath, error: res.error });
      } else {
        skipped.push({
          worktreePath: own.worktreePath,
          reason:
            res.outcome === 'clean'
              ? NOTE_ABORT_WORKTREE_CLEAN
              : 'worktree path does not exist'
        });
      }
    } catch (err: unknown) {
      failed.push({
        worktreePath: ownPath,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return { quarantined, skipped, failed, scopePath };
  }

  /** The descriptor's `worktreePath`, narrowed to a non-empty string. */
  private static recordedWorktreePath(
    snapshot: StateMachineSnapshot | null
  ): string | null {
    const worktree = snapshot?.worktree;
    if (!worktree || typeof worktree !== 'object') return null;
    const candidate = (worktree as Record<string, unknown>).worktreePath;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  }

  private async cleanupContainers(containersTerminated: string[]): Promise<void> {
    const runtimes = ['docker', 'podman'];
    for (const runtime of runtimes) {
      try {
        const psRes = await this.commandExecutor.execute(
          `${runtime} ps -a --filter "name=codeloop-sandbox-*" --format "{{.ID}}"`,
          { timeoutMs: 2000 }
        );
        if (psRes.exitCode === 0 && psRes.stdout && psRes.stdout.trim()) {
          const ids = psRes.stdout.trim().split(/\s+/).filter(Boolean);
          for (const id of ids) {
            await this.commandExecutor.execute(`${runtime} rm -f ${id}`, { timeoutMs: 2000 });
            containersTerminated.push(`${runtime}:${id}`);
          }
        }

        // Also check by label app=codeloop
        const labelRes = await this.commandExecutor.execute(
          `${runtime} ps -a --filter "label=app=codeloop" --format "{{.ID}}"`,
          { timeoutMs: 2000 }
        );
        if (labelRes.exitCode === 0 && labelRes.stdout && labelRes.stdout.trim()) {
          const ids = labelRes.stdout.trim().split(/\s+/).filter(Boolean);
          for (const id of ids) {
            if (!containersTerminated.includes(`${runtime}:${id}`)) {
              await this.commandExecutor.execute(`${runtime} rm -f ${id}`, { timeoutMs: 2000 });
              containersTerminated.push(`${runtime}:${id}`);
            }
          }
        }
      } catch {
        // Runtime not installed or unavailable
      }
    }
  }
}
