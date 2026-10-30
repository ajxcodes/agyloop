/**
 * agyloop - WorkspaceMutationProbePort Interface
 *
 * Inversion of control contract for measuring writes outside a stage's
 * sanctioned scope (issue #389). DISCOVERY may read anything but may only write
 * inside its plan directory; this port captures a dispatch-time BASELINE and
 * compares the same workspace against it on the next read.
 *
 * The baseline-relative design is the contract, not an implementation detail: a
 * pre-existing dirty tree (an already-built `dist/`, a teammate's edit) is the
 * reference and is never reported as a violation.
 */

import type { StageFinding, WorkspaceMutationBaseline } from '../domain';

export interface WorkspaceMutationSnapshotParams {
  /** The workspace to measure. Resolved to an absolute path by the adapter. */
  readonly workspaceDir: string;
  /** Absolute or workspace-relative paths that are NEVER a finding. */
  readonly excludePaths?: readonly string[];
  /** Overrides the watched roots; defaults to `WORKSPACE_MUTATION_WATCHED_ROOTS`. */
  readonly roots?: readonly string[];
}

export interface WorkspaceMutationCompareParams {
  readonly workspaceDir: string;
  readonly baseline: WorkspaceMutationBaseline;
  readonly excludePaths?: readonly string[];
}

export interface WorkspaceMutationProbePort {
  /** Captures the reference every later comparison in this round is measured against. */
  snapshot(params: WorkspaceMutationSnapshotParams): Promise<WorkspaceMutationBaseline>;

  /**
   * Returns one finding per change measured against `baseline`.
   *
   * An empty array means "measured, nothing changed" — never "could not
   * measure": an unmeasurable baseline or a different workspace also returns
   * `[]`, because a violation that was not observed must not be invented.
   */
  compare(params: WorkspaceMutationCompareParams): Promise<readonly StageFinding[]>;
}
