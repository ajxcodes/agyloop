/* eslint-disable @typescript-eslint/no-unused-vars */
import type { StageFinding } from './value-objects/workspace-mutation';
import type { LIFECYCLE_GATES } from './vocabulary';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _vocab = () => require('./vocabulary');

/**
 * agyloop - Domain Constants
 *
 * Centralized, immutable definitions for stages, transitions, subagents,
 * model tiers, tools, error codes, and default thresholds.
 * Strictly avoids magic strings and magic numbers across the entire system.
 */


export const STAGE_NONE = 'NONE' as const;

export const STAGE_INITIALIZED = 'INITIALIZED' as const;

export const STAGE_DISCOVERY = 'DISCOVERY' as const;

export const STAGE_PLAN = 'PLAN' as const;

export const STAGE_APPROVAL = 'APPROVAL' as const;

export const STAGE_IMPLEMENT = 'IMPLEMENT' as const;

export const STAGE_QUALITY_GATE = 'QUALITY_GATE' as const;

export const STAGE_REVIEW = 'REVIEW' as const;

export const STAGE_COMMIT = 'COMMIT' as const;

export const STAGE_COMPLETED = 'COMPLETED' as const;

export const STAGE_TRIAGE = 'TRIAGE' as const;


export const STAGES = Object.freeze({
  INITIALIZED: STAGE_INITIALIZED,
  DISCOVERY: STAGE_DISCOVERY,
  PLAN: STAGE_PLAN,
  APPROVAL: STAGE_APPROVAL,
  IMPLEMENT: STAGE_IMPLEMENT,
  QUALITY_GATE: STAGE_QUALITY_GATE,
  REVIEW: STAGE_REVIEW,
  COMMIT: STAGE_COMMIT,
  COMPLETED: STAGE_COMPLETED,
  TRIAGE: STAGE_TRIAGE
});


export type StageName = typeof STAGES[keyof typeof STAGES];


/**
 * Which lifecycle sources may reach which lifecycle targets.
 *
 * `COMPLETED` is intentionally reachable ONLY from `COMMIT` and `TRIAGE` — the two
 * verified pipeline ends, both of which have passed `QUALITY_GATE` and `REVIEW`.
 * The honest restore path from `COMPLETED` back to itself is
 * `COMPLETED -> REVIEW -> COMMIT -> COMPLETED` (3 legal hops, per COMPLETED's own
 * target list below), so an operator who genuinely completed a task can always
 * return to a COMPLETED checkpoint without widening this table.
 *
 * Widening it (e.g. adding `COMPLETED` to IMPLEMENT's targets) was deliberately
 * rejected: it would make `codeloop transition COMPLETED` a one-keystroke way to
 * mark unverified, uncommitted work as complete, which `skills/agyloop/SKILL.md`
 * forbids. Entering COMPLETED is bookkeeping, never a worktree teardown — see
 * `src/application/lifecycle-reentry-policy.ts` and issue #237.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<StageName, readonly StageName[]>> = Object.freeze({
  [STAGE_INITIALIZED]: Object.freeze([STAGE_DISCOVERY, STAGE_PLAN, STAGE_TRIAGE]),
  [STAGE_DISCOVERY]: Object.freeze([STAGE_PLAN, STAGE_TRIAGE]),
  [STAGE_PLAN]: Object.freeze([STAGE_APPROVAL, STAGE_IMPLEMENT, STAGE_TRIAGE]), // IMPLEMENT allowed only in YOLO mode
  [STAGE_APPROVAL]: Object.freeze([STAGE_IMPLEMENT, STAGE_PLAN, STAGE_TRIAGE]), // PLAN allowed if re-planning requested
  // PLAN is a supported recovery target (issue #267): the blank-plan park at
  // IMPLEMENT tells the operator to re-plan, and the planner payload is produced
  // at PLAN. Without this entry the instruction could not be carried out.
  [STAGE_IMPLEMENT]: Object.freeze([STAGE_QUALITY_GATE, STAGE_PLAN, STAGE_TRIAGE]),
  // PLAN is a supported recovery target (issue #327, Defect 2): a gate that
  // refuses to certify a plan must be able to send the run back to planning.
  // The "Protocol Not Executable" / "Plan Integrity" blockers prescribe
  // re-planning, and without this entry that instruction could not be carried
  // out. Mirrors the #267 precedent (`IMPLEMENT -> PLAN`). APPROVAL stays
  // illegal on purpose: approving again without a planning pass would silently
  // re-approve the broken bytes.
  [STAGE_QUALITY_GATE]: Object.freeze([STAGE_REVIEW, STAGE_IMPLEMENT, STAGE_PLAN, STAGE_TRIAGE]), // IMPLEMENT allowed if gates fail
  [STAGE_REVIEW]: Object.freeze([STAGE_COMMIT, STAGE_IMPLEMENT, STAGE_TRIAGE]), // IMPLEMENT allowed if review changes required
  [STAGE_COMMIT]: Object.freeze([STAGE_COMPLETED, STAGE_QUALITY_GATE, STAGE_IMPLEMENT, STAGE_PLAN, STAGE_TRIAGE]),
  [STAGE_COMPLETED]: Object.freeze([
    STAGE_INITIALIZED,
    STAGE_DISCOVERY,
    STAGE_PLAN,
    STAGE_IMPLEMENT,
    STAGE_QUALITY_GATE,
    STAGE_REVIEW,
    STAGE_TRIAGE
  ]), // Can start next task or reopen for fixes/review/planning/triage
  [STAGE_TRIAGE]: Object.freeze([
    STAGE_IMPLEMENT,
    STAGE_PLAN,
    STAGE_DISCOVERY,
    STAGE_COMPLETED
  ])
});


/**
 * The lifecycle's forward order (issue #327).
 *
 * Used ONLY to disambiguate EQUALLY SHORT recovery paths: when the transition
 * table offers several legal ways back to a stage, the path that walks back to
 * the earliest stage wins, so a recovery names the walk-back an operator
 * actually performs (`REVIEW -> IMPLEMENT -> QUALITY_GATE`) rather than a
 * forward detour (`REVIEW -> COMMIT -> QUALITY_GATE`).
 */
export const LIFECYCLE_STAGE_ORDER: readonly StageName[] = Object.freeze([
  STAGE_INITIALIZED,
  STAGE_DISCOVERY,
  STAGE_PLAN,
  STAGE_APPROVAL,
  STAGE_IMPLEMENT,
  STAGE_QUALITY_GATE,
  STAGE_REVIEW,
  STAGE_COMMIT,
  STAGE_COMPLETED,
  STAGE_TRIAGE
]);


export type LifecycleGateName = typeof LIFECYCLE_GATES[keyof typeof LIFECYCLE_GATES];


export function formatTransitionCommand(
  stage: string,
  issue?: number | string | null
): string {
  if (issue === null || issue === undefined || String(issue).trim().length === 0) {
    return _vocab().TRANSITION_COMMAND_NO_ISSUE_TEMPLATE.replace('{stage}', stage);
  }
  return _vocab().TRANSITION_COMMAND_TEMPLATE.replace('{stage}', stage).replace('{issue}', String(issue));
}
