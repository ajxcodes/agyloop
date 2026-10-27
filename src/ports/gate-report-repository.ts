/**
 * agyloop - GateReportRepositoryPort (issue #284)
 *
 * Persists the dispatched gate subagent's evidence block beside the checkpoint,
 * so `codeloop transition REVIEW` can ingest a record produced by the stage
 * that performed the work instead of re-deriving one from ambient state.
 *
 * The evidence file is CONSUMED on ingest: one filed report certifies exactly
 * one gate round, so a stale PASSED can never certify a later failure.
 */

import { GateResultReport } from '../domain';

export interface GateReportRepositoryPort {
  /** The report filed for this issue, or `null` when none is readable. */
  load(issue: number | string | null): GateResultReport | null;

  /** Persists the report and returns the absolute path it was written to. */
  save(issue: number | string | null, report: GateResultReport): string;

  /** Removes any filed report (consume-on-ingest). */
  clear(issue: number | string | null): void;
}
