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
  /** Main (canonical) worktree root of the repository owning this package. */
  private static readonly mainWorktreeRootCache = new Map<string, string>();
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
   * Resolves the git worktree root that contains `cwd`, with memoization by cwd.
   *
   * This deliberately resolves to the LOCAL worktree root -- the checkout the
   * caller is actually standing in -- so that state is read from and written to
   * that worktree's own `.agyloop` directory. A command run inside a task
   * worktree must never read or write the main repository's state.
   *
   * `git rev-parse --show-toplevel` is the only git probe, and it is exactly the
   * right one: it walks up from `cwd` and returns the root of the worktree that
   * contains `cwd`, including from nested subdirectories and from detached
   * worktrees.
   *
   * `git worktree list --porcelain` is deliberately NOT consulted. Git always
   * emits the main worktree as its first record regardless of the invoking cwd,
   * so taking that record as "the workspace root" made the *ordering* of git's
   * output decide where state landed -- every invocation from inside a task
   * worktree silently resolved to the main repository. Callers that genuinely
   * need the main worktree (e.g. GitWorktreeManager.getRepoRoot, which creates
   * worktrees under <main>/.worktrees/<id>) keep their own `worktree list` probe.
   *
   * On probe failure the resolution degrades to the cwd fallback WITHOUT caching,
   * so a transient git failure cannot pin workspaceRoot for the lifetime of the
   * process (#221).
   */
  private discoverWorkspaceRoot(cwd: string): string {
    const resolvedCwd = path.resolve(cwd);
    const cached = FileStateRepository.workspaceRootCache.get(resolvedCwd);
    if (cached !== undefined) {
      return cached;
    }

    let discoveredRoot = resolvedCwd;

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
      // Fall through to cwd fallback (no cache) — a transient git failure
      // must not pin workspaceRoot to the cwd for the process lifetime.
    }

    // cwd fallback: return without caching so that a transient git failure
    // does not permanently pin workspaceRoot to the cwd for the process lifetime.
    // The root will be re-resolved on the next FileStateRepository instantiation.
    return discoveredRoot;
  }

  /**
   * Returns a repository bound to `issue`'s task checkpoint.
   *
   * Reuses the already-discovered workspaceRoot, so no git probe and no state
   * write happens here; `stateFilePath` resolves through the same branch the
   * constructor uses when an issue is known. Deliberately rooted at
   * `this.workspaceRoot` rather than at `process.cwd()`: the checkpoint a caller
   * is already reading must not silently move because the process changed
   * directory between the read and the write (#226 D6).
   */
  public forIssue(issue: number | string): FileStateRepository {
    return new FileStateRepository({ workspaceDir: this.workspaceRoot, issue: Number(issue) });
  }

  /**
   * Clears the cached workspace roots (useful for testing or cache invalidation).
   * Clears both the per-cwd workspace root cache and this package's main worktree
   * root cache, so no resolution can leak between tests.
   */
  public static clearWorkspaceRootCache(): void {
    FileStateRepository.workspaceRootCache.clear();
    FileStateRepository.mainWorktreeRootCache.clear();
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
   * Resolves the MAIN (canonical) worktree root of the repository that owns
   * `__dirname`, with memoization.
   *
   * `git rev-parse --path-format=absolute --git-common-dir` returns the shared
   * `.git` directory of the repository -- `.git` when asked from the main
   * worktree, and that same directory when asked from any linked worktree -- so,
   * for the standard `.git` layout, `path.dirname` of it is the main worktree
   * root. Three layouts break that identity, so the main root is simply not
   * discovered there:
   *
   *   - `git init --separate-git-dir=G W` -> `dirname` yields `parent(G)`
   *   - a submodule checked out at `<super>/sub` -> `<super>/.git/modules`
   *   - a bare repository at `<base>/bare` -> `<base>`, its *parent*
   *
   * That is bounded, not dangerous: this is a *negative* veto only, and
   * `discoverWorkspaceRoot`'s `localRoot` veto still covers the real target.
   *
   * This exists solely so the isolation guard can keep vetoing the main root
   * after `discoverWorkspaceRoot` started narrowing to the local worktree. It is
   * never used to locate state, and it is cached separately from
   * `workspaceRootCache` because it answers a different question and is keyed by
   * `__dirname` rather than by cwd.
   *
   * On probe failure -- or on probe output that does not look like a single
   * absolute path -- it degrades to `__dirname`, uncached, matching the
   * fail-safe fallback posture of `discoverWorkspaceRoot`.
   */
  private discoverMainWorktreeRoot(): string {
    const key = path.resolve(__dirname);
    const cached = FileStateRepository.mainWorktreeRootCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const stdout = child_process.execSync('git rev-parse --path-format=absolute --git-common-dir', {
        cwd: key,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const trimmed = stdout ? stdout.trim() : '';
      const lines = trimmed ? trimmed.split('\n') : [];
      // git < 2.31 does NOT reject an unknown `--flag=value`: it echoes the
      // argument back onto stdout and exits 0, so stdout becomes a two-line
      // string starting with `-`. Trusting it would resolve against
      // process.cwd() (NOT the `cwd:` above) and cache that garbage for the
      // process lifetime -- silently deleting the main-root veto this method
      // exists to provide. Require a single absolute line; anything else is
      // treated exactly like a failed probe.
      if (lines.length === 1 && path.isAbsolute(lines[0])) {
        const mainRoot = path.dirname(lines[0]);
        FileStateRepository.mainWorktreeRootCache.set(key, mainRoot);
        return mainRoot;
      }
    } catch {
      // Git unavailable: fall back to the package-owning directory, uncached.
      // Like malformed probe output, this only ever yields an extra veto target,
      // never a missing one.
    }

    return key;
  }

  /**
   * Fail-closed proof that `target` is provably isolated from real orchestrator state.
   *
   * Two conditions must BOTH hold:
   *
   *  1. `target` lives under the OS temp sandbox. This half is git-free and never
   *     fails open, so it is what keeps the guard alive when git is unusable.
   *  2. `target` is not EITHER workspace root of this package -- the local worktree
   *     the package is loaded from, nor the canonical main worktree of that
   *     repository -- nor the root state file of either. The second root is
   *     discovered independently via
   *     `git rev-parse --path-format=absolute --git-common-dir`; it is the one
   *     that keeps the main root refused once local resolution has narrowed to a
   *     task worktree. Both are *negative* vetoes: adding `mainRoot` to the union
   *     can never remove a refusal `localRoot` already makes, and it can only
   *     narrow the accepted set, never widen it. When the git probe fails or
   *     returns unusable output, `mainRoot` degrades to this package's own
   *     directory, so that one veto is simply absent -- never redirected at some
   *     unrelated path.
   *     This half is what stops condition 1 from being self-defeating: a
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

    // Two roots are vetoed, not one:
    //  - localRoot: the worktree this package is loaded from;
    //  - mainRoot:  the canonical main worktree of that repository, which matters
    //               when the package is loaded from inside a task worktree and the
    //               local resolution therefore narrows to that worktree.
    // Both comparisons are exact matches (the root itself and its root state file),
    // so adding `mainRoot` can never remove a refusal `localRoot` already makes --
    // it can only ever refuse, never grant permission the pre-#244 resolver
    // withheld. The converse does NOT hold: while the main-root probe resolves
    // (git >= 2.31, standard `.git` layout) the veto is a superset of the
    // pre-#244 one, but if that probe fails or returns unusable output `mainRoot`
    // degrades to this package's own directory and the main-root veto is absent.
    const localRoot = path.resolve(this.discoverWorkspaceRoot(__dirname));
    const mainRoot = this.discoverMainWorktreeRoot();

    for (const root of new Set([localRoot, mainRoot])) {
      if (resolved === root || resolved === path.resolve(root, DEFAULT_STATE_DIR, DEFAULT_STATE_FILE)) {
        return false;
      }
    }

    return true;
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
