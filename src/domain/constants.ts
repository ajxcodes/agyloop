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

export const STAGES = Object.freeze({
  INITIALIZED: STAGE_INITIALIZED,
  DISCOVERY: STAGE_DISCOVERY,
  PLAN: STAGE_PLAN,
  APPROVAL: STAGE_APPROVAL,
  IMPLEMENT: STAGE_IMPLEMENT,
  QUALITY_GATE: STAGE_QUALITY_GATE,
  REVIEW: STAGE_REVIEW,
  COMMIT: STAGE_COMMIT,
  COMPLETED: STAGE_COMPLETED
});

export type StageName = typeof STAGES[keyof typeof STAGES];

export const ALLOWED_TRANSITIONS: Readonly<Record<StageName, readonly StageName[]>> = Object.freeze({
  [STAGE_INITIALIZED]: Object.freeze([STAGE_DISCOVERY]),
  [STAGE_DISCOVERY]: Object.freeze([STAGE_PLAN]),
  [STAGE_PLAN]: Object.freeze([STAGE_APPROVAL, STAGE_IMPLEMENT]), // IMPLEMENT allowed only in YOLO mode
  [STAGE_APPROVAL]: Object.freeze([STAGE_IMPLEMENT, STAGE_PLAN]), // PLAN allowed if re-planning requested
  [STAGE_IMPLEMENT]: Object.freeze([STAGE_QUALITY_GATE]),
  [STAGE_QUALITY_GATE]: Object.freeze([STAGE_REVIEW, STAGE_IMPLEMENT]), // IMPLEMENT allowed if gates fail
  [STAGE_REVIEW]: Object.freeze([STAGE_COMMIT, STAGE_IMPLEMENT]), // IMPLEMENT allowed if review changes required
  [STAGE_COMMIT]: Object.freeze([STAGE_COMPLETED]),
  [STAGE_COMPLETED]: Object.freeze([STAGE_INITIALIZED]) // Can start next task
});

export const MODE_STANDARD = 'standard' as const;
export const MODE_PLAN = 'plan' as const;
export const MODE_IMPLEMENT = 'implement' as const;
export const MODE_GATES = 'gates' as const;
export const MODE_YOLO = 'yolo' as const;

export const EXECUTION_MODES = Object.freeze({
  STANDARD: MODE_STANDARD,
  PLAN: MODE_PLAN,
  IMPLEMENT: MODE_IMPLEMENT,
  GATES: MODE_GATES,
  YOLO: MODE_YOLO
});

export type ExecutionMode = typeof EXECUTION_MODES[keyof typeof EXECUTION_MODES];

export const ROLE_PLANNER = 'planner' as const;
export const ROLE_IMPLEMENTER = 'implementer' as const;
export const ROLE_GATE = 'gate' as const;
export const ROLE_REVIEWER = 'reviewer' as const;

export const SUBAGENT_ROLES = Object.freeze({
  PLANNER: ROLE_PLANNER,
  IMPLEMENTER: ROLE_IMPLEMENTER,
  GATE: ROLE_GATE,
  REVIEWER: ROLE_REVIEWER
});

export type SubagentRoleName = typeof SUBAGENT_ROLES[keyof typeof SUBAGENT_ROLES];

export const ROLE_TITLE_PLANNER = 'Architectural Planning Subagent' as const;
export const ROLE_TITLE_IMPLEMENTER = 'Code Implementation Subagent' as const;
export const ROLE_TITLE_GATE = 'Quality Gate Verification Subagent' as const;
export const ROLE_TITLE_REVIEWER = 'AI Reviewer Subagent' as const;

export const ROLE_DESC_PLANNER =
  'Architectural reasoning, deep read-only inspection, and specification generation subagent' as const;
export const ROLE_DESC_IMPLEMENTER =
  'Precise code implementation, refactoring, test authoring, and build verification subagent' as const;

export const TIER_INHERIT = 'inherit' as const;
export const TIER_FLASH_LITE = 'flash_lite' as const;
export const TIER_FLASH = 'flash' as const;
export const TIER_PRO = 'pro' as const;

export const MODEL_TIERS = Object.freeze([
  TIER_INHERIT,
  TIER_FLASH_LITE,
  TIER_FLASH,
  TIER_PRO
] as const);

export type ModelTierName = typeof MODEL_TIERS[number];

export const MODEL_GEMINI_2_5_PRO = 'gemini-2.5-pro' as const;
export const MODEL_GEMINI_3_5_PRO = 'gemini-3.5-pro' as const;
export const MODEL_GEMINI_3_5_FLASH = 'gemini-3.5-flash' as const;
export const MODEL_GEMINI_2_5_FLASH = 'gemini-2.5-flash' as const;
export const MODEL_GEMINI_3_5_FLASH_LITE = 'gemini-3.5-flash-lite' as const;
export const MODEL_GEMINI_2_5_FLASH_LITE = 'gemini-2.5-flash-lite' as const;

export const STATIC_MODELS = Object.freeze({
  [TIER_PRO]: Object.freeze({
    default: MODEL_GEMINI_2_5_PRO,
    candidates: Object.freeze([MODEL_GEMINI_2_5_PRO, MODEL_GEMINI_3_5_PRO])
  }),
  [TIER_FLASH]: Object.freeze({
    default: MODEL_GEMINI_3_5_FLASH,
    candidates: Object.freeze([MODEL_GEMINI_3_5_FLASH, MODEL_GEMINI_2_5_FLASH])
  }),
  [TIER_FLASH_LITE]: Object.freeze({
    default: MODEL_GEMINI_3_5_FLASH_LITE,
    candidates: Object.freeze([MODEL_GEMINI_3_5_FLASH_LITE, MODEL_GEMINI_2_5_FLASH_LITE])
  }),
  [TIER_INHERIT]: Object.freeze({
    default: TIER_INHERIT,
    candidates: Object.freeze([TIER_INHERIT])
  })
});

export const TOOL_VIEW_FILE = 'view_file' as const;
export const TOOL_GREP_SEARCH = 'grep_search' as const;
export const TOOL_FIND_BY_NAME = 'find_by_name' as const;
export const TOOL_LIST_DIR = 'list_dir' as const;

export const READ_ONLY_TOOLS = Object.freeze([
  TOOL_VIEW_FILE,
  TOOL_GREP_SEARCH,
  TOOL_FIND_BY_NAME,
  TOOL_LIST_DIR
] as const);

export const TOOL_WRITE_TO_FILE = 'write_to_file' as const;
export const TOOL_REPLACE_FILE_CONTENT = 'replace_file_content' as const;
export const TOOL_RUN_COMMAND = 'run_command' as const;

export const FORBIDDEN_WRITE_TOOLS = Object.freeze([
  TOOL_WRITE_TO_FILE,
  TOOL_REPLACE_FILE_CONTENT,
  TOOL_RUN_COMMAND
] as const);

export const IMPLEMENTER_TOOLS = Object.freeze([
  TOOL_VIEW_FILE,
  TOOL_GREP_SEARCH,
  TOOL_FIND_BY_NAME,
  TOOL_LIST_DIR,
  TOOL_WRITE_TO_FILE,
  TOOL_REPLACE_FILE_CONTENT,
  TOOL_RUN_COMMAND
] as const);

export const ERR_INVALID_TRANSITION = 'ERR_INVALID_TRANSITION' as const;
export const ERR_PHYSICAL_WRITE_VIOLATION = 'ERR_PHYSICAL_WRITE_VIOLATION' as const;
export const ERR_GITHUB_CONTEXT = 'ERR_GITHUB_CONTEXT' as const;
export const ERR_CONFIG_RESOLUTION = 'ERR_CONFIG_RESOLUTION' as const;
export const ERR_STATE_STORAGE = 'ERR_STATE_STORAGE' as const;
export const ERR_VALIDATION = 'ERR_VALIDATION' as const;

export const ERROR_CODES = Object.freeze({
  INVALID_TRANSITION: ERR_INVALID_TRANSITION,
  PHYSICAL_WRITE_VIOLATION: ERR_PHYSICAL_WRITE_VIOLATION,
  GITHUB_CONTEXT: ERR_GITHUB_CONTEXT,
  CONFIG_RESOLUTION: ERR_CONFIG_RESOLUTION,
  STATE_STORAGE: ERR_STATE_STORAGE,
  VALIDATION: ERR_VALIDATION
});

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// Numeric Constants & Default Invariants
export const STATE_SCHEMA_VERSION = '1.0.0' as const;
export const CLI_VERSION = '0.1.0' as const;
export const DEFAULT_GATE_TIMEOUT_SECONDS = 300 as const;
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms (24 hours)
export const EXIT_CODE_SUCCESS = 0 as const;
export const EXIT_CODE_FAILURE = 1 as const;

// Path & File Constants
export const DEFAULT_STATE_DIR = '.agyloop' as const;
export const DEFAULT_STATE_FILE = 'state.json' as const;
export const DEFAULT_PLANS_DIR = 'artifacts/plans' as const;
export const DEFAULT_SUMMARY_FILENAME = 'AgyLoop Summary.md' as const;
export const DEFAULT_TEMPLATES_DIRNAME = 'templates' as const;

// Plan Template Names
export const TEMPLATE_DISCOVERY = 'discovery-plan.md' as const;
export const TEMPLATE_IMPLEMENTATION = 'implementation-plan.md' as const;
export const TEMPLATE_SUMMARY = 'summary-log.md' as const;

export const TEMPLATE_FILES = Object.freeze({
  DISCOVERY: TEMPLATE_DISCOVERY,
  IMPLEMENTATION: TEMPLATE_IMPLEMENTATION,
  SUMMARY: TEMPLATE_SUMMARY
});

export const FILENAME_ALT_IMPLEMENTATION_PLAN = 'implementation_plan.md' as const;
export const FILENAME_ALT_DISCOVERY_PLAN = 'discovery_plan.md' as const;

export const CANDIDATE_PLAN_FILENAMES = Object.freeze([
  TEMPLATE_IMPLEMENTATION,
  FILENAME_ALT_IMPLEMENTATION_PLAN,
  TEMPLATE_DISCOVERY,
  FILENAME_ALT_DISCOVERY_PLAN
] as const);

// Summary Log Stage Names & Statuses
export const SUMMARY_STAGE_DISCOVERY = 'Discovery' as const;
export const SUMMARY_STAGE_PLAN_REVIEW = 'Plan Review' as const;
export const SUMMARY_STAGE_IMPLEMENTATION = 'Implementation' as const;
export const SUMMARY_STAGE_QUALITY_GATES = 'Quality Gates' as const;
export const SUMMARY_STAGE_AI_REVIEW = 'AI Review' as const;
export const SUMMARY_STAGE_COMMIT_PR = 'Commit / PR' as const;

export const SUMMARY_STATUS_PENDING = 'PENDING' as const;
export const SUMMARY_STATUS_IN_PROGRESS = 'IN PROGRESS' as const;
export const SUMMARY_STATUS_APPROVED = 'APPROVED' as const;
export const SUMMARY_STATUS_COMPLETED = 'COMPLETED' as const;
export const SUMMARY_STATUS_FAILED = 'FAILED' as const;

// Prompt Paths & Files
export const DEFAULT_PROMPTS_DIR = 'prompts' as const;
export const PROMPT_FILE_PLANNER = 'planner.md' as const;
export const PROMPT_FILE_IMPLEMENTER = 'implementer.md' as const;

// Transition Notes
export const NOTE_DEVELOPER_APPROVED = 'Approved by developer' as const;
export const NOTE_AUTO_APPROVED_YOLO = 'Auto-approved in YOLO mode' as const;
export const NOTE_MANUAL_TRANSITION = 'Manual CLI transition' as const;
export const NOTE_INITIATED_PLANNING = 'Initiated planning mode' as const;
export const NOTE_GENERATING_SPECS = 'Generating plan specifications' as const;
export const NOTE_AWAITING_REVIEW = 'Awaiting human review' as const;
export const NOTE_MANUAL_GATES_RUN = 'Manual gates run' as const;
