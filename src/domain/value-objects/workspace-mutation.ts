/**
 * agyloop - Workspace Mutation Value Objects (Domain Layer)
 *
 * The DISCOVERY scoped-write boundary (issue #389) is an invariant, not prose:
 * a discovery stage may READ anything but may only WRITE inside its plan
 * directory. Before this module the rule was stated in the dispatch prompt and
 * never measured, so a host rebuild of the repository-root `dist/` — `git
 * status --porcelain` is clean for an ignored build artefact — was invisible.
 *
 * This module owns the pure vocabulary of that measurement:
 *
 * - `StageFinding` is one measured boundary violation, reported to the
 *   orchestrator instead of being swallowed;
 * - `WorkspaceMutationBaseline` is the dispatch-time reference the next read is
 *   compared against, so a pre-existing dirty tree is the reference and never a
 *   violation.
 *
 * No I/O: the filesystem walk and `git status` live in the infrastructure
 * adapter (`FileWorkspaceMutationProbe`), and the comparison rule lives here so
 * the domain can be read without an adapter.
 */

/** A watched root changed (or was created/deleted) outside the plan directory. */
export const STAGE_FINDING_RULE_WRITE_OUTSIDE_SCOPE = 'write-outside-scope' as const;

/** A tracked or untracked working-tree path was written outside the plan directory. */
export const STAGE_FINDING_RULE_TRACKED_WRITE_OUTSIDE_SCOPE =
  'tracked-write-outside-scope' as const;

/**
 * One measured write outside the stage's sanctioned scope.
 *
 * `path` is the operator-facing identity: `dist/` for a watched root (with a
 * trailing slash so it reads as a root) and the repository-relative path for a
 * tracked write (`README.md`).
 */
export interface StageFinding {
  readonly rule: string;
  readonly path: string;
  readonly detail: string;
}

/**
 * The digest of ONE watched root, captured at dispatch.
 *
 * A missing root digests as `'absent'` rather than being omitted, so "the root
 * was created during the run" is distinguishable from "the root was not
 * watched" — both would otherwise compare equal to nothing.
 */
export interface WorkspaceMutationRootDigest {
  readonly root: string;
  /** sha256 of the sorted `path\0size\0mtimeMs` inventory; `'absent'` when missing. */
  readonly digest: string;
  readonly fileCount: number;
}

/**
 * The dispatch-time reference for one DISCOVERY round.
 *
 * `workspaceDir` is absolute: a baseline captured in one checkout must never be
 * compared against another (`next` measures `process.cwd()`), because a
 * cross-directory comparison invents findings instead of measuring them.
 *
 * `trackedEntries` is `null` when the tracked set could not be measured, which
 * is deliberately DIFFERENT from `[]` (measured clean): "unmeasured" must never
 * be reported as "clean".
 */
export interface WorkspaceMutationBaseline {
  readonly workspaceDir: string;
  readonly capturedAt: string;
  readonly roots: readonly WorkspaceMutationRootDigest[];
  readonly trackedEntries: readonly { readonly path: string; readonly status: string }[] | null;
}

/** True when `value` is a structurally usable baseline. */
export function isWorkspaceMutationBaseline(value: unknown): value is WorkspaceMutationBaseline {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<WorkspaceMutationBaseline>;
  if (typeof candidate.workspaceDir !== 'string' || candidate.workspaceDir.length === 0) {
    return false;
  }
  if (typeof candidate.capturedAt !== 'string' || candidate.capturedAt.length === 0) {
    return false;
  }
  if (!Array.isArray(candidate.roots)) {
    return false;
  }
  const rootsValid = candidate.roots.every(
    (root) =>
      root &&
      typeof root === 'object' &&
      typeof (root as WorkspaceMutationRootDigest).root === 'string' &&
      typeof (root as WorkspaceMutationRootDigest).digest === 'string' &&
      typeof (root as WorkspaceMutationRootDigest).fileCount === 'number'
  );
  if (!rootsValid) {
    return false;
  }
  if (candidate.trackedEntries === null) {
    return true;
  }
  if (!Array.isArray(candidate.trackedEntries)) {
    return false;
  }
  return candidate.trackedEntries.every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { path?: unknown }).path === 'string' &&
      typeof (entry as { status?: unknown }).status === 'string'
  );
}
