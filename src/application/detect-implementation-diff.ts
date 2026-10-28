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
 * Issue #263: the branch-relative signal measures the **merge-base** (the
 * branch point), never the base ref's current tip. `git diff <baseRef>` is a
 * two-dot diff: in a worktree branched at X whose base has since advanced to
 * Y, it reports the base's own new commits — reversed — as an implementation.
 * The branch point is what "what this branch added" means, and it covers both
 * committed and uncommitted tracked changes in one measurement.
 *
 * The probe distinguishes two failure states:
 * - `probeError`   — the tree could not be READ (`git status` failed);
 * - `measurementError` — the branch's own changes could not be MEASURED
 *   (no merge-base, the diff failed). Never fabricated into "0 changes".
 *
 * Strict Hexagonal Architecture: zero direct I/O — the git calls go through
 * `CommandExecutorPort`.
 */

import { isImplementationEvidencePath, shellQuote } from '../domain';
import { CommandExecutionResult, CommandExecutorPort } from '../ports';

/**
 * The verdict of the implementation-evidence probe.
 */
export interface ImplementationDiff {
  /** True when at least one non-noise change exists relative to the branch point. */
  readonly hasChanges: boolean;
  /** The base reference the measurement was made against ('main', …). */
  readonly baseRef: string;
  /** Tracked modifications relative to the branch point (committed + uncommitted). */
  readonly trackedChangedFiles: readonly string[];
  /** Untracked, non-ignored files that survived the noise filter. */
  readonly untrackedFiles: readonly string[];
  /** Human-readable reason the probe could not produce a verdict (null = ok). */
  readonly probeError: string | null;
  /**
   * The branch's own changes could not be MEASURED: the merge-base could not
   * be resolved, or the merge-base-relative diff failed. This is NOT the same
   * fact as `probeError` — the tree was readable, but the branch-relative
   * comparison is unavailable, so no "unchanged relative to the base" claim
   * may be made. `undefined` is identical to `null` (unknown).
   */
  readonly measurementError?: string | null;
  /** The resolved branch point (full SHA); null when unresolved. */
  readonly mergeBase?: string | null;
  /** Commits on the base ref since the branch point (0 = up to date); null = unknown. */
  readonly baseAheadCommits?: number | null;
  /** Commits on HEAD since the branch point (the branch's own work); null = unknown. */
  readonly ownCommits?: number | null;
  /** The raw probe output, for the operator-facing diagnostic block. */
  readonly rawStatus: string;
}

/** The reference used when the caller supplies none. */
const DEFAULT_BASE_REF = 'main';

/**
 * The structural interface of the implementation-evidence probe (issue #327).
 *
 * `GetNextActionUseCase` depends on THIS, not on the concrete use case, so an
 * application test can inject a probe without a nominal class dependency and
 * the CLI can pass the real one (`new DetectImplementationDiffUseCase(...)`).
 */
export interface ImplementationProbe {
  execute(params?: {
    workspaceDir?: string;
    baseRef?: string | null;
  }): Promise<ImplementationDiff>;
}

/**
 * A resolved branch point must be a commit SHA. An empty or non-SHA value is
 * NEVER interpolated: `git diff --name-only  -- .` (the empty interpolation)
 * SUCCEEDS and silently compares the index against the working tree.
 */
const MERGE_BASE_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/** The result of measuring the branch's own changes against its branch point. */
interface BranchMeasurement {
  /** Tracked paths that differ between the branch point and the working tree. */
  files: string[];
  /** The resolved branch point SHA, or null when it could not be resolved. */
  mergeBase: string | null;
  /** Commits on the base ref since the branch point; null = unknown. */
  baseAheadCommits: number | null;
  /** Commits on HEAD since the branch point; null = unknown. */
  ownCommits: number | null;
  /** Human-readable reason the branch diff could not be measured (null = ok). */
  error: string | null;
}

/** Returns the first line of a command's stdout, or '' when there is none. */
function firstLine(stdout: string | undefined): string {
  if (typeof stdout !== 'string') {
    return '';
  }
  return stdout.split('\n')[0].replace(/\r$/, '');
}

/**
 * Parses `git rev-list --count` output.
 *
 * A count that cannot be read is `null` (unknown) — never `0`, which would
 * claim the branch is up to date on absent information.
 */
function parseCount(stdout: string | undefined): number | null {
  const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

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

export class DetectImplementationDiffUseCase implements ImplementationProbe {
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

    // Probe 2 — the branch-relative signal: the branch's own changes,
    // committed AND uncommitted, measured from the BRANCH POINT (issue #263).
    const measurement = await this.measureBranchChanges(workspaceDir, requestedBaseRef);

    const trackedChangedFiles = this.mergePaths(trackedFromStatus, measurement.files);
    const untracked = this.mergePaths([], untrackedFiles);

    return {
      hasChanges: trackedChangedFiles.length > 0 || untracked.length > 0,
      // Never a fabricated label: when the branch diff is unmeasurable the
      // requested ref is still the truth about what was asked for, and
      // `measurementError` explains why it could not be measured.
      baseRef: requestedBaseRef,
      trackedChangedFiles,
      untrackedFiles: untracked,
      probeError: null,
      measurementError: measurement.error,
      mergeBase: measurement.mergeBase,
      baseAheadCommits: measurement.baseAheadCommits,
      ownCommits: measurement.ownCommits,
      rawStatus
    };
  }

  /**
   * Measures the branch's own changes against its branch point (issue #263).
   *
   * The command sequence is fixed:
   *   1. `git merge-base HEAD <baseRef>`       → the branch point (validated SHA)
   *   2. `git diff --name-only <sha> -- .`     → committed + uncommitted tracked
   *   3. `git rev-list --count <sha>..HEAD`    → ownCommits
   *   4. `git rev-list --count <sha>..<baseRef>` → baseAheadCommits
   *
   * Steps 3-4 are supplementary: a failure there is an unknown count, not a
   * measurement error. Step 1 failing means the branch diff CANNOT be
   * measured — steps 2-4 are never attempted, because no honest comparison
   * exists without a branch point.
   */
  private async measureBranchChanges(
    workspaceDir: string,
    baseRef: string
  ): Promise<BranchMeasurement> {
    const quoted = shellQuote(baseRef);
    const mergeBaseCommand = `git merge-base HEAD ${quoted}`;
    const mergeBaseResult = await this.executeGit(mergeBaseCommand, workspaceDir);
    const mergeBase = mergeBaseResult ? firstLine(mergeBaseResult.stdout).trim() : '';

    if (!MERGE_BASE_SHA_PATTERN.test(mergeBase)) {
      return {
        files: [],
        mergeBase: null,
        baseAheadCommits: null,
        ownCommits: null,
        error: `${mergeBaseCommand} could not resolve the branch point for '${baseRef}'`
      };
    }

    const diffCommand = `git diff --name-only ${mergeBase} -- .`;
    const diffResult = await this.executeGit(diffCommand, workspaceDir);
    if (!diffResult) {
      return {
        files: [],
        mergeBase,
        baseAheadCommits: null,
        ownCommits: null,
        error: `${diffCommand} could not measure the branch's own changes`
      };
    }

    const files: string[] = [];
    for (const rawLine of diffResult.stdout.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!isDiffPathLine(line)) {
        continue;
      }
      const path = normalizePorcelainPath(line);
      if (path && isImplementationEvidencePath(path, false)) {
        files.push(path);
      }
    }

    const ownCommitsResult = await this.executeGit(
      `git rev-list --count ${mergeBase}..HEAD`,
      workspaceDir
    );
    const baseAheadResult = await this.executeGit(
      `git rev-list --count ${mergeBase}..${quoted}`,
      workspaceDir
    );

    return {
      files,
      mergeBase,
      ownCommits: ownCommitsResult ? parseCount(ownCommitsResult.stdout) : null,
      baseAheadCommits: baseAheadResult ? parseCount(baseAheadResult.stdout) : null,
      error: null
    };
  }

  /**
   * Runs one git command. Returns null when the executor threw OR the command
   * exited non-zero — the caller decides whether that is an expected outcome.
   */
  private async executeGit(
    command: string,
    workspaceDir: string
  ): Promise<CommandExecutionResult | null> {
    let result: CommandExecutionResult;
    try {
      result = await this.commandExecutor.execute(command, { cwd: workspaceDir });
    } catch {
      return null;
    }

    if (!result || result.exitCode !== 0) {
      return null;
    }

    return result;
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
      measurementError: null,
      mergeBase: null,
      baseAheadCommits: null,
      ownCommits: null,
      rawStatus
    };
  }
}
