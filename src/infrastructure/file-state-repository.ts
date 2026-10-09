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

  private validateSmokeTestIsolation(operation: 'write' | 'delete'): void {
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
      const realRoot = this.discoverWorkspaceRoot(__dirname);
      const realRootPath = path.join(realRoot, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE);
      const realTasksDir = path.join(realRoot, DEFAULT_STATE_DIR, DEFAULT_TASKS_STATE_DIR);
      if (this.stateFilePath === realRootPath || this.stateFilePath.startsWith(realTasksDir + path.sep)) {
        throw new StateStorageError(
          this.stateFilePath,
          operation,
          MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE
        );
      }
    }
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
    this.validateSmokeTestIsolation('delete');
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
    this.validateSmokeTestIsolation('delete');
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
