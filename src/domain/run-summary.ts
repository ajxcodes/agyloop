/* eslint-disable @typescript-eslint/no-unused-vars */
import { STAGE_APPROVAL, STAGE_PLAN } from './lifecycle-stages';


// Summary Log Stage Names & Statuses
export const SUMMARY_STAGE_DISCOVERY = 'Discovery' as const;

export const SUMMARY_STAGE_PLAN_REVIEW = 'Plan Review' as const;

/**
 * The APPROVAL human gate's own row (issue #376, AC15).
 *
 * `STAGE_PLAN` and `STAGE_APPROVAL` both mapped onto `Plan Review`, so the gate
 * that actually PAUSED the run had no row at all and its consumed wait vanished
 * from the table. The row is dedicated and carries only the wait that gate
 * consumed — never the cumulative `totalHumanWaitMs`.
 */
export const SUMMARY_STAGE_PLAN_APPROVAL = 'Plan Approval' as const;

export const SUMMARY_STAGE_IMPLEMENTATION = 'Implementation' as const;

export const SUMMARY_STAGE_QUALITY_GATES = 'Quality Gates' as const;

export const SUMMARY_STAGE_AI_REVIEW = 'AI Review' as const;

export const SUMMARY_STAGE_COMMIT_PR = 'Commit / PR' as const;


export const SUMMARY_STATUS_PENDING = 'PENDING' as const;

export const SUMMARY_STATUS_IN_PROGRESS = 'IN PROGRESS' as const;

export const SUMMARY_STATUS_APPROVED = 'APPROVED' as const;

export const SUMMARY_STATUS_COMPLETED = 'COMPLETED' as const;

export const SUMMARY_STATUS_FAILED = 'FAILED' as const;

/**
 * A stage the operator deliberately bypassed (issue #284).
 *
 * Terminal, like `COMPLETED` — never `IN PROGRESS`. A skipped stage must never
 * be reported as one that ran (the same evidence-integrity rule the gate
 * channel enforces).
 */
export const SUMMARY_STATUS_SKIPPED = 'SKIPPED' as const;

/**
 * The status of a stage whose evidence was never filed (issue #284).
 *
 * The summary must never print `PENDING` for a stage the run has already left:
 * "we have no record" and "it has not started" are different statements, and
 * only the second one is ever true of a row the run has moved past.
 */
export const SUMMARY_STATUS_NOT_RECORDED = 'NOT RECORDED' as const;
