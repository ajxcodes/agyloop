/* eslint-disable @typescript-eslint/no-unused-vars */

export const ROLE_PLANNER = 'planner' as const;

export const ROLE_DISCOVERY = 'discovery' as const;

export const ROLE_IMPLEMENTER = 'implementer' as const;

export const ROLE_GATE = 'gate' as const;

export const ROLE_REVIEWER = 'reviewer' as const;

export const ROLE_TRIAGE = 'triage' as const;


export const SUBAGENT_ROLES = Object.freeze({
  PLANNER: ROLE_PLANNER,
  DISCOVERY: ROLE_DISCOVERY,
  IMPLEMENTER: ROLE_IMPLEMENTER,
  GATE: ROLE_GATE,
  REVIEWER: ROLE_REVIEWER,
  TRIAGE: ROLE_TRIAGE
});


export type SubagentRoleName = typeof SUBAGENT_ROLES[keyof typeof SUBAGENT_ROLES];


export const ROLE_TITLE_PLANNER = 'Architectural Planning Subagent' as const;

export const ROLE_TITLE_DISCOVERY = 'Discovery Subagent' as const;

export const ROLE_TITLE_IMPLEMENTER = 'Code Implementation Subagent' as const;

export const ROLE_TITLE_GATE = 'Quality Gate Verification Subagent' as const;

export const ROLE_TITLE_REVIEWER = 'AI Reviewer Subagent' as const;

export const ROLE_TITLE_TRIAGE = 'Triage Subagent' as const;


export const ROLE_DESC_PLANNER =
  'Architectural reasoning, deep read-only inspection, and specification generation subagent' as const;

export const ROLE_DESC_DISCOVERY =
  'Defect discovery, root-cause analysis, and edge-case investigation subagent' as const;

export const ROLE_DESC_IMPLEMENTER =
  'Precise code implementation, refactoring, test authoring, and build verification subagent' as const;

export const ROLE_DESC_GATE =
  'Automated build, test suite, typecheck, and lint verification subagent executing in isolated shell execution' as const;

export const ROLE_DESC_REVIEWER =
  'Standards compliance, code quality, and acceptance criteria review subagent' as const;

export const ROLE_DESC_TRIAGE =
  'PR review comment triage and pipeline routing subagent' as const;
