/**
 * agyloop - FileStateRepository Infrastructure Adapter
 *
 * Implements StateRepository using atomic disk persistence in `.agyloop/state.json`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { StateMachineSnapshot, StateStorageError, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE } from '../domain';
import { StateRepository } from '../ports';

export class FileStateRepository implements StateRepository {
  private static readonly workspaceRootCache = new Map<string, string>();
  private readonly stateFilePath: string;

  constructor(options: { workspaceDir?: string; stateFilePath?: string } = {}) {
    if (options.stateFilePath) {
      this.stateFilePath = options.stateFilePath;
    } else {
      const workspace = options.workspaceDir
        ? path.resolve(options.workspaceDir)
        : this.discoverWorkspaceRoot(process.cwd());
      this.stateFilePath = path.join(workspace, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE);
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

  public save(snapshot: StateMachineSnapshot): void {
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
}
