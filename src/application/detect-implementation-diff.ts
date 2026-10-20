/**
 * agyloop - DetectImplementationDiffUseCase (Application Layer)
 *
 * The ONE implementation-evidence probe (issue #259).
 *
 * `codeloop yolo` prepares an implementation but never dispatches the
 * implementer subagent, so the fast-path used to certify the UNTOUCHED
 * baseline: the gates passed, the review was skipped, and the pipeline reached
 * the COMMIT gate with an empty diff.
 *
 * This use case answers the only question that matters before the gates run:
 * "does the working tree contain an implementation?". It is deliberately a
 * *probe*, not a policy: it reports what it found and never blocks.
 *
 * Strict Hexagonal Architecture: zero direct I/O — the git calls go through
 * `CommandExecutorPort`.
 */

import { isImplementationEvidencePath } from '../domain';
import { CommandExecutorPort } from '../ports';

/**
 * The verdict of the implementation-evidence probe.
 */
export interface ImplementationDiff {
  /** True when at least one non-noise change exists relative to the base branch. */
  readonly hasChanges: boolean;
  /** The base reference the comparison was made against ('main', 'HEAD (fallback)', …). */
  readonly baseRef: string;
  /** Tracked modifications relative to the base branch (git diff --name-only). */
  readonly trackedChangedFiles: readonly string[];
  /** Untracked, non-ignored files that survived the noise filter. */
  readonly untrackedFiles: readonly string[];
  /** Human-readable reason the probe could not produce a verdict (null = ok). */
  readonly probeError: string | null;
  /** The raw probe output, for the operator-facing diagnostic block. */
  readonly rawStatus: string;
}

/** The reference used when the caller supplies none. */
const DEFAULT_BASE_REF = 'main';

/** The reported reference when the requested base ref could not be resolved. */
const HEAD_FALLBACK_REF = 'HEAD (fallback)';

/**
 * Normalizes a path as `git status --porcelain` reports it:
 * - a rename is reported as `old -> new` (the destination is the live path),
 * - a path containing special characters is quoted.
 */
function normalizePorcelainPath(rawPath: string): string {
  let normalized = rawPath.trim();

  if (normalized.includes(' -> ')) {
    const segments = normalized.split(' -> ');
    normalized = segments[segments.length - 1].trim();
  }

  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }

  return normalized;
}

/**
 * Filters the output of `git diff --name-only`.
 *
 * The command emits one path per line; anything that looks like diff CONTENT
 * (a `diff --git` header, an added/removed line, an hunk header) is not a path
 * and is dropped rather than counted as an implementation.
 */
function isDiffPathLine(line: string): boolean {
  if (!line) {
    return false;
  }
  if (line.startsWith('diff --git')) {
    return false;
  }
  if (line.startsWith('+') || line.startsWith('-') || line.startsWith('@')) {
    return false;
  }
  return true;
}

export class DetectImplementationDiffUseCase {
  private readonly commandExecutor: CommandExecutorPort;

  constructor(commandExecutor: CommandExecutorPort) {
    this.commandExecutor = commandExecutor;
  }

  public async execute(
    params: { workspaceDir?: string; baseRef?: string | null } = {}
  ): Promise<ImplementationDiff> {
    const workspaceDir = params.workspaceDir || process.cwd();
    const requestedBaseRef = (params.baseRef ?? '').trim() || DEFAULT_BASE_REF;

    // Probe 1 — the primary signal: the working tree's own status.
    let statusResult;
    try {
      statusResult = await this.commandExecutor.execute('git status --porcelain', {
        cwd: workspaceDir
      });
    } catch (err: unknown) {
      return this.failure(
        requestedBaseRef,
        `git status --porcelain failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const rawStatus = typeof statusResult?.stdout === 'string' ? statusResult.stdout : '';

    if (!statusResult || statusResult.exitCode !== 0) {
      // Fail closed: the gate must never certify a tree it could not read.
      return this.failure(
        requestedBaseRef,
        `git status --porcelain exited with code ${statusResult?.exitCode ?? 'unknown'}`,
        rawStatus
      );
    }

    const trackedFromStatus: string[] = [];
    const untrackedFiles: string[] = [];

    for (const rawLine of rawStatus.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.length < 4) {
        continue;
      }

      const statusCode = line.slice(0, 2);
      const path = normalizePorcelainPath(line.slice(3));
      if (!path) {
        continue;
      }

      if (statusCode === '??') {
        if (isImplementationEvidencePath(path, true)) {
          untrackedFiles.push(path);
        }
        continue;
      }

      if (statusCode === '!!') {
        // Ignored entry: never evidence.
        continue;
      }

      if (isImplementationEvidencePath(path, false)) {
        trackedFromStatus.push(path);
      }
    }

    // Probe 2 — the supplementary signal: work COMMITTED on the task branch.
    const trackedFromDiff = await this.collectCommittedChanges(workspaceDir, requestedBaseRef);

    const trackedChangedFiles = this.mergePaths(trackedFromStatus, trackedFromDiff.files);
    const untracked = this.mergePaths([], untrackedFiles);

    return {
      hasChanges: trackedChangedFiles.length > 0 || untracked.length > 0,
      baseRef: trackedFromDiff.baseRef,
      trackedChangedFiles,
      untrackedFiles: untracked,
      probeError: null,
      rawStatus
    };
  }

  /**
   * Runs `git diff --name-only <baseRef> -- .`.
   *
   * A non-zero exit is NOT an error: the base ref may simply not exist in this
   * repository (a `master`-defaulted repo asked for `main`). A second attempt
   * with `HEAD` then keeps the probe useful, and the effective reference is
   * reported back to the caller.
   */
  private async collectCommittedChanges(
    workspaceDir: string,
    baseRef: string
  ): Promise<{ baseRef: string; files: string[] }> {
    const requested = await this.runDiff(workspaceDir, baseRef);
    if (requested !== null) {
      return { baseRef, files: requested };
    }

    const fallback = await this.runDiff(workspaceDir, 'HEAD');
    if (fallback !== null) {
      return { baseRef: HEAD_FALLBACK_REF, files: fallback };
    }

    // Neither reference resolved: no signal, and no error either.
    return { baseRef, files: [] };
  }

  /**
   * Runs one `git diff --name-only` probe. Returns null when the reference
   * could not be resolved (non-zero exit).
   */
  private async runDiff(workspaceDir: string, baseRef: string): Promise<string[] | null> {
    let result;
    try {
      result = await this.commandExecutor.execute(
        `git diff --name-only ${baseRef} -- .`,
        { cwd: workspaceDir }
      );
    } catch {
      return null;
    }

    if (!result || result.exitCode !== 0) {
      return null;
    }

    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const files: string[] = [];

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!isDiffPathLine(line)) {
        continue;
      }
      const path = normalizePorcelainPath(line);
      if (path && isImplementationEvidencePath(path, false)) {
        files.push(path);
      }
    }

    return files;
  }

  /** Merges two path lists, preserving order and dropping duplicates. */
  private mergePaths(first: readonly string[], second: readonly string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();

    for (const path of [...first, ...second]) {
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      merged.push(path);
    }

    return merged;
  }

  /** The fail-closed verdict: nothing could be read, so nothing is evidence. */
  private failure(baseRef: string, probeError: string, rawStatus = ''): ImplementationDiff {
    return {
      hasChanges: false,
      baseRef,
      trackedChangedFiles: [],
      untrackedFiles: [],
      probeError,
      rawStatus
    };
  }
}
