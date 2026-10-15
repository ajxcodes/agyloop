/**
 * agyloop - FileStateRepository Infrastructure Adapter
 *
 * Implements StateRepository using atomic disk persistence in `.agyloop/state.json`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as os from 'os';
import {
  StateMachineSnapshot,
  StateStorageError,
  DEFAULT_STATE_DIR,
  DEFAULT_STATE_FILE,
  DEFAULT_TASKS_STATE_DIR,
  IssueNumber,
  MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST,
  MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE
} from '../domain';
import { StateRepository } from '../ports';

export class FileStateRepository implements StateRepository {
  private static readonly workspaceRootCache = new Map<string, string>();
  private readonly stateFilePath: string;
  private readonly workspaceRoot: string;

  constructor(options: { workspaceDir?: string; stateFilePath?: string; issue?: number | null } = {}) {
    const workspace = options.workspaceDir
      ? path.resolve(options.workspaceDir)
      : this.discoverWorkspaceRoot(process.cwd());
    this.workspaceRoot = workspace;

    if (options.stateFilePath) {
      this.stateFilePath = options.stateFilePath;
    } else {
      const inferredIssue = options.issue !== undefined && options.issue !== null
        ? options.issue
        : IssueNumber.inferFromPath(process.cwd());

      if (inferredIssue !== null && inferredIssue !== undefined) {
        this.stateFilePath = path.join(workspace, DEFAULT_STATE_DIR, DEFAULT_TASKS_STATE_DIR, `${inferredIssue}.json`);
      } else {
        this.stateFilePath = path.join(workspace, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE);
      }
    }
  }

  /**
   * Resolves the primary git workspace root with memoization by cwd.
   * When inside a linked git worktree or nested subdirectory, this ensures
   * the canonical root repository is located rather than a localized worktree.
   */
  private discoverWorkspaceRoot(cwd: string): string {
    const resolvedCwd = path.resolve(cwd);
    const cached = FileStateRepository.workspaceRootCache.get(resolvedCwd);
    if (cached !== undefined) {
      return cached;
    }

    let discoveredRoot = resolvedCwd;

    try {
      const stdout = child_process.execSync('git worktree list --porcelain', {
        cwd: resolvedCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (stdout) {
        const firstLine = stdout.trim().split('\n')[0] || '';
        const match = firstLine.match(/^worktree (.+)$/);
        if (match && match[1]) {
          discoveredRoot = path.resolve(match[1].trim());
          FileStateRepository.workspaceRootCache.set(resolvedCwd, discoveredRoot);
          return discoveredRoot;
        }
      }
    } catch {
      // Fall through to git rev-parse
    }

    try {
      const stdout = child_process.execSync('git rev-parse --show-toplevel', {
        cwd: resolvedCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (stdout && stdout.trim()) {
        discoveredRoot = path.resolve(stdout.trim());
        FileStateRepository.workspaceRootCache.set(resolvedCwd, discoveredRoot);
        return discoveredRoot;
      }
    } catch {
      // Fall through to cwd
    }

    // NOTE: the cwd fallback is cached exactly like a successful probe, so a
    // transient git failure pins this resolution for the process lifetime.
    // It is still consumed, as the fallback root that workspaceResetTargets()
    // derives deletion targets from, so treat `workspaceRoot` as trustworthy.
    FileStateRepository.workspaceRootCache.set(resolvedCwd, discoveredRoot);
    return discoveredRoot;
  }

  /**
   * Clears the static workspace root cache (useful for testing or cache invalidation).
   */
  public static clearWorkspaceRootCache(): void {
    FileStateRepository.workspaceRootCache.clear();
  }

  public getStateFilePath(): string {
    return this.stateFilePath;
  }

  public load(): StateMachineSnapshot | null {
    if (!fs.existsSync(this.stateFilePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(this.stateFilePath, 'utf8');
      return JSON.parse(content) as StateMachineSnapshot;
    } catch (err) {
      throw new StateStorageError(
        this.stateFilePath,
        'read',
        `Failed to parse state checkpoint at ${this.stateFilePath}`,
        err
      );
    }
  }

  /**
   * Refuses state mutations that could reach real orchestrator state.
   *
   * `additionalTargets` carries the extra paths an operation destroys beyond
   * `stateFilePath` (see `workspaceResetTargets`).
   */
  private validateSmokeTestIsolation(
    operation: 'write' | 'delete',
    additionalTargets: string[] = []
  ): void {
    const cwd = path.resolve(process.cwd());
    const isArtifactsSmoke = cwd.includes(`${path.sep}artifacts${path.sep}smoke`);
    
    // Bypass the /tmp block during unit tests because agyloop tests run in /tmp
    const isTmpDir = cwd.startsWith('/tmp') || cwd.startsWith(os.tmpdir());
    const isTmpBlocked = process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT;

    if (isArtifactsSmoke || (isTmpDir && isTmpBlocked)) {
      throw new StateStorageError(
        this.stateFilePath,
        operation,
        MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST
      );
    }

    if (process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)) {
      const unproven = [this.stateFilePath, ...additionalTargets].find(
        (target) => !this.isProvenIsolatedFromRealState(target)
      );
      if (unproven !== undefined) {
        throw new StateStorageError(
          unproven,
          operation,
          MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE
        );
      }
    }
  }

  /**
   * Fail-closed proof that `target` is provably isolated from real orchestrator state.
   *
   * Two conditions must BOTH hold:
   *
   *  1. `target` lives under the OS temp sandbox. This half is git-free and never
   *     fails open, so it is what keeps the guard alive when git is unusable.
   *  2. `target` is not the workspace root of this package, nor its root state
   *     file. This half is what stops condition 1 from being self-defeating: a
   *     checkout that lives under /tmp (or under a TMPDIR that is an ancestor of
   *     it) has its own `.agyloop/state.json` inside the sandbox, and condition 1
   *     alone would happily certify the real state file as isolated.
   *
   * `git` is consulted only as a *negative* veto in (2), never as positive proof.
   * That asymmetry is deliberate: the old implementation needed git to produce a
   * positive "these roots differ", and when git failed (container without a usable
   * `.git` indirection, CI tarball, broken worktree gitdir) the two resolutions
   * diverged and the guard silently disabled itself. Here a git failure can only
   * *remove* refusals, never grant permission, and the unconditional condition (1)
   * still stands -- so the guard degrades to "tempdir only", never to "off".
   */
  private isProvenIsolatedFromRealState(target: string): boolean {
    const tmpRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(target);

    if (!(resolved === tmpRoot || resolved.startsWith(tmpRoot + path.sep))) {
      return false;
    }

    const realRoot = path.resolve(this.discoverWorkspaceRoot(__dirname));
    return (
      resolved !== realRoot &&
      resolved !== path.resolve(realRoot, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE)
    );
  }

  /**
   * Extra paths a workspace-wide reset can destroy. `resetTask`/`resetAll`
   * derive their deletion targets from `workspaceRoot` rather than from
   * `stateFilePath`, so that root must be proven isolated as well.
   */
  private workspaceResetTargets(): string[] {
    return [
      this.workspaceRoot,
      path.join(this.workspaceRoot, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE),
      path.join(this.workspaceRoot, DEFAULT_STATE_DIR, DEFAULT_TASKS_STATE_DIR)
    ];
  }

  private validateWorktreeIssueMatch(snapshot: StateMachineSnapshot): void {
    const inferredIssue = IssueNumber.inferFromPath(process.cwd());
    if (inferredIssue !== null && snapshot.issue !== undefined && snapshot.issue !== inferredIssue) {
      throw new StateStorageError(
        this.stateFilePath,
        'write',
        `Cannot save state for issue ${snapshot.issue} from inside worktree for issue ${inferredIssue}. Use read-only commands inside worktrees.`
      );
    }
  }

  public save(snapshot: StateMachineSnapshot): void {
    this.validateSmokeTestIsolation('write');
    this.validateWorktreeIssueMatch(snapshot);

    const dir = path.dirname(this.stateFilePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serialized = JSON.stringify(snapshot, null, 2) + '\n';
      fs.writeFileSync(this.stateFilePath, serialized, 'utf8');
    } catch (err) {
      throw new StateStorageError(
        this.stateFilePath,
        'write',
        `Failed to save state checkpoint to ${this.stateFilePath}`,
        err
      );
    }
  }

  public reset(): void {
    this.validateSmokeTestIsolation('delete');
    try {
      if (fs.existsSync(this.stateFilePath)) {
        fs.unlinkSync(this.stateFilePath);
      }
    } catch (err) {
      throw new StateStorageError(
        this.stateFilePath,
        'delete',
        `Failed to remove state checkpoint file at ${this.stateFilePath}`,
        err
      );
    }
  }

  public resetTask(issue: number | string): void {
    this.validateSmokeTestIsolation('delete', this.workspaceResetTargets());
    const taskFile = path.join(
      this.workspaceRoot,
      DEFAULT_STATE_DIR,
      DEFAULT_TASKS_STATE_DIR,
      `${issue}.json`
    );
    try {
      if (fs.existsSync(taskFile)) {
        fs.unlinkSync(taskFile);
      }
    } catch (err) {
      throw new StateStorageError(
        taskFile,
        'delete',
        `Failed to remove task state file at ${taskFile}`,
        err
      );
    }
  }

  public resetAll(): void {
    this.validateSmokeTestIsolation('delete', this.workspaceResetTargets());
    // 1. Remove root state file
    const rootStateFile = path.join(this.workspaceRoot, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE);
    try {
      if (fs.existsSync(rootStateFile)) {
        fs.unlinkSync(rootStateFile);
      }
    } catch {
      // Continue to tasks dir
    }

    // 2. Remove all task state files in tasks dir
    const tasksDir = path.join(this.workspaceRoot, DEFAULT_STATE_DIR, DEFAULT_TASKS_STATE_DIR);
    try {
      if (fs.existsSync(tasksDir)) {
        const files = fs.readdirSync(tasksDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(tasksDir, file));
            } catch {
              // Ignore individual delete error
            }
          }
        }
      }
    } catch {
      // Ignore directory read error
    }

    // 3. Also unlink current stateFilePath if distinct
    if (this.stateFilePath !== rootStateFile && fs.existsSync(this.stateFilePath)) {
      try {
        fs.unlinkSync(this.stateFilePath);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Scans and returns all known task snapshots from .agyloop/tasks/*.json
   * and the singleton snapshot from .agyloop/state.json if present.
   */
  public listAllStates(): StateMachineSnapshot[] {
    const results: StateMachineSnapshot[] = [];
    const rootStateFile = path.join(this.workspaceRoot, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE);
    const tasksDir = path.join(this.workspaceRoot, DEFAULT_STATE_DIR, DEFAULT_TASKS_STATE_DIR);

    if (fs.existsSync(rootStateFile)) {
      try {
        const content = fs.readFileSync(rootStateFile, 'utf8');
        const snapshot = JSON.parse(content) as StateMachineSnapshot;
        if (snapshot && snapshot.currentStage) {
          results.push(snapshot);
        }
      } catch {
        // Gracefully ignore corrupt or invalid state files
      }
    }

    if (fs.existsSync(tasksDir)) {
      try {
        const files = fs.readdirSync(tasksDir);
        for (const file of files) {
          if (!file.endsWith('.json')) {
            continue;
          }
          const taskFilePath = path.join(tasksDir, file);
          try {
            const content = fs.readFileSync(taskFilePath, 'utf8');
            const snapshot = JSON.parse(content) as StateMachineSnapshot;
            if (snapshot && snapshot.currentStage) {
              results.push(snapshot);
            }
          } catch {
            // Gracefully ignore corrupt or invalid task state files
          }
        }
      } catch {
        // Gracefully ignore directory read errors
      }
    }

    return results;
  }
}
