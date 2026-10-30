/**
 * agyloop - FileWorkspaceMutationProbe Adapter
 *
 * Concrete boundary measurement implementing WorkspaceMutationProbePort
 * (issue #389). Two channels, because the reported defect class defeats the
 * obvious one:
 *
 *  - watched roots (`dist/`, `build/`, `artifacts/`) are walked DIRECTLY. They
 *    are gitignored, so `git status --porcelain` reports them clean — the exact
 *    blindness this adapter removes;
 *  - the tracked/untracked working tree is read from `git status --porcelain
 *    -z`, so a non-ignored write is named precisely instead of being folded
 *    into a root digest.
 *
 * Both are baseline-relative: `snapshot()` is the dispatch-time reference and
 * `compare()` only reports what changed since. A pre-existing dirty `dist/` is
 * the reference, never a violation.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  STAGE_FINDING_RULE_TRACKED_WRITE_OUTSIDE_SCOPE,
  STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE,
  WORKSPACE_MUTATION_MAX_FILES_PER_ROOT,
  WORKSPACE_MUTATION_MAX_REPORTED_PATHS,
  WORKSPACE_MUTATION_WATCHED_ROOTS,
  isWorkspaceMutationBaseline,
  type StageFinding,
  type WorkspaceMutationBaseline,
  type WorkspaceMutationRootDigest
} from '../domain';
import type {
  CommandExecutorPort,
  WorkspaceMutationCompareParams,
  WorkspaceMutationProbePort,
  WorkspaceMutationSnapshotParams
} from '../ports';

/** Tool-owned state dirs are never a stage write: the harness writes them on the same read. */
const TOOL_STATE_PREFIXES: readonly string[] = Object.freeze(['.agyloop', '.codeloop']);

const ABSENT_ROOT_DIGEST = 'absent' as const;

interface TrackedEntry {
  readonly path: string;
  readonly status: string;
}

export class FileWorkspaceMutationProbe implements WorkspaceMutationProbePort {
  private readonly commandExecutor: CommandExecutorPort;

  constructor(commandExecutor: CommandExecutorPort) {
    this.commandExecutor = commandExecutor;
  }

  public async snapshot(params: WorkspaceMutationSnapshotParams): Promise<WorkspaceMutationBaseline> {
    const workspaceDir = path.resolve(params.workspaceDir);
    const excludePaths = this.normaliseExcludes(workspaceDir, params.excludePaths);
    const roots = params.roots ?? WORKSPACE_MUTATION_WATCHED_ROOTS;

    const digests = roots.map((root) => this.digestRoot(workspaceDir, root, excludePaths));

    return {
      workspaceDir,
      capturedAt: new Date().toISOString(),
      roots: digests,
      trackedEntries: await this.readTrackedEntries(workspaceDir, excludePaths)
    };
  }

  public async compare(params: WorkspaceMutationCompareParams): Promise<readonly StageFinding[]> {
    if (!isWorkspaceMutationBaseline(params.baseline)) {
      // A malformed checkpoint field is unmeasured, never a violation.
      return [];
    }

    const workspaceDir = path.resolve(params.workspaceDir);
    if (path.resolve(params.baseline.workspaceDir) !== workspaceDir) {
      // Cross-directory comparison invents findings (issue #389, §2.5.8).
      return [];
    }

    const excludePaths = this.normaliseExcludes(workspaceDir, params.excludePaths);
    const findings: StageFinding[] = [];

    for (const baselineRoot of params.baseline.roots) {
      const current = this.digestRoot(workspaceDir, baselineRoot.root, excludePaths);
      if (current.digest === baselineRoot.digest) {
        continue;
      }
      findings.push({
        rule: STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE,
        path: `${baselineRoot.root}/`,
        detail: this.describeRootChange(baselineRoot.root)
      });
    }

    const trackedFindings = await this.compareTrackedEntries(
      workspaceDir,
      params.baseline.trackedEntries,
      excludePaths
    );
    findings.push(...trackedFindings);

    return findings;
  }

  private describeRootChange(root: string): string {
    return root === 'dist' || root === 'build'
      ? 'root build changed outside the plan directory'
      : 'changed outside the plan directory';
  }

  /** Resolves excludes once, so the same rule filters the walk and the tracked set. */
  private normaliseExcludes(workspaceDir: string, excludePaths?: readonly string[]): string[] {
    return (excludePaths ?? []).map((entry) => path.resolve(workspaceDir, entry));
  }

  private isExcluded(absolutePath: string, excludePaths: readonly string[]): boolean {
    return excludePaths.some((excluded) => this.isUnder(absolutePath, excluded));
  }

  /** `path.relative`-based containment: a string prefix would let `plans-2` match `plans`. */
  private isUnder(candidate: string, parent: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  private digestRoot(
    workspaceDir: string,
    root: string,
    excludePaths: readonly string[]
  ): WorkspaceMutationRootDigest {
    const absoluteRoot = path.resolve(workspaceDir, root);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(absoluteRoot);
    } catch {
      return { root, digest: ABSENT_ROOT_DIGEST, fileCount: 0 };
    }

    // A symlinked root is not followed: a walk is not allowed to leave the tree.
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return { root, digest: ABSENT_ROOT_DIGEST, fileCount: 0 };
    }

    const inventory: string[] = [];
    this.walk(absoluteRoot, workspaceDir, excludePaths, inventory);

    inventory.sort();
    const digest = crypto.createHash('sha256').update(inventory.join('\n')).digest('hex');
    return { root, digest, fileCount: inventory.length };
  }

  private walk(
    directory: string,
    workspaceDir: string,
    excludePaths: readonly string[],
    inventory: string[]
  ): void {
    if (inventory.length >= WORKSPACE_MUTATION_MAX_FILES_PER_ROOT) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (inventory.length >= WORKSPACE_MUTATION_MAX_FILES_PER_ROOT) {
        return;
      }
      const absolute = path.join(directory, entry.name);

      // `path.relative` exclusion, never a string prefix (§2.5.9).
      if (this.isExcluded(absolute, excludePaths)) {
        continue;
      }
      if (TOOL_STATE_PREFIXES.some((prefix) => this.isUnder(absolute, path.join(workspaceDir, prefix)))) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Never follow a symlink: the walk must not escape its root.
        continue;
      }
      if (entry.isDirectory()) {
        this.walk(absolute, workspaceDir, excludePaths, inventory);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      let fileStats: fs.Stats;
      try {
        fileStats = fs.lstatSync(absolute);
      } catch {
        continue;
      }
      const relative = path.relative(workspaceDir, absolute).split(path.sep).join('/');
      inventory.push(`${relative}\0${fileStats.size}\0${fileStats.mtimeMs}`);
    }
  }

  /**
   * The tracked/untracked working tree, or `null` when it could not be measured.
   *
   * `null` is deliberately distinct from `[]`: "unmeasured" must never compare
   * equal to "clean".
   */
  private async readTrackedEntries(
    workspaceDir: string,
    excludePaths: readonly string[]
  ): Promise<readonly TrackedEntry[] | null> {
    let result;
    try {
      result = await this.commandExecutor.execute('git status --porcelain -z', {
        cwd: workspaceDir
      });
    } catch {
      return null;
    }
    if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') {
      return null;
    }

    const records = result.stdout.split('\0');
    const entries: TrackedEntry[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record || record.length < 4) {
        continue;
      }
      const status = record.slice(0, 2);
      const relativePath = record.slice(3);
      // A rename/copy emits `<new>\0<old>\0`; the second record is the source
      // path, not a second write.
      if (status.startsWith('R') || status.startsWith('C')) {
        index++;
      }
      if (!relativePath) {
        continue;
      }
      if (this.isToolState(relativePath)) {
        continue;
      }
      if (this.isExcluded(path.resolve(workspaceDir, relativePath), excludePaths)) {
        continue;
      }
      entries.push({ path: relativePath.split('\\').join('/'), status });
    }
    return entries;
  }

  private isToolState(relativePath: string): boolean {
    const normalised = relativePath.split('\\').join('/');
    return TOOL_STATE_PREFIXES.some(
      (prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`)
    );
  }

  private async compareTrackedEntries(
    workspaceDir: string,
    baselineEntries: readonly TrackedEntry[] | null,
    excludePaths: readonly string[]
  ): Promise<readonly StageFinding[]> {
    if (baselineEntries === null) {
      // The reference was not measured, so no tracked claim may be made.
      return [];
    }

    const current = await this.readTrackedEntries(workspaceDir, excludePaths);
    if (current === null) {
      return [];
    }

    const baselineByPath = new Map(baselineEntries.map((entry) => [entry.path, entry.status]));
    const currentByPath = new Map(current.map((entry) => [entry.path, entry.status]));
    const findings: StageFinding[] = [];

    for (const [entryPath, status] of currentByPath) {
      const previous = baselineByPath.get(entryPath);
      if (previous === status) {
        continue;
      }
      findings.push({
        rule: STAGE_FINDING_RULE_TRACKED_WRITE_OUTSIDE_SCOPE,
        path: entryPath,
        detail: previous === undefined ? `new ${status} write outside the plan directory` : `changed outside the plan directory`
      });
      if (findings.length >= WORKSPACE_MUTATION_MAX_REPORTED_PATHS) {
        return findings;
      }
    }

    // A deletion is a write too: the path is gone from the current porcelain set.
    for (const [entryPath] of baselineByPath) {
      if (currentByPath.has(entryPath)) {
        continue;
      }
      findings.push({
        rule: STAGE_FINDING_RULE_TRACKED_WRITE_OUTSIDE_SCOPE,
        path: entryPath,
        detail: 'deleted outside the plan directory'
      });
      if (findings.length >= WORKSPACE_MUTATION_MAX_REPORTED_PATHS) {
        return findings;
      }
    }

    return findings;
  }
}
