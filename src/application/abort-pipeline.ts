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

export interface AbortPipelineParams {
  readonly workspaceDir?: string;
  readonly issue?: number | string | null;
  readonly force?: boolean;
  readonly quarantine?: boolean;
  readonly reason?: string;
  readonly activeSubagent?: string;
}

export interface AbortPipelineResult {
  readonly success: boolean;
  readonly processesTerminated: number;
  readonly terminatedProcessesCount?: number;
  readonly indexLockRemoved: boolean;
  readonly worktreesQuarantined: Array<{ worktreePath: string; branch?: string; stashed?: boolean }>;
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
    const worktreesQuarantined: Array<{ worktreePath: string; branch?: string; stashed?: boolean }> = [];
    try {
      const activeWorktrees = await this.worktreeManager.listWorktrees({
        workspaceDir: workspace,
        includeExternal: true
      });

      for (const wt of activeWorktrees) {
        if (this.worktreeManager.quarantineWorktree) {
          const res = await this.worktreeManager.quarantineWorktree({
            worktreePath: wt.worktreePath,
            taskId: wt.taskId,
            quarantineBranch: params.quarantine,
            workspaceDir: workspace
          });
          if (res.quarantined) {
            worktreesQuarantined.push({
              worktreePath: wt.worktreePath,
              branch: res.branch,
              stashed: res.stashed
            });
          }
        }
      }
    } catch {
      // Non-fatal
    }

    // 4. Container Sandbox Teardown (Docker / Podman)
    const containersTerminated: string[] = [];
    await this.cleanupContainers(containersTerminated);

    // 5. Audit Checkpoint in Summary
    let auditLogged = false;
    try {
      const snapshot = await this.stateRepo.load();
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
              worktreesQuarantined: worktreesQuarantined.length
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
      containersTerminated,
      auditLogged,
      durationMs
    };
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
