/**
 * agyloop - the TWO canonical probe doubles (issue #544 / AC2)
 *
 * Retires the spellings `DetectImplementationDiffDouble` (4 of 5 copies) and
 * `DetectImplementationDiffDouble` for the implementation-evidence probe,
 * plus the `DetectImplementationDiffDouble` copy behind the discovery-mutation boundary, which is
 * the OTHER port (`WorkspaceMutationProbePort`) — both live here so the
 * "probe" family has one home. Version options carry the retired verdict
 * fixture values (`CLEAN_DIFF`-shaped results) exactly as their suite spelled
 * them.
 */

import type { ImplementationProbe } from '../../../src/application/detect-implementation-diff';
import type {
  WorkspaceMutationProbePort,
  WorkspaceMutationSnapshotParams,
  WorkspaceMutationCompareParams
} from '../../../src/ports/workspace-mutation-probe';
type WorkspaceMutationBaseline = unknown;

/** Retires `DetectImplementationDiffDouble` + the 4 `DetectImplementationDiffDouble` copies. */
interface FakeImplementationProbeOptions {
  /** The ImplementationDiff every execute() returns. Default: clean tree. */
  result: unknown;
  /** When true, execute() throws (probe-failure fixtures). */
  throwOnExecute?: boolean;
}

class FakeImplementationProbe implements ImplementationProbe {
  public calls: Record<string, unknown[]> = { execute: [] };
  public executeInputs: Array<unknown> = [];
  public result: unknown;
  public throwOnExecute: boolean;

  constructor(options?: FakeImplementationProbeOptions) {
    this.result = options?.result ?? {
      hasChanges: false,
      baseRef: 'main',
      trackedChangedFiles: [],
      untrackedFiles: [],
      probeError: null
    };
    this.throwOnExecute = options?.throwOnExecute ?? false;
  }

  public fromResult(result: unknown): FakeImplementationProbe {
    this.result = result;
    return this;
  }

  public async execute(params?: { workspaceDir?: string; baseRef?: string | null }): Promise<never> {
    this.calls.execute.push([params]);
    this.executeInputs.push(params);
    if (this.throwOnExecute) {
      throw new Error('probe crashed');
    }
    return this.result as never;
  }
}

/** Retires the `DetectImplementationDiffDouble` copy in discovery-mutation-boundary.test.ts. */
class FakeWorkspaceMutationProbe implements WorkspaceMutationProbePort {
  public calls: Record<string, unknown[]> = { snapshot: [], compare: [] };

  public readonly snapshotCalls: Array<WorkspaceMutationSnapshotParams> = [];
  public readonly compareCalls: Array<WorkspaceMutationCompareParams> = [];
  /** Findings the NEXT compare() returns (queue-init). Default none. */
  public nextFindings: readonly unknown[] = [];

  constructor(options: { nextFindings?: readonly unknown[] } = {}) {
    this.nextFindings = options.nextFindings ?? [];
  }

  public async snapshot(params: WorkspaceMutationSnapshotParams): Promise<never> {
    this.calls.snapshot.push([params]);
    this.snapshotCalls.push(params);
    return {
      workspaceDir: params.workspaceDir,
      capturedAt: new Date().toISOString(),
      roots: [],
      trackedEntries: []
    } as never;
  }

  public async compare(params: WorkspaceMutationCompareParams): Promise<never> {
    this.calls.compare.push([params]);
    this.compareCalls.push(params);
    return this.nextFindings as never;
  }
}

module.exports = { FakeImplementationProbe, FakeWorkspaceMutationProbe };
