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
  [STAGE_QUALITY_GATE]: Object.freeze([STAGE_REVIEW, STAGE_IMPLEMENT, STAGE_TRIAGE]), // IMPLEMENT allowed if gates fail
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

export const MODE_STANDARD = 'standard' as const;
export const MODE_PLAN = 'plan' as const;
export const MODE_IMPLEMENT = 'implement' as const;
export const MODE_COMMIT = 'commit' as const;
export const MODE_YOLO = 'yolo' as const;

export const EXECUTION_MODES = Object.freeze({
  STANDARD: MODE_STANDARD,
  PLAN: MODE_PLAN,
  IMPLEMENT: MODE_IMPLEMENT,
  COMMIT: MODE_COMMIT,
  YOLO: MODE_YOLO
});

export type ExecutionMode = typeof EXECUTION_MODES[keyof typeof EXECUTION_MODES];

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
export const DEFAULT_OPENCODE_MODEL = 'ollama/ornith:9b-128k' as const;

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

/**
 * Host-NEUTRAL capability words for a DISPATCHED prompt (issue #241, D6).
 *
 * The identifiers above are Antigravity's. A dispatched directive is executed
 * by whatever harness the operator runs — OpenCode exposes `read`/`grep`/
 * `glob`/`write`/`edit`/`shell`, not the names above — so naming one host's
 * identifiers in a directive written for another is the same defect as
 * naming a command the CLI refuses.
 *
 * These words are generic English verbs, deliberately NOT any host's tool
 * identifiers: naming `read`/`grep` would re-introduce the same defect in the
 * other direction. `formatToolProse` turns them into prose; `ToolWhitelist`
 * and the Antigravity plugin's system-prompt assets keep the identifiers.
 */
export const TOOL_CAPABILITY_READ = 'read' as const;
export const TOOL_CAPABILITY_SEARCH = 'search' as const;
export const TOOL_CAPABILITY_LIST = 'list' as const;
export const TOOL_CAPABILITY_WRITE = 'write' as const;
export const TOOL_CAPABILITY_EDIT = 'edit' as const;
export const TOOL_CAPABILITY_SHELL = 'shell' as const;
export const TOOL_PROSE_QUALIFIER = 'your harness-provided' as const;

export type ToolCapability =
  | typeof TOOL_CAPABILITY_READ
  | typeof TOOL_CAPABILITY_SEARCH
  | typeof TOOL_CAPABILITY_LIST
  | typeof TOOL_CAPABILITY_WRITE
  | typeof TOOL_CAPABILITY_EDIT
  | typeof TOOL_CAPABILITY_SHELL;

export const PLANNER_TOOLS = Object.freeze([
  ...READ_ONLY_TOOLS,
  TOOL_WRITE_TO_FILE,
  TOOL_REPLACE_FILE_CONTENT
] as const);

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

export const GATE_TOOLS = Object.freeze([
  TOOL_RUN_COMMAND,
  TOOL_VIEW_FILE
] as const);

export const REVIEWER_TOOLS = Object.freeze([
  TOOL_VIEW_FILE,
  TOOL_GREP_SEARCH,
  TOOL_FIND_BY_NAME,
  TOOL_LIST_DIR,
  TOOL_RUN_COMMAND
] as const);

export const TRIAGE_TOOLS = Object.freeze([
  TOOL_VIEW_FILE,
  TOOL_GREP_SEARCH,
  TOOL_FIND_BY_NAME,
  TOOL_LIST_DIR,
  TOOL_RUN_COMMAND
] as const);


export const ERR_INVALID_TRANSITION = 'ERR_INVALID_TRANSITION' as const;
export const ERR_PHYSICAL_WRITE_VIOLATION = 'ERR_PHYSICAL_WRITE_VIOLATION' as const;
export const ERR_GITHUB_CONTEXT = 'ERR_GITHUB_CONTEXT' as const;
export const ERR_CONFIG_RESOLUTION = 'ERR_CONFIG_RESOLUTION' as const;
export const ERR_STATE_STORAGE = 'ERR_STATE_STORAGE' as const;
export const ERR_VALIDATION = 'ERR_VALIDATION' as const;
export const ERR_GATE_TIMEOUT = 'ERR_GATE_TIMEOUT' as const;
export const ERR_GATE_EXECUTION = 'ERR_GATE_EXECUTION' as const;
export const ERR_BUILD_DETECTION = 'ERR_BUILD_DETECTION' as const;
export const ERR_GATE_SUMMARY_PARSE = 'ERR_GATE_SUMMARY_PARSE' as const;
export const ERR_CRITIQUE = 'ERR_CRITIQUE' as const;
export const ERR_AI_REVIEWER = ERR_CRITIQUE;
export const ERR_CRITIQUE_INSTALL = 'ERR_CRITIQUE_INSTALL' as const;
export const ERR_CRITIQUE_UPDATE = 'ERR_CRITIQUE_UPDATE' as const;
export const ERR_REVIEWER_SUBAGENT = 'ERR_REVIEWER_SUBAGENT' as const;
export const ERR_COMMIT_EXECUTION = 'ERR_COMMIT_EXECUTION' as const;
export const ERR_WORKTREE = 'ERR_WORKTREE' as const;
export const ERR_PREFLIGHT_HALT = 'ERR_PREFLIGHT_HALT' as const;
export const ERR_MILESTONE_RELEASE = 'ERR_MILESTONE_RELEASE' as const;
export const ERR_MILESTONE_SEALED = 'ERR_MILESTONE_SEALED' as const;
export const ERR_CIRCUIT_BREAKER_TRIPPED = 'ERR_CIRCUIT_BREAKER_TRIPPED' as const;
export const ERR_EMERGENCY_ABORT = 'ERR_EMERGENCY_ABORT' as const;
export const ERR_QUOTA_EXHAUSTED = 'ERR_QUOTA_EXHAUSTED' as const;
export const HALT_TYPE_MISSING_PLAN_DIR = 'MISSING_PLAN_DIR' as const;

export const ERROR_CODES = Object.freeze({
  INVALID_TRANSITION: ERR_INVALID_TRANSITION,
  PHYSICAL_WRITE_VIOLATION: ERR_PHYSICAL_WRITE_VIOLATION,
  GITHUB_CONTEXT: ERR_GITHUB_CONTEXT,
  CONFIG_RESOLUTION: ERR_CONFIG_RESOLUTION,
  STATE_STORAGE: ERR_STATE_STORAGE,
  VALIDATION: ERR_VALIDATION,
  GATE_TIMEOUT: ERR_GATE_TIMEOUT,
  GATE_EXECUTION: ERR_GATE_EXECUTION,
  BUILD_DETECTION: ERR_BUILD_DETECTION,
  GATE_SUMMARY_PARSE: ERR_GATE_SUMMARY_PARSE,
  CRITIQUE: ERR_CRITIQUE,
  AI_REVIEWER: ERR_CRITIQUE,
  CRITIQUE_INSTALL: ERR_CRITIQUE_INSTALL,
  CRITIQUE_UPDATE: ERR_CRITIQUE_UPDATE,
  REVIEWER_SUBAGENT: ERR_REVIEWER_SUBAGENT,
  COMMIT_EXECUTION: ERR_COMMIT_EXECUTION,
  WORKTREE: ERR_WORKTREE,
  PREFLIGHT_HALT: ERR_PREFLIGHT_HALT,
  MILESTONE_RELEASE: ERR_MILESTONE_RELEASE,
  MILESTONE_SEALED: ERR_MILESTONE_SEALED,
  CIRCUIT_BREAKER_TRIPPED: ERR_CIRCUIT_BREAKER_TRIPPED,
  EMERGENCY_ABORT: ERR_EMERGENCY_ABORT,
  PREFLIGHT_HALT_MISSING_PLAN_DIR: HALT_TYPE_MISSING_PLAN_DIR,
  QUOTA_EXHAUSTED: ERR_QUOTA_EXHAUSTED
});


export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// Numeric Constants & Default Invariants
export const STATE_SCHEMA_VERSION = '1.0.0' as const;
export const CLI_VERSION = '0.6.0' as const;
export const DEFAULT_GATE_TIMEOUT_SECONDS = 300 as const;
export const MS_PER_SECOND = 1000 as const;
export const SECONDS_PER_MINUTE = 60 as const;
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms (24 hours)
export const EXIT_CODE_SUCCESS = 0 as const;
export const EXIT_CODE_FAILURE = 1 as const;
export const MAX_IMPLEMENT_GATE_LOOPS = 3 as const;
/**
 * How many times a REVIEW round may dispatch the reviewer without a verdict
 * being filed before the gate breaks out to a human (issue #272).
 *
 * The counter is a CONTEXT field, like `implementToGateLoops`: `codeloop next`
 * records the re-dispatch so "reviewer invoked, verdict forgotten" can never be
 * mistaken for "reviewer never invoked".
 */
export const MAX_REVIEW_DISPATCH_LOOPS = 3 as const;

// Circuit Breaker Defaults & Action Types
export const DEFAULT_CB_MAX_TURNS_PER_SUBAGENT = 15 as const;
export const DEFAULT_CB_MAX_GATE_RETRIES = 3 as const;
export const DEFAULT_CB_MAX_CONCURRENT_SUBAGENTS = 4 as const;
export const DEFAULT_CB_MAX_WALL_CLOCK_DURATION_SECONDS = 900 as const;
export const DEFAULT_CB_TOKEN_BUDGET_THRESHOLD = 150000 as const;

export const CB_ACTION_PAUSE_FOR_HUMAN = 'pause_for_human' as const;
export const CB_ACTION_ABORT = 'abort' as const;
export const CB_ACTION_WARN = 'warn' as const;
export const DEFAULT_CB_ACTION_ON_TRIP = CB_ACTION_PAUSE_FOR_HUMAN;

/**
 * The action set a *user* may configure for `circuitBreakers.actionOnTrip`.
 *
 * `CB_ACTION_FAILOVER` is deliberately absent: failover is a runner-adapter
 * behaviour (a second runner is tried after a quota rejection), not a breaker
 * disposition, and `actionOnTrip` has no implementation for it. Do not "fix"
 * this by adding it — that would advertise a config value that silently does
 * nothing.
 */
export const CB_ACTIONS = Object.freeze({
  PAUSE_FOR_HUMAN: CB_ACTION_PAUSE_FOR_HUMAN,
  ABORT: CB_ACTION_ABORT,
  WARN: CB_ACTION_WARN
});
export type CircuitBreakerActionType = typeof CB_ACTIONS[keyof typeof CB_ACTIONS];

/**
 * Commands that mutate `.agyloop/state.json`.
 *
 * `resume` clears a persisted gate pause, so it mutates the checkpoint exactly
 * like `reset` does — it must be listed here for the `AGY_SUBAGENT` root
 * mutation guard to cover it.
 */
export const STATE_MUTATING_COMMANDS = Object.freeze([
  'transition',
  'reset',
  'plan',
  'implement',
  'commit',
  'yolo',
  'triage',
  'resume',
  // `halt` persists a CIRCUIT_BREAKER pause like `resume` clears one — it must be
  // listed here so the `AGY_SUBAGENT` root mutation guard covers it (with a
  // carve-out in `cli.ts` so the runner-side caller is not blocked).
  'halt',
  'release',
  'abort',
  // `review` records the dispatched reviewer subagent's verdict into the
  // checkpoint, so it mutates it exactly like `triage` does — it must be listed
  // here for the `AGY_SUBAGENT` root mutation guard to cover it (with a
  // carve-out in `cli.ts` so the REVIEWER subagent can file its own verdict).
  'review',
  null
] as const);

// Path & File Constants
export const DEFAULT_STATE_DIR = '.agyloop' as const;
export const DEFAULT_STATE_FILE = 'state.json' as const;
export const DEFAULT_TASKS_STATE_DIR = 'tasks' as const;
export const DEFAULT_PLANS_DIR = 'artifacts/plans' as const;
export const DEFAULT_SUMMARY_FILENAME = 'CodeLoop Summary.md' as const;
export const DEFAULT_TEMPLATES_DIRNAME = 'templates' as const;
export const DEFAULT_WORKTREES_DIR = '.worktrees' as const;
export const DEFAULT_TASK_BRANCH_PREFIX = 'task/' as const;
export const DEFAULT_FIX_BRANCH_PREFIX = 'fix/' as const;
export const DEFAULT_PHASE_BRANCH_PREFIX = 'phase/' as const;
export const DEFAULT_FEATURE_BRANCH_PREFIX = 'feature/' as const;

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
export const PROMPT_FILE_GATE = 'gate.md' as const;
export const PROMPT_FILE_REVIEWER = 'reviewer.md' as const;
export const PROMPT_FILE_DISCOVERY = 'discovery.md' as const;
export const PROMPT_FILE_TRIAGE = 'triage.md' as const;

// Transition Notes
export const NOTE_DEVELOPER_APPROVED = 'Approved by developer' as const;
export const NOTE_AUTO_APPROVED_YOLO = 'Auto-approved in YOLO mode' as const;
export const NOTE_MANUAL_TRANSITION = 'Manual CLI transition' as const;
export const NOTE_INITIATED_PLANNING = 'Initiated planning mode' as const;
export const NOTE_INITIATED_DISCOVERY_RCA = 'Initiated discovery mode for defect RCA' as const;
export const NOTE_GENERATING_SPECS = 'Generating plan specifications' as const;
export const NOTE_AWAITING_REVIEW = 'Awaiting human review' as const;
export const NOTE_MANUAL_GATES_RUN = 'Manual gates run' as const;
export const NOTE_EXECUTING_GATES = 'Executing quality gates' as const;
export const NOTE_GATES_PASSED = 'Quality gates passed successfully' as const;
export const NOTE_GATES_FAILED = 'Quality gates failed' as const;
export const NOTE_EXECUTING_REVIEW = 'Executing AI review' as const;
export const NOTE_REVIEW_APPROVED = 'AI review approved: Code changes verified' as const;
export const NOTE_REVIEW_CHANGES_REQUESTED = 'AI review requested changes: Reverting to IMPLEMENT' as const;
export const NOTE_REVIEW_SKIPPED = 'AI review skipped: No reviewer output or critique report — proceeding without review' as const;
export const NOTE_REOPEN_IMPLEMENTATION_COMPLETED = 'Reopening implementation from completed stage to address review findings' as const;
export const NOTE_RERUN_GATES_COMPLETED = 'Re-executing quality gates from completed stage' as const;
export const NOTE_IMPLICIT_APPROVAL = 'Implicitly approved by explicit implementation request' as const;

// Status Identifiers
export const STATUS_PASSED = 'PASSED' as const;
export const STATUS_FAILED = 'FAILED' as const;
export const STATUS_TIMED_OUT = 'TIMED_OUT' as const;
export const STATUS_DISPLAY_TIMED_OUT = 'TIMED OUT' as const;
export const STATUS_SKIPPED = 'SKIPPED' as const;

/**
 * The gate verdict for "the gates refused to certify an unimplemented tree"
 * (issue #259).
 *
 * A VACUOUS verdict is NOT a failure and NOT a pass: nothing was executed, so
 * there is nothing to certify. It is deliberately NOT a member of the
 * `GateVerdict` union (`src/domain/value-objects/gate-summary-report.ts`) —
 * that union is the contract of the `GateSummaryReport` value object, and the
 * VACUOUS report is deliberately built as a plain string so this issue does
 * not change any shared contract.
 */
export const STATUS_VACUOUS = 'VACUOUS' as const;

// Gate Commands & Thresholds
export interface GateCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly command: string;
}

export const DEFAULT_GATE_COMMAND_TYPECHECK = 'npm run typecheck' as const;
export const DEFAULT_GATE_COMMAND_TEST = 'npm test' as const;

export const DEFAULT_GATE_COMMANDS: readonly GateCommandDefinition[] = Object.freeze([
  Object.freeze({
    id: 'typecheck',
    label: 'TypeScript Compilation & Typecheck',
    command: DEFAULT_GATE_COMMAND_TYPECHECK
  }),
  Object.freeze({
    id: 'test',
    label: 'Automated Test Suite',
    command: DEFAULT_GATE_COMMAND_TEST
  })
]);

export const MAX_FILTERED_LOG_LINES = 30 as const;
export const MAX_FILTERED_OUTPUT_CHARS = 2500 as const;

// Structured Quality Gate Summary Protocol Tokens & Thresholds
export const TOKEN_GATE_STATUS = 'GATE_STATUS' as const;
export const TOKEN_BUILD_STATUS = 'BUILD_STATUS' as const;
export const TOKEN_TEST_METRICS = 'TEST_METRICS' as const;
export const TOKEN_TEST_COUNT = 'TEST_COUNT' as const;
export const TOKEN_FAILURE_FILE = 'FAILURE_FILE' as const;
export const TOKEN_FAILING_ASSERTION = 'FAILING_ASSERTION' as const;
export const TOKEN_DIAGNOSTIC_SNIPPET = 'DIAGNOSTIC_SNIPPET' as const;
export const TOKEN_EXECUTION_MATRIX = 'EXECUTION_MATRIX' as const;

export const MAX_DIAGNOSTIC_LINES = 25 as const;
export const MAX_DIAGNOSTIC_CHARS = 2000 as const;
export const DIAGNOSTIC_TRUNCATION_MARKER = '... [diagnostics truncated under 25 lines limit]' as const;

export const HEADER_QUALITY_GATE_REPORT = '=== CodeLoop: Quality Gate Report ===' as const;
export const LABEL_OVERALL_VERDICT = 'Overall Verdict' as const;
export const LABEL_BUILD_STATUS = 'Build Status' as const;
export const LABEL_BUILD_SYSTEM = 'Build System' as const;
export const LABEL_TOTAL_DURATION = 'Total Duration' as const;
export const LABEL_NEXT_STAGE = 'Next Stage' as const;
export const LABEL_EXECUTION_MATRIX = 'Execution Matrix:' as const;
export const LABEL_TEST_METRICS = 'Test Metrics' as const;
export const LABEL_DIAGNOSTIC_FAILURE_DETAILS = 'Diagnostic Failure Details' as const;
export const LABEL_EXECUTION_LOG = 'Execution Log' as const;
export const LABEL_FAILURE_FILE = 'Failing File' as const;
export const LABEL_FAILING_ASSERTION = 'Failing Assertion' as const;
export const SECTION_SELF_CORRECTION_TITLE = '### Self-Correction Quality Gate Failure Diagnostics:' as const;
export const MSG_NO_FAILURES = 'All verification commands passed without failures.' as const;
export const MSG_COMMAND_FAILED_NO_OUTPUT = 'Command failed without output.' as const;
/**
 * Canonical rejection text for an invalid `--issue` token (issue #250).
 *
 * `{raw}` is substituted with the offending token. ONE source of truth: the CLI
 * choke point, the checkpoint resolver, the file adapter and the reset use case
 * all quote the operator the same sentence.
 */
export const ISSUE_TOKEN_INVALID_MESSAGE = "Invalid --issue '{raw}'. Expected a positive integer (digits only), e.g. --issue 250." as const;

/**
 * The tool's OWN smoke sandbox (issue #279).
 *
 * The role prompts used to mandate `/tmp/smoke-<issue>` — the one directory the
 * storage-layer guard refuses EVERY state mutation in. The permitted path is the
 * per-user cache directory below: outside the workspace (so `discoverWorkspaceRoot`
 * cannot climb to the real `.agyloop`), outside the OS temp directory (so the
 * `/tmp` rule does not apply), and positively recognisable as this tool's own
 * sandbox by the guard.
 *
 * ONE source: the prompt prose, the recommended path in the refusal message and
 * the guard's sandbox root all derive from these segments.
 */
export const SMOKE_SANDBOX_HOME_SEGMENTS = Object.freeze(['.cache', 'agyloop'] as const);
export const SMOKE_SANDBOX_DIR_PREFIX = 'smoke-' as const;
export const SMOKE_SANDBOX_HOME_ANCHOR = '$HOME' as const;
export const SMOKE_SANDBOX_ROOT_DISPLAY = `${SMOKE_SANDBOX_HOME_ANCHOR}/${SMOKE_SANDBOX_HOME_SEGMENTS.join('/')}`;
export const SMOKE_SANDBOX_RECOMMENDED_PATH = `${SMOKE_SANDBOX_ROOT_DISPLAY}/${SMOKE_SANDBOX_DIR_PREFIX}<issue>`;
export const SMOKE_SANDBOX_MANDATE =
  `If you must execute state-mutating commands (e.g. \`bin/agyloop transition\`) or destructive compiles for a smoke test, you MUST clone the repository into an isolated standalone directory **OUTSIDE** the workspace entirely at \`${SMOKE_SANDBOX_RECOMMENDED_PATH}\`. If it is placed anywhere inside the workspace (e.g. \`scratch/\` or \`.worktrees/\`), the CLI will climb the directory tree and corrupt the root \`.agyloop/state.json\`. The tool refuses state mutation inside a smoke-isolation directory it does not recognise as its own sandbox, so use this path exactly. After the smoke test is complete, you MUST destroy this isolated directory to keep the environment clean.` as const;
export const SMOKE_SANDBOX_AGY_SUBAGENT_NOTE =
  'If your harness sets AGY_SUBAGENT=1, prefix state-mutating smoke commands with `env -u AGY_SUBAGENT` so the root-mutation guard does not block them.' as const;

/**
 * The in-repo smoke isolation directory the guard refuses outside a test run
 * (issue #279). Composed from segments so the guard carries no magic path.
 */
export const SMOKE_ISOLATION_ARTIFACTS_DIR = 'artifacts' as const;
export const SMOKE_ISOLATION_ARTIFACTS_PREFIX = 'smoke' as const;

export const MSG_STATE_MUTATION_FORBIDDEN_SMOKE_TEST = `State mutation is forbidden inside a smoke-isolation directory the tool does not recognise as its own sandbox (${SMOKE_SANDBOX_RECOMMENDED_PATH}).` as const;
export const MSG_STATE_MUTATION_FORBIDDEN_ROOT_STATE = 'Test suite is forbidden from mutating the root orchestrator state.' as const;
export const DIVIDER_DASHED = '----------------------------------------------------------------------' as const;

// Structured Review Verdict Protocol Tokens, Verdicts & Thresholds
export const TOKEN_REVIEW_STATUS = 'REVIEW_STATUS' as const;
export const TOKEN_REVIEW_SUMMARY = 'REVIEW_SUMMARY' as const;
export const TOKEN_UNFULFILLED_AC = 'UNFULFILLED_AC' as const;
export const TOKEN_REMEDIATION_GUIDANCE = 'REMEDIATION_GUIDANCE' as const;
export const TOKEN_REVIEW_FINDINGS = 'REVIEW_FINDINGS' as const;

export const VERDICT_APPROVED = 'APPROVED' as const;
export const VERDICT_CHANGES_REQUESTED = 'CHANGES_REQUESTED' as const;
/**
 * Third verdict state (issue #236): "review did not run". Set ONLY by the system
 * (RunReviewUseCase) when there is neither Reviewer-subagent output nor a critique
 * report — an advisory fail-open that never reverts the pipeline.
 */
export const VERDICT_SKIPPED = 'SKIPPED' as const;

export const REVIEW_VERDICTS = Object.freeze([
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  VERDICT_SKIPPED
] as const);

export type ReviewVerdictState = typeof REVIEW_VERDICTS[number];

export const HEADER_REVIEW_VERDICT_REPORT = '=== CodeLoop: Review Verdict Report ===' as const;
export const LABEL_REVIEW_STATUS = 'Review Status' as const;
export const LABEL_REVIEW_SUMMARY = 'Review Summary' as const;
export const LABEL_UNFULFILLED_AC = 'Unfulfilled Acceptance Criteria' as const;
export const LABEL_REMEDIATION_GUIDANCE = 'Remediation Guidance' as const;
export const SECTION_REVIEW_SELF_CORRECTION_TITLE = '### Reviewer Subagent Self-Correction Remediation Guidance:' as const;

// System-origin-only invariant (issue #236): the REVIEW_STATUS token contract stays
// binary (APPROVED | CHANGES_REQUESTED) so a Reviewer subagent can never self-declare
// `SKIPPED` to bypass review. VERDICT_SKIPPED is set exclusively by RunReviewUseCase
// when no reviewer output / critique report exists and is never parsed from text.
export const REGEX_REVIEW_STATUS_TOKEN = /^REVIEW_STATUS:\s*(APPROVED|CHANGES_REQUESTED)$/im;
export const REGEX_REVIEW_SUMMARY_TOKEN = /^REVIEW_SUMMARY:\s*(.+)$/im;
export const REGEX_UNFULFILLED_AC_TOKEN = /^UNFULFILLED_AC:\s*(.+)$/im;
export const REGEX_REMEDIATION_GUIDANCE_TOKEN = /^REMEDIATION_GUIDANCE:\s*(.+)$/im;

export const STANDARD_CANDIDATE_PATHS = Object.freeze([
  '.github/critique.md',
  '.critique.md',
  '.github/ai-reviewer-standards.md',
  'AGENTS.md',
  'STANDARDS.md',
  'CONTRIBUTING.md'
] as const);

// Structured Protocol Regex Patterns
export const REGEX_GATE_STATUS_TOKEN = /^GATE_STATUS:\s*(PASSED|FAILED|TIMED_OUT)$/im;
export const REGEX_BUILD_STATUS_TOKEN = /^BUILD_STATUS:\s*(PASSED|FAILED)$/im;
export const REGEX_TEST_METRICS_TOKEN = /^(?:TEST_METRICS|TEST_COUNT):\s*(.+)$/im;
export const REGEX_FAILURE_FILE_TOKEN = /^FAILURE_FILE:\s*(.+)$/im;
export const REGEX_FAILING_ASSERTION_TOKEN = /^FAILING_ASSERTION:\s*(.+)$/im;

export const REGEX_METRIC_PASSED = /(\d+)\s+pass(?:ed)?/i;
export const REGEX_METRIC_FAILED = /(\d+)\s+fail(?:ed)?/i;
export const REGEX_METRIC_SKIPPED = /(\d+)\s+skip(?:ped)?/i;
export const REGEX_METRIC_TOTAL = /(?:tests?|total):\s*(\d+)/i;
export const REGEX_TAP_TESTS = /tests\s+(\d+)/i;
export const REGEX_TAP_PASS = /pass\s+(\d+)/i;
export const REGEX_TAP_FAIL = /fail\s+(\d+)/i;
export const REGEX_TAP_SKIPPED = /skipped\s+(\d+)/i;

export const REGEX_MD_TABLE_HEADER = /\|\s*Command\s*\|\s*Exit Code\s*\|\s*Duration\s*\|\s*Status\s*\|/i;
export const REGEX_MD_TABLE_ROW = /\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([A-Z_\s]+?)\s*\|/;

// eslint-disable-next-line no-control-regex
export const REGEX_ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
export const REGEX_STACK_FRAME = /^\s*at\s+(?:(?<callSite>.*?)\s+\((?<fileLocation>[^)]+:\d+:\d+)\)|(?<directLocation>[^\s()]+\.[a-zA-Z0-9]+:\d+:\d+))/;
export const REGEX_FILE_LOCATION = /(?:at\s+.*?\(([^)]+:\d+:\d+)\)|at\s+([^\s()]+\.[a-zA-Z0-9]+:\d+:\d+)|([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+:\d+:\d+))/;
export const REGEX_ASSERTION_FAILURE = /(?:AssertionError|Assertion failed|Expected:|Received:|assert(?:\.[a-zA-Z0-9_]+)?\s*\(|Error:\s*.+|expect\(.*\)\..*)/i;
export const REGEX_ERROR_BANNER = /(?:FAIL|ERROR|FAILURE|✖|×)\s+(.+)/;
export const REGEX_NOISE_NODE_INTERNAL = /(?:node:internal\/|\/node_modules\/)/;
export const REGEX_NOISE_NPM_ERR = /^npm\s+ERR!/;
export const REGEX_NOISE_PASSING = /^\s*(?:✔|√|PASS|ok\s+\d+)\s+/;

// Markdown "bold key" bullets: `- **Key:**` (unfilled) versus `- **Key:** value`
// (filled). Used by `DiscoveryReport` to tell an untouched template scaffold from
// a discovery report a subagent actually wrote. Deliberately template-agnostic:
// the predicate never names a specific section key, so it survives the repository
// drifting its `templates/discovery-plan.md`.
//
// Both carry the `g` flag, so `RegExp.prototype.test()` is STATEFUL (it advances
// `lastIndex` and would alternate true/false on repeated calls). Always use
// `String.prototype.match()` with these — `match` on a global regex resets
// `lastIndex` first and returns the full match array, so it is safe to call
// repeatedly on the same instance.
export const REGEX_MD_UNFILLED_KEY_BULLET = /^[ \t]*[-*+][ \t]*\*\*[^*\n]+:\*\*[ \t]*$/gm;
export const REGEX_MD_FILLED_KEY_BULLET = /^[ \t]*[-*+][ \t]*\*\*[^*\n]+:\*\*[ \t]*\S/gm;

/**
 * The `- ` / `* ` / `+ ` list marker of a bullet, plus the whitespace after it.
 * Split out of `DiscoveryReport` so the inline copy cannot drift from
 * `REGEX_MD_UNFILLED_KEY_BULLET`'s own `[-*+][ \t]*` prefix.
 */
export const REGEX_MD_BULLET_PREFIX = /^[-*+][ \t]*/;

/**
 * The `**Key:**` header of a bold-key bullet, without the leading list marker.
 * Paired with `REGEX_MD_BULLET_PREFIX` to recover the human-readable key name.
 */
export const REGEX_MD_BOLD_KEY = /^\*\*(.+?):\*\*/;

/**
 * A line that continues the bullet above it: leading whitespace, then content.
 *
 * Why `DiscoveryReport` needs it: planning subagents habitually write a key's
 * value as an indented sub-list on the FOLLOWING lines —
 *
 *     - **Relevant Code References:**
 *       - `src/application/start-planning.ts`
 *
 * — which both key-bullet regexes above (anchored to a single line) score as
 * "unfilled". That shape is the norm, not the exception, so ignoring it parked
 * 80% of this repository's own genuine RCA reports.
 */
export const REGEX_MD_INDENTED_CONTINUATION = /^[ \t]+\S/;

/**
 * A fenced code block: an opening ``` / ~~~ fence (3+ markers, optional
 * indentation, optional info string), its payload, and a closing fence of the
 * same marker. An unterminated fence runs to end-of-document.
 *
 * Why `DiscoveryReport` strips these before matching: a real discovery report
 * routinely QUOTES the pristine template it is filling in — the report for
 * issue 237 reproduces the empty `- **Key:**` scaffold inside a fence to show
 * what was replaced. Matching over the raw text scored such a report
 * "unpopulated" purely because of code it was quoting.
 *
 * Two non-obvious details keep it honest: the closing marker is a backreference
 * (`\1`) so a ```` fence may contain ``` lines, and the unterminated branch is
 * anchored with `(?![\s\S])` rather than `$` so a stray trailing fence line can
 * never swallow the rest of the document.
 */
export const REGEX_MD_FENCED_CODE_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\r?\n[\s\S]*?\r?\n[ \t]*\1[^\n]*(?=\r?\n|(?![\s\S]))|[\s\S]*(?![\s\S]))/gm;

// Content thresholds for `DiscoveryReport.isPopulated`: a document shorter than
// DISCOVERY_REPORT_MIN_CHARS cannot be a real RCA, a report carrying fewer than
// DISCOVERY_REPORT_MIN_FILLED_KEYS has not described the failure, and one
// leaving more than DISCOVERY_REPORT_MAX_UNFILLED_KEYS placeholders blank is
// still an unfinished scaffold.
export const DISCOVERY_REPORT_MIN_CHARS = 200;
export const DISCOVERY_REPORT_MIN_FILLED_KEYS = 3;
/**
 * How many unfilled placeholder keys a genuine discovery report may still carry
 * and be accepted.
 *
 * The original rule was `unfilled === 0` and it was wrong: real reports
 * routinely leave a heading unpopulated while still containing the whole
 * analysis. A hard zero parked 80% of this repository's genuine reports and
 * left `--skip-discovery` as the operator's only way through — exactly the
 * bypass the RCA gate exists to keep explicit and rare.
 *
 * The value 2 is the OBSERVED MAXIMUM across this repository's own discovery
 * reports (histogram over `artifacts/plans`: 20 genuine reports @ 0 blank
 * keys, 1 @ 2, plus 48 pristine scaffolds @ 10). It is deliberately set to
 * that maximum rather than a round number: any lower value reintroduces a
 * false negative on a real report, and any higher one admits a scaffold that
 * a subagent barely touched.
 *
 * Bounded rather than removed, so the control keeps its teeth: a pristine
 * scaffold from `templates/discovery-plan.md` leaves all 10 placeholder keys
 * blank and stays parked.
 */
export const DISCOVERY_REPORT_MAX_UNFILLED_KEYS = 2;

// Ecosystem Identifiers
export const ECOSYSTEM_NODE = 'node' as const;
export const ECOSYSTEM_PYTHON = 'python' as const;
export const ECOSYSTEM_GO = 'go' as const;
export const ECOSYSTEM_RUST = 'rust' as const;
export const ECOSYSTEM_GRADLE = 'gradle' as const;
export const ECOSYSTEM_MAVEN = 'maven' as const;
export const ECOSYSTEM_DOTNET = 'dotnet' as const;
export const ECOSYSTEM_UNKNOWN = 'unknown' as const;

export const SUPPORTED_ECOSYSTEMS = Object.freeze([
  ECOSYSTEM_NODE,
  ECOSYSTEM_GO,
  ECOSYSTEM_RUST,
  ECOSYSTEM_PYTHON,
  ECOSYSTEM_GRADLE,
  ECOSYSTEM_MAVEN,
  ECOSYSTEM_DOTNET,
  ECOSYSTEM_UNKNOWN
] as const);

export type EcosystemType = typeof SUPPORTED_ECOSYSTEMS[number];

// Deterministic Prioritization for Polyglot/Multi-Ecosystem Repositories
export const ECOSYSTEM_PRIORITY_ORDER: readonly EcosystemType[] = Object.freeze([
  ECOSYSTEM_NODE,
  ECOSYSTEM_GO,
  ECOSYSTEM_RUST,
  ECOSYSTEM_PYTHON,
  ECOSYSTEM_GRADLE,
  ECOSYSTEM_MAVEN,
  ECOSYSTEM_DOTNET
]);

// Package Manager Identifiers
export const PKG_MGR_PNPM = 'pnpm' as const;
export const PKG_MGR_YARN = 'yarn' as const;
export const PKG_MGR_BUN = 'bun' as const;
export const PKG_MGR_NPM = 'npm' as const;

export const PACKAGE_MANAGERS = Object.freeze([
  PKG_MGR_PNPM,
  PKG_MGR_YARN,
  PKG_MGR_BUN,
  PKG_MGR_NPM
] as const);

export type PackageManagerName = typeof PACKAGE_MANAGERS[number];

// Build & Test Runner Markers
export const MARKER_PACKAGE_JSON = 'package.json' as const;
export const MARKER_PNPM_LOCK = 'pnpm-lock.yaml' as const;
export const MARKER_YARN_LOCK = 'yarn.lock' as const;
export const MARKER_BUN_LOCK = 'bun.lockb' as const;
export const MARKER_PACKAGE_LOCK = 'package-lock.json' as const;

export const MARKER_PLAYWRIGHT_CONFIG_TS = 'playwright.config.ts' as const;
export const MARKER_PLAYWRIGHT_CONFIG_JS = 'playwright.config.js' as const;
export const MARKER_PLAYWRIGHT_CONFIG_MJS = 'playwright.config.mjs' as const;
export const MARKER_PLAYWRIGHT_CONFIG_CJS = 'playwright.config.cjs' as const;

export const PLAYWRIGHT_CONFIG_MARKERS = Object.freeze([
  MARKER_PLAYWRIGHT_CONFIG_TS,
  MARKER_PLAYWRIGHT_CONFIG_JS,
  MARKER_PLAYWRIGHT_CONFIG_MJS,
  MARKER_PLAYWRIGHT_CONFIG_CJS
] as const);

export const PLAYWRIGHT_SCRIPT_CANDIDATES = Object.freeze([
  'test:e2e',
  'e2e',
  'test:playwright',
  'playwright'
] as const);

export const MARKER_GO_MOD = 'go.mod' as const;
export const MARKER_CARGO_TOML = 'Cargo.toml' as const;
export const MARKER_PYPROJECT_TOML = 'pyproject.toml' as const;
export const MARKER_PYTEST_INI = 'pytest.ini' as const;
export const MARKER_SETUP_PY = 'setup.py' as const;
export const MARKER_REQUIREMENTS_TXT = 'requirements.txt' as const;

export const PYTHON_MARKERS = Object.freeze([
  MARKER_PYPROJECT_TOML,
  MARKER_PYTEST_INI,
  MARKER_SETUP_PY,
  MARKER_REQUIREMENTS_TXT
] as const);

export const MARKER_GRADLEW = 'gradlew' as const;
export const MARKER_GRADLEW_BAT = 'gradlew.bat' as const;
export const MARKER_BUILD_GRADLE = 'build.gradle' as const;
export const MARKER_BUILD_GRADLE_KTS = 'build.gradle.kts' as const;
export const MARKER_SETTINGS_GRADLE = 'settings.gradle' as const;
export const MARKER_SETTINGS_GRADLE_KTS = 'settings.gradle.kts' as const;

export const GRADLE_MARKERS = Object.freeze([
  MARKER_BUILD_GRADLE,
  MARKER_BUILD_GRADLE_KTS,
  MARKER_SETTINGS_GRADLE,
  MARKER_SETTINGS_GRADLE_KTS
] as const);

export const MARKER_POM_XML = 'pom.xml' as const;
export const MARKER_GITHUB_WORKFLOWS = '.github/workflows' as const;

export const MARKER_EXT_CSPROJ = '.csproj' as const;
export const MARKER_EXT_SLN = '.sln' as const;
export const MARKER_EXT_FSPROJ = '.fsproj' as const;

export const DOTNET_EXTENSIONS = Object.freeze([
  MARKER_EXT_CSPROJ,
  MARKER_EXT_SLN,
  MARKER_EXT_FSPROJ
] as const);

// Ecosystem Priority Numbers
export const PRIORITY_ECOSYSTEM_NODE = 1 as const;
export const PRIORITY_ECOSYSTEM_GO = 2 as const;
export const PRIORITY_ECOSYSTEM_RUST = 3 as const;
export const PRIORITY_ECOSYSTEM_PYTHON = 4 as const;
export const PRIORITY_ECOSYSTEM_GRADLE = 5 as const;
export const PRIORITY_ECOSYSTEM_MAVEN = 6 as const;
export const PRIORITY_ECOSYSTEM_DOTNET = 7 as const;
export const DEFAULT_ECOSYSTEM_PRIORITY = 100 as const;
export const FALLBACK_ECOSYSTEM_PRIORITY = 999 as const;

// Confidence Levels
export const CONFIDENCE_CERTAIN = 1.0 as const;
export const CONFIDENCE_NONE = 0.0 as const;

// Command IDs
export const CMD_ID_TYPECHECK = 'typecheck' as const;
export const CMD_ID_BUILD = 'build' as const;
export const CMD_ID_TEST = 'test' as const;
export const CMD_ID_PLAYWRIGHT = 'playwright' as const;
export const CMD_ID_GO_VET = 'go-vet' as const;
export const CMD_ID_GO_TEST = 'go-test' as const;
export const CMD_ID_CARGO_CHECK = 'cargo-check' as const;
export const CMD_ID_CARGO_TEST = 'cargo-test' as const;
export const CMD_ID_PYTEST = 'pytest' as const;
export const CMD_ID_PYTHON_UNITTEST = 'python-unittest' as const;
export const CMD_ID_GRADLE_CHECK = 'gradle-check' as const;
export const CMD_ID_GRADLE_TEST = 'gradle-test' as const;
export const CMD_ID_MAVEN_TEST = 'maven-test' as const;
export const CMD_ID_DOTNET_TEST = 'dotnet-test' as const;
export const CMD_ID_ACT = 'act' as const;
export const CMD_ID_E2E = 'e2e' as const;

export const KEYWORD_CHECK = 'check' as const;
export const KEYWORD_VET = 'vet' as const;

// Command Labels
export const CMD_LABEL_TYPECHECK = 'TypeScript Compilation & Typecheck' as const;
export const CMD_LABEL_BUILD = 'Build Script' as const;
export const CMD_LABEL_TEST = 'Automated Test Suite' as const;
export const CMD_LABEL_PLAYWRIGHT = 'Playwright End-to-End Test Suite' as const;
export const CMD_LABEL_GO_VET = 'Go Vet Analysis' as const;
export const CMD_LABEL_GO_TEST = 'Go Automated Test Suite' as const;
export const CMD_LABEL_CARGO_CHECK = 'Cargo Compilation Check' as const;
export const CMD_LABEL_CARGO_TEST = 'Cargo Automated Test Suite' as const;
export const CMD_LABEL_PYTEST = 'Pytest Automated Test Suite' as const;
export const CMD_LABEL_PYTHON_UNITTEST = 'Python Unittest Suite' as const;
export const CMD_LABEL_GRADLE_CHECK = 'Gradle Check' as const;
export const CMD_LABEL_GRADLE_TEST = 'Gradle Test Suite' as const;
export const CMD_LABEL_MAVEN_TEST = 'Maven Test Suite' as const;
export const CMD_LABEL_DOTNET_TEST = '.NET Automated Test Suite' as const;
export const CMD_LABEL_ACT = 'Act Container Workflow Verification' as const;

// Command Prefixes
export const CMD_PREFIX_CUSTOM = 'custom' as const;
export const CMD_PREFIX_CONFIG = 'config' as const;

// Detection Indicators & Script Constants
export const SCRIPT_NAME_TYPECHECK = 'typecheck' as const;
export const SCRIPT_NAME_BUILD = 'build' as const;
export const SCRIPT_NAME_TEST = 'test' as const;
export const NPM_DEFAULT_TEST_STUB = 'no test specified' as const;
export const PYTEST_INDICATOR_KEYWORD = 'pytest' as const;
export const PYTEST_CONFIG_HEADER = '[tool.pytest' as const;

// Ecosystem Command Templates
export const CMD_GO_VET = 'go vet ./...' as const;
export const CMD_GO_TEST = 'go test ./...' as const;
export const CMD_CARGO_CHECK = 'cargo check' as const;
export const CMD_CARGO_TEST = 'cargo test' as const;
export const CMD_GRADLEW_CHECK = './gradlew check' as const;
export const CMD_GRADLEW_TEST = './gradlew test' as const;
export const CMD_GRADLE_CHECK = 'gradle check' as const;
export const CMD_GRADLE_TEST = 'gradle test' as const;
export const CMD_MAVEN_TEST = 'mvn test' as const;
export const CMD_DOTNET_TEST = 'dotnet test' as const;
export const CMD_PYTEST = 'pytest' as const;
export const CMD_PYTHON_UNITTEST = 'python -m unittest' as const;
export const CMD_PLAYWRIGHT_TEST = 'npx playwright test' as const;
export const CMD_PLAYWRIGHT_PNPM = 'pnpm exec playwright test' as const;
export const CMD_PLAYWRIGHT_BUN = 'bunx playwright test' as const;
export const CMD_PLAYWRIGHT_YARN = 'yarn playwright test' as const;

// Validation & Plan Constants
export const VALIDATION_FIELD_PLAN_PATH = 'planPath' as const;
export const PLAN_DEFAULT_SPECIFICATION_TITLE = 'Plan Specification' as const;
export const PLAN_DEFAULT_TITLE = 'Task Plan' as const;


export const ANTI_INCEPTION_GUARDRAIL = `### Anti-Inception & Role Boundary Guardrail:
- You are an isolated worker subagent, NOT the orchestrator.
- You are STRICTLY FORBIDDEN from dispatching or spawning other subagents (including via your harness's subagent/task tool).
- Do not attempt to orchestrate lifecycle stages; perform your specific role directly.` as const;

export const DEFAULT_DISCOVERY_SYSTEM_PROMPT = `# AgyLoop Discovery Subagent System Prompt

You are the **AgyLoop Discovery Subagent**, a specialized investigator in Google Antigravity.

Your primary purpose is deep defect discovery, comprehensive root-cause analysis (RCA), and edge-case investigation. You prepare actionable discovery reports for downstream planning and implementation.

---

## 1. Absolute Read-Only Mandate
- You are equipped with inspection tools (\`view_file\`, \`grep_search\`, \`find_by_name\`, \`list_dir\`) and limited write tools (\`write_to_file\`, \`replace_file_content\`).
- You MUST ONLY use write tools to populate the discovery specification inside the \`artifacts/plans/\` directory.
- Never attempt to edit, rewrite, or delete workspace source files.

## 2. Investigative Methodology
- Inspect repository structure and package manifests.
- Locate all relevant symbols, classes, functions across the codebase.
- Trace the failure mechanism from ingress to failure.
- Manually smoke test the bug to record exact, minimal reproduction commands, failing test targets, and reproduction results.
- ${SMOKE_SANDBOX_MANDATE}
- If testing root commands, you must run them in the isolated directory. ${SMOKE_SANDBOX_AGY_SUBAGENT_NOTE}` as const;

// Default System Prompts (Embedded Domain Fallbacks)
export const DEFAULT_PLANNER_SYSTEM_PROMPT = `# AgyLoop Planning Subagent System Prompt

You are the **AgyLoop Architectural Planning Subagent**, a specialized, analytical, read-only software architect and investigator in Google Antigravity.

Your primary purpose is deep codebase inspection, comprehensive root-cause analysis (RCA), edge-case discovery, and producing production-grade technical specifications for downstream implementation.

---

## 1. Absolute Read-Only Mandate & Safety Invariants

1. **Scoped File Modifications (Plans Only)**:
   - You are equipped with inspection tools (\`view_file\`, \`grep_search\`, \`find_by_name\`, \`list_dir\`) and limited write tools (\`write_to_file\`, \`replace_file_content\`).
   - You are physically and procedurally restricted from mutating workspace source code files or running build/execute commands.
   - You MUST ONLY use write tools to populate the technical specification inside the \`artifacts/plans/\` directory.
   - Never attempt to edit, rewrite, or delete workspace source files.
   - You do not write implementation code; your sole product is exhaustive, actionable architectural plans.

2. **Active MCP Tool Usage (Read-Only)**:
   - When Model Context Protocol (MCP) servers are enabled in your environment (e.g. Chrome DevTools, schema/database inspectors, API doc providers), you may invoke them strictly for non-destructive diagnostic queries, network inspection, and schema discovery.
   - Never invoke MCP tools that trigger side effects, database writes, or deployment actions.

---

## 2. Investigative Methodology

Do not speculate or make assumptions about existing code. Base every architectural conclusion on empirical verification using your inspection tools.

### Phase A: Context Discovery & Scope Identification
- Inspect repository structure, package manifests (\`package.json\`, \`requirements.txt\`, etc.), and project conventions.
- Locate all relevant symbols, classes, functions, and configuration keys across the codebase using \`grep_search\` and \`find_by_name\`.
- Check git history or recent commits when relevant to trace regressions or previous architectural decisions.

### Phase B: Root-Cause Analysis (RCA) [For Defects / Bugs]
When investigating defects or regressions:
1. **Problem Statement & Symptoms**: Contrast observed behavior against expected behavior.
2. **Failure Mechanism**: Isolate the exact lines and conditions that trigger the defect. Trace the call stack from ingress to failure.
3. **Reproduction Protocol**: Detail exact, minimal reproduction commands or failing test targets.
4. **Remediation Strategy & Regression Analysis**: Propose the cleanest fix approach and evaluate any upstream or downstream components that might be impacted.

### Phase C: Architectural Design [For Features / Refactors]
When designing new capabilities or structural changes:
1. **Component Boundaries**: Define the exact responsibility of each modified or created component.
2. **Data Flow & Invariants**: Detail input/output types, data structures, state machines, and configuration options.
3. **Edge Cases**: Systematically identify error states, boundary conditions, concurrency/async risks, and cross-platform compatibility (Linux, macOS, Windows).
4. **Dependencies**: Prefer standard library or established repository patterns. Avoid introducing unnecessary external dependencies.

---

## 3. Specification Output Standards

Your generated specifications will be read directly by the **Implementation Subagent (\`implementer\`)** in a clean context. The plan must be completely self-contained and ambiguity-free.

### Specification Template Alignment:
- For bugs/defects, adhere to \`templates/discovery-plan.md\`.
- For features/tasks, adhere to \`templates/implementation-plan.md\`.

### Required Sections for Every Plan:
1. **Context & Objectives**: High-level problem statement and explicit acceptance criteria.
2. **Architectural Design & Impact**: Component breakdown, affected paths, data invariants, and edge cases.
3. **Step-by-Step Implementation Checklist**:
   - Grouped into discrete, ordered tasks with checkbox format (\`- [ ] **Step N:** ...\`).
   - Explicit file paths and symbol names for all modifications and new files.
4. **Quality Gate & Verification Protocol**:
   - Exact automated test commands (e.g. \`node --test tests/example.test.js\`).
   - Lint, typecheck, or build commands.
   - Manual verification steps if applicable.
   - NOTE: ${SMOKE_SANDBOX_MANDATE} ${SMOKE_SANDBOX_AGY_SUBAGENT_NOTE}

---

## 4. Communication Style

- Rigorous, concise, and structured.
- Always cite specific file paths and line ranges using Markdown links (e.g., \`[file.js:L10-L25]\`).
- Do not output conversational filler. Deliver focused, high-density technical analysis.` as const;

export const DEFAULT_IMPLEMENTER_SYSTEM_PROMPT = `# AgyLoop Implementation Subagent System Prompt

You are the **AgyLoop Code Implementation Subagent**, an autonomous, rigorous software engineer in Google Antigravity.

Your primary purpose is to execute code changes, refactoring, test authoring, and verification strictly adhering to an approved architectural plan.

---

## 1. Operating Mandate & Plan Fidelity

1. **Strict Plan Adherence**:
   - You execute implementations derived directly from an approved specification (\`implementation-plan.md\` or \`discovery-plan.md\`).
   - You must NOT deviate from the approved design or introduce scope creep.
   - Do not refactor unrelated code, reformat unaffected files, or introduce unrequested dependencies.

2. **Surgical Modification Capability**:
   - You are equipped with inspection tools (\`view_file\`, \`grep_search\`, \`find_by_name\`, \`list_dir\`) and modification tools (\`write_to_file\`, \`replace_file_content\`, \`run_command\`).
   - Use \`replace_file_content\` for surgical modifications to existing files.
   - Use \`write_to_file\` exclusively when creating brand-new source or test files.
   - Restrict \`run_command\` strictly to lightweight syntax checks and type validation (e.g. \`npx tsc --noEmit\`).
   - Prohibit running full test suites (\`npm test\`), linters, or heavy build pipelines; all automated verification is strictly reserved for the downstream Quality Gate (\`prompts/gate.md\`).
   - All temporary scripts, files, and debugging artifacts must be placed in the \`scratch/\` directory. Do not pollute the root workspace.

---

## 2. Implementation Methodology

### Phase A: Target Verification
- Inspect the targeted files and symbols before editing using \`view_file\` or \`grep_search\`.
- Validate line numbers, imports, and surrounding syntax before constructing file replacements.

### Phase B: Surgical Implementation
- Apply modifications in logical, verifiable increments following the task checklist in the approved plan.
- Ensure all public APIs, types, interfaces, and value objects maintain strict backward compatibility unless explicitly deprecated in the approved plan.
- Preserve existing documentation, comments, and project conventions.

### Phase C: Syntax & Type Validation
- After code edits, validate compiler cleanliness using \`npx tsc --noEmit\` via \`run_command\`.
- Do NOT execute test suites (\`npm test\`), linters, or \`critique\`.
- Rectify any syntax or typing errors before concluding.

---

## 3. Communication & Handoff

- Provide structured, concise status reports on completed checklist items.
- Reference modified files explicitly.
- When all plan items are satisfied and syntax compiles cleanly, report \`IMPLEMENTATION_DONE\` to the parent coordinator.` as const;

export const DEFAULT_GATE_SYSTEM_PROMPT = `# AgyLoop Quality Gate Subagent System Prompt

You are the **AgyLoop Quality Gate Verification Subagent**, an autonomous, rigorous test engineer and quality barrier in Google Antigravity.

Your primary purpose is to execute verification suites (typechecking, linting, build pipelines, unit/integration tests) inside an isolated shell environment, evaluate objective pass/fail verdicts, and shield the parent coordinator from verbose log pollution.

---

## 1. Operating Mandate & Safety Invariants

1. **Verification-Only Mandate**:
   - You are equipped exclusively with verification and inspection tools: \`run_command\` and \`view_file\`.
   - You are physically and procedurally restricted from modifying code files (\`write_to_file\`, \`replace_file_content\` are disabled).
   - Never attempt to modify or refactor workspace source files. If verification fails, isolate the diagnostics so the \`implementer\` subagent can address them.

2. **Log Isolation & Shielding Mandate**:
   - Compilers and test runners generate massive terminal output (hundreds or thousands of lines).
   - You must NEVER dump raw, unfiltered logs into the parent conversational context.
   - Buffer raw output, filter out noise (passing assertions, progress spinners), and extract actionable diagnostic signals (failure counts, exact error lines, stack traces).

---

## 2. Verification Methodology

### Phase A: Execution
- Execute verification commands sequentially (e.g. \`npm run typecheck\`, \`npm test\`).
- Track execution status, exit code, and runtime duration for each command.
- Respect execution timeouts strictly.
- ${SMOKE_SANDBOX_MANDATE}
- If testing root commands, you must run them in the isolated directory. ${SMOKE_SANDBOX_AGY_SUBAGENT_NOTE}

### Phase B: Diagnostics Extraction & Filtering
- When a command succeeds (exit code 0):
  - Extract headline metrics (e.g. test count, suite count, pass count).
  - Suppress verbose pass details.
- When a command fails (exit code != 0 or timeout):
  - Extract the specific failure block, error message, and stack trace.
  - Limit the diagnostic snippet to the top essential lines (omitting redundant boilerplate).

### Phase C: Structured Reporting
Produce a concise, structured Quality Gate report covering:
1. **Overall Verdict**: \`PASSED\` or \`FAILED\`.
2. **Execution Matrix**: Table of command label, exit code, duration, and status.
3. **Test Metrics**: Total tests executed, passed, failed, skipped.
4. **Diagnostic Details**: (Only if failed) concise failure snippet citing affected files and line numbers.` as const;

// ============================================================================
// Review Constants, Confidence Levels, Severities, and Thresholds
// ============================================================================

// Review Confidence Levels
export const CONFIDENCE_HIGH = 'High' as const;
export const CONFIDENCE_MEDIUM = 'Medium' as const;
export const CONFIDENCE_LOW = 'Low' as const;

export const REVIEW_CONFIDENCE_LEVELS = Object.freeze([
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_LOW
] as const);

export type ReviewConfidenceLevel = typeof REVIEW_CONFIDENCE_LEVELS[number];

// Review Finding Severities
export const SEVERITY_CRITICAL = 'critical' as const;
export const SEVERITY_ERROR = 'error' as const;
export const SEVERITY_WARNING = 'warning' as const;
export const SEVERITY_SUGGESTION = 'suggestion' as const;
export const SEVERITY_INFO = 'info' as const;

export const REVIEW_SEVERITIES = Object.freeze([
  SEVERITY_CRITICAL,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  SEVERITY_SUGGESTION,
  SEVERITY_INFO
] as const);

export type ReviewSeverity = typeof REVIEW_SEVERITIES[number];

// Severity Icons
export const SEVERITY_ICON_CRITICAL = '🔴' as const;
export const SEVERITY_ICON_ERROR = '🔴' as const;
export const SEVERITY_ICON_WARNING = '⚠️' as const;
export const SEVERITY_ICON_SUGGESTION = '💡' as const;
export const SEVERITY_ICON_INFO = 'ℹ️' as const;

export const SEVERITY_ICONS: Readonly<Record<ReviewSeverity, string>> = Object.freeze({
  [SEVERITY_CRITICAL]: SEVERITY_ICON_CRITICAL,
  [SEVERITY_ERROR]: SEVERITY_ICON_ERROR,
  [SEVERITY_WARNING]: SEVERITY_ICON_WARNING,
  [SEVERITY_SUGGESTION]: SEVERITY_ICON_SUGGESTION,
  [SEVERITY_INFO]: SEVERITY_ICON_INFO
});

// Resolver Sources & Filesystem Paths
export const RESOLVER_SOURCE_SIBLING = 'sibling' as const;
export const RESOLVER_SOURCE_BUNDLED = 'bundled' as const;
export const RESOLVER_SOURCE_USER_DATA = 'user_data' as const;
export const RESOLVER_SOURCE_USER_LOCAL = 'user_local' as const;
export const RESOLVER_SOURCE_SYSTEM_PATH = 'system_path' as const;
export const RESOLVER_SOURCE_NONE = 'none' as const;

export const RESOLVER_SOURCES = Object.freeze([
  RESOLVER_SOURCE_SIBLING,
  RESOLVER_SOURCE_BUNDLED,
  RESOLVER_SOURCE_USER_DATA,
  RESOLVER_SOURCE_USER_LOCAL,
  RESOLVER_SOURCE_SYSTEM_PATH,
  RESOLVER_SOURCE_NONE
] as const);

export type ResolverSource = typeof RESOLVER_SOURCES[number];

export const BINARY_CRITIQUE = 'critique' as const;
export const PATH_BUNDLED_CRITIQUE = 'bin/critique' as const;
export const PATH_BUNDLED_CRITIQUE_JS = 'bin/critique.js' as const;
export const PATH_USER_LOCAL_CRITIQUE = '.local/bin/critique' as const;
export const PATH_SIBLING_CRITIQUE_DIR = '../critique' as const;
export const REPO_CRITIQUE_GIT_URL = 'https://github.com/ajxcodes/critique.git' as const;
export const CRITIQUE_FLAG_JSON = '--json' as const;
export const CRITIQUE_FLAG_STAGED = '--staged' as const;
export const CRITIQUE_FLAG_BASE = '--base' as const;
export const CRITIQUE_BUILD_COMMAND = 'npm run build' as const;
export const PATH_USER_DATA_CRITIQUE_DIR = '.local/share/critique' as const;
export const PATH_USER_DATA_CRITIQUE_MAC = 'Library/Application Support/critique' as const;

export const CRITIQUE_GITHUB_OWNER = 'ajxcodes' as const;
export const CRITIQUE_GITHUB_REPO = 'critique' as const;
export const CRITIQUE_GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/ajxcodes/critique/releases/latest' as const;
export const CRITIQUE_UPDATE_TTL_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms (24 hours)
export const CRITIQUE_CACHE_FILENAME = 'critique-update-cache.json' as const;
export const DEFAULT_CRITIQUE_CHECK_TIMEOUT_MS = 3000 as const;
export const DEFAULT_CRITIQUE_DOWNLOAD_TIMEOUT_MS = 15000 as const;
export const CRITIQUE_EXECUTABLE_PERMISSIONS = 0o755;

export const COMMAND_CRITIQUE = 'critique' as const;
export const CRITIQUE_SUBCOMMAND_STATUS = 'status' as const;
export const CRITIQUE_SUBCOMMAND_INSTALL = 'install' as const;
export const CRITIQUE_SUBCOMMAND_UPDATE = 'update' as const;

export const CRITIQUE_SUBCOMMANDS = Object.freeze([
  CRITIQUE_SUBCOMMAND_STATUS,
  CRITIQUE_SUBCOMMAND_INSTALL,
  CRITIQUE_SUBCOMMAND_UPDATE
] as const);

export type CritiqueSubcommand = typeof CRITIQUE_SUBCOMMANDS[number];

export const ENV_FILE_NAME = '.env' as const;
export const ENV_VAR_GEMINI_API_KEY = 'GEMINI_API_KEY' as const;

// Regular Expressions
export const REGEX_ENV_KEY_VAL = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/;
export const REGEX_JSON_CODE_BLOCK = /```(?:json)?\s*([\s\S]*?)\s*```/;
export const REGEX_SEVERITY = /^(critical|error|warning|suggestion|info)$/i;
export const REGEX_CONFIDENCE = /^(high|medium|low)$/i;

// Messages & Headings
export const BANNER_REVIEW_TITLE = '# 🤖 Independent AI PR Review' as const;
export const BANNER_CODE_COMMENTS = '## 📝 Code Comments' as const;
export const BANNER_SUMMARY = '## Summary' as const;
export const MSG_NO_DIFF_FOUND = 'No diff found. Exiting.' as const;
export const MSG_CLEAN_DIFF_REVIEW = 'No uncommitted changes or working tree diff found.' as const;
export const MSG_NO_ISSUES_FOUND = '*No issues found! Great job!* 🚀' as const;
export const MSG_CRITIQUE_NOT_FOUND =
  'Critique CLI binary not found. Please install critique or place it on PATH, ~/.local/bin, or as sibling ../critique.' as const;
export const DEFAULT_NO_UNRESOLVED_THREADS_TEXT = 'No unresolved previous issues.' as const;

export const DIFF_EXCLUDED_PATHSPECS = Object.freeze([
  ':!package-lock.json',
  ':!pnpm-lock.yaml',
  ':!yarn.lock',
  ':!bun.lockb',
  ':!dist/',
  ':!build/'
] as const);

export const DIFF_EXCLUDED_PATTERNS = Object.freeze([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'dist/',
  'build/'
] as const);

export const DIFF_EXCLUDE_ARGS = "':!package-lock.json' ':!pnpm-lock.yaml' ':!yarn.lock' ':!bun.lockb' ':!dist/' ':!build/'" as const;

export const MAX_INLINE_DIFF_LINES = 1000 as const;

export const DEFAULT_REVIEWER_SUBAGENT_SYSTEM_PROMPT = `# AgyLoop AI Reviewer Subagent System Prompt

You are the **AgyLoop AI Reviewer Subagent**, an autonomous, rigorous code reviewer and quality gatekeeper in Google Antigravity.

Your primary purpose is to perform independent, comprehensive pre-commit and PR code reviews against working diffs, validating correctness, architectural alignment, standards compliance, and acceptance criteria fulfillment.

---

## 1. Operating Mandate & Safety Guarantees

1. **Read-Only Inspection Tools**:
   - You have access strictly to inspection tools: \`view_file\`, \`grep_search\`, \`find_by_name\`, \`list_dir\`, and \`run_command\` (for diff inspection and critique execution).
   - You are strictly forbidden from modifying source files (\`write_to_file\` and \`replace_file_content\` are disabled).

2. **Objective Standards Enforcement**:
   - Inspect all modifications against repository standards (e.g. \`.github/critique.md\`, \`.critique.md\`, \`.github/ai-reviewer-standards.md\`, \`AGENTS.md\`, clean architecture rules).
   - Zero tolerance for magic strings, magic numbers, missing error types, or architectural boundary leaks.

3. **Rigorous Acceptance Criteria Verification**:
   - Verify each Acceptance Criterion specified in the approved implementation plan.
   - Ground any claim of unfulfilled criteria with exact file locations and reasoning.

---

## 2. Review Methodology

1. **Diff & Critique Inspection**:
   - Run \`critique\` (or consume its automated findings) and \`git diff\` via \`run_command\`.
   - Cross-reference findings with \`.github/critique.md\` standards and the approved implementation plan's Acceptance Criteria.
   - Trace callers and examine affected files using \`view_file\` and \`grep_search\`.

2. **Categorized Findings**:
   - Classify findings strictly by severity: \`critical\`, \`error\`, \`warning\`, \`suggestion\`, or \`info\`.
   - Any \`critical\` or \`error\` finding from \`critique\` or manual inspection, or any unfulfilled Acceptance Criterion mandates \`REVIEW_STATUS: CHANGES_REQUESTED\`.
   - Provide concrete, actionable remediation steps for every finding.

---

## 3. Structured Review Verdict Protocol

You MUST emit a structured verdict block adhering strictly to the following format:

\`\`\`markdown
REVIEW_STATUS: APPROVED | CHANGES_REQUESTED
REVIEW_SUMMARY: <High-level summary of review findings and verdict rationale>
UNFULFILLED_AC:
- <Unfulfilled criterion 1> (or "None" if all criteria are fulfilled)
REMEDIATION_GUIDANCE:
- <Actionable remediation item 1> (or "None" if approved)
\`\`\`

If all Acceptance Criteria are met, repository standards are respected, and no critical/error issues exist, set \`REVIEW_STATUS: APPROVED\`. Otherwise, set \`REVIEW_STATUS: CHANGES_REQUESTED\`.` as const;

// ============================================================================
// Conventional Commit Types, Regexes, Tokens & Approval Gate Constants
// ============================================================================

export const COMMIT_TYPE_FEAT = 'feat' as const;
export const COMMIT_TYPE_FIX = 'fix' as const;
export const COMMIT_TYPE_REFACTOR = 'refactor' as const;
export const COMMIT_TYPE_TEST = 'test' as const;
export const COMMIT_TYPE_CHORE = 'chore' as const;
export const COMMIT_TYPE_PERF = 'perf' as const;
export const COMMIT_TYPE_DOCS = 'docs' as const;
export const COMMIT_TYPE_STYLE = 'style' as const;
export const COMMIT_TYPE_BUILD = 'build' as const;
export const COMMIT_TYPE_CI = 'ci' as const;

export const CONVENTIONAL_COMMIT_TYPES = Object.freeze([
  COMMIT_TYPE_FEAT,
  COMMIT_TYPE_FIX,
  COMMIT_TYPE_REFACTOR,
  COMMIT_TYPE_TEST,
  COMMIT_TYPE_CHORE,
  COMMIT_TYPE_PERF,
  COMMIT_TYPE_DOCS,
  COMMIT_TYPE_STYLE,
  COMMIT_TYPE_BUILD,
  COMMIT_TYPE_CI
] as const);

export type ConventionalCommitType = typeof CONVENTIONAL_COMMIT_TYPES[number];

export const REGEX_CONVENTIONAL_HEADER =
  // eslint-disable-next-line no-useless-escape
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9_.\-\/]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/i;
export const REGEX_BREAKING_CHANGE_FOOTER =
  /^BREAKING[ -]CHANGE:\s*(.+)$/im;
export const REGEX_DIFF_FILE_HEADER =
  /^diff --git\/(.+?) b\/(.+?)$/gm;
export const REGEX_ISSUE_NUMBER_REF = /#(\d+)/;
export const REGEX_POSITIONAL_ISSUE_ID = /^#?(\d+)$/;
export const REGEX_LEADING_CONVENTIONAL_PREFIX =
  /^(?:\[(?:task|feat|feature|fix|bug|refactor|chore|perf|docs)\]\s*(?:phase\s*\d+:?\s*)?|feat|fix|refactor|chore|test|perf|docs|style):\s*/i;

export const TOKEN_BREAKING_CHANGE = 'BREAKING CHANGE:' as const;
export const TOKEN_BREAKING_EXCLAMATION = '!' as const;

export const PROMPT_CONFIRM_COMMIT = 'Commit staged changes with message? (y/N): ' as const;
export const CONFIRMATION_AFFIRMATIVE_RESPONSES = Object.freeze(['y', 'yes'] as const);
export const NOTE_COMMIT_CONFIRMED = 'Commit confirmed and executed' as const;
export const NOTE_COMMIT_SKIPPED = 'Commit skipped by user' as const;
export const NOTE_COMMIT_AUTO_APPROVED = 'Commit auto-approved' as const;
export const NOTE_COMMIT_REJECTED = 'Commit rejected by user' as const;

export const HEADER_COMMIT_DRAFT_REPORT = '=== CodeLoop: Conventional Commit Draft ===' as const;
export const SECTION_COMMIT_DETAILS_TITLE = '## Commit & Release Details' as const;

// ============================================================================
// Operational Modes, Flags, Gate Names & Lifecycle Notes
// ============================================================================

export const GATE_APPROVAL = 'APPROVAL' as const;
export const GATE_COMMIT = 'COMMIT' as const;
export const GATE_TRIAGE = 'TRIAGE' as const;
export const GATE_CIRCUIT_BREAKER = 'CIRCUIT_BREAKER' as const;

export const LIFECYCLE_GATES = Object.freeze({
  APPROVAL: GATE_APPROVAL,
  COMMIT: GATE_COMMIT,
  TRIAGE: GATE_TRIAGE,
  CIRCUIT_BREAKER: GATE_CIRCUIT_BREAKER
});

export type LifecycleGateName = typeof LIFECYCLE_GATES[keyof typeof LIFECYCLE_GATES];

/**
 * Gates whose pause exists *precisely* to wait for a human decision.
 *
 * A stage transition must never auto-consume these:
 * - APPROVAL / COMMIT: `TransitionStageUseCase` only transitions out of them
 *   after the human answered, and the surviving pause is what `codeloop status`
 *   and the lifecycle result report as "waiting on you".
 * - TRIAGE: the run returns control to the human, who must triage the PR
 *   review comments before the pipeline can move again.
 *
 * Every other gate name is a *mechanical* halt (today only
 * `GATE_CIRCUIT_BREAKER`, raised by an exhausted retry budget or a quota
 * rejection). Nothing about it needs a human: once the machine transitions
 * again the blocking condition is gone, so the pause is stale by construction
 * and `StateMachine.transition()` consumes it.
 *
 * Typed `readonly string[]` (not `LifecycleGateName[]`) because
 * `StateMachine.pausedAtGate` is a plain `string` — a checkpoint persisted by an
 * older schema may carry a gate name this build does not know, and an unknown
 * gate must be treated as non-human (consumed) rather than kept forever.
 */
export const HUMAN_WAIT_GATES: readonly string[] = Object.freeze([
  GATE_APPROVAL,
  GATE_COMMIT,
  GATE_TRIAGE
]);

export const NOTE_LIFECYCLE_STARTED = 'Lifecycle execution started' as const;
export const NOTE_LIFECYCLE_COMPLETED = 'Lifecycle completed successfully' as const;
export const NOTE_PAUSED_APPROVAL_GATE = 'Paused at plan approval gate' as const;
export const NOTE_PAUSED_COMMIT_GATE = 'Paused at conventional commit gate' as const;
export const NOTE_PAUSED_TRIAGE_GATE = 'Paused at PR review comments triage gate' as const;
export const NOTE_YOLO_PARKED_AT_DISCOVERY =
  'Bug issue parked at DISCOVERY for RCA — YOLO cannot dispatch subagents inline. Run `codeloop next` to dispatch the discovery subagent, then re-run `codeloop yolo` (use `codeloop resume` first if a pause is recorded). State is checkpointed; nothing is lost.' as const;
/**
 * Re-entry park (issue #237): distinct from NOTE_YOLO_PARKED_AT_DISCOVERY because
 * the operator DID re-run after the park, so the outstanding work is the RCA
 * report itself rather than "dispatch the discovery subagent".
 */
export const NOTE_DISCOVERY_PARK_AWAITING_RCA =
  'Parked at DISCOVERY for RCA: the discovery report is still an unpopulated scaffold. Run `codeloop next` to dispatch the discovery subagent, populate the report, then re-run (`codeloop resume` first if a pause is recorded). Pass `--skip-discovery` to bypass the RCA gate explicitly. State is checkpointed; nothing is lost.' as const;
/**
 * Recorded in history metadata when `codeloop next --restart` re-opens a
 * COMPLETED checkpoint, so the destructive reset is auditable from `status`.
 */
export const NOTE_RESTARTED_FROM_COMPLETED =
  'Re-opened planning from a COMPLETED checkpoint (explicit --restart)' as const;
export const NOTE_TRIAGE_ROUTED = 'Triage completed: routed to target stage' as const;
/**
 * Recorded when a dispatched reviewer's verdict arrives while the pipeline
 * already rests at the COMMIT gate (issue #269).
 *
 * The commit gate is where the live defect was observed: the gate reported
 * "No AI review verdict is recorded for this task" while the reviewer was
 * holding a genuine APPROVED verdict that had no channel to reach the
 * checkpoint. The review is therefore re-opened through the legal route
 * `COMMIT -> QUALITY_GATE -> REVIEW` — the transition table is NOT widened.
 */
export const NOTE_REVIEW_REOPENED_FROM_COMMIT =
  'Review re-opened to record the dispatched Reviewer Subagent verdict' as const;
export const NOTE_AUTO_APPROVED_PLAN = 'Plan auto-approved in YOLO mode' as const;
export const NOTE_COMMIT_AFTER_EXECUTED = 'Commit automatically executed via --commit-after' as const;
export const NOTE_ALREADY_COMPLETED = 'Pipeline already completed' as const;
export const NOTE_WORKTREE_CREATED = 'Isolated git worktree provisioned' as const;
export const NOTE_WORKTREE_REMOVED = 'Isolated git worktree detached and cleaned' as const;
export const NOTE_WORKTREE_PRUNED = 'Dangling git worktrees pruned' as const;
/**
 * Removal post-condition notes (issue #282).
 *
 * `codeloop worktree remove` used to delete the directory and say nothing about
 * the checkpoint, so the tool kept advertising a worktree that was gone
 * (absorbed #273). The removal now REPORTS which of the three descriptor
 * outcomes it reached, single-sourced here so no call site invents its own
 * wording. No emoji: the CLI owns the `✓` / `✗` / `⚠` prefix.
 */
export const NOTE_WORKTREE_CHECKPOINT_CLEARED =
  'checkpoint descriptor cleared (this task no longer records a worktree)' as const;
/**
 * The same post-condition when the checkpoint that named the removed path was
 * NOT the operator's task checkpoint (e.g. a root `.agyloop/state.json` written
 * by an older build). "This task no longer records a worktree" would be a lie
 * in that case, so the scope is stated instead (#282 review).
 */
export const NOTE_WORKTREE_CHECKPOINT_CLEARED_SCOPE =
  'checkpoint descriptor cleared (a checkpoint that named the removed path no longer records it)' as const;
export const NOTE_WORKTREE_CHECKPOINT_UNCHANGED =
  'checkpoint descriptor unchanged (it did not point at the removed path)' as const;
export const NOTE_WORKTREE_CHECKPOINT_UNREADABLE =
  'checkpoint descriptor could not be read or updated, so it was left as it was' as const;
/**
 * Reported when the operator asks to repair a stale descriptor
 * (`worktree remove <id> --prune-stale`) without a live worktree directory.
 */
export const NOTE_WORKTREE_STALE_PRUNED = 'Stale worktree descriptor pruned' as const;
export const NOTE_WORKTREE_STALE_ABSENT =
  'No checkpoint recorded a worktree at the requested path' as const;
/**
 * Reported by the READ-ONLY diagnostics (`branch-info`, `next`) when a
 * checkpoint advertises a worktree whose directory is gone. Naming the
 * remediation keeps the operator from hand-editing the checkpoint — and the
 * remediation MUST be a command that actually succeeds for a missing directory,
 * which is why it carries `--prune-stale`: the plain removal correctly refuses
 * a path that does not exist (#282 AC-2, review iteration 2).
 *
 * `{id}` is substituted by the presentation layer, which knows the task token.
 */
export const NOTE_WORKTREE_STALE =
  'stale descriptor — the worktree directory does not exist; run `codeloop worktree remove {id} --prune-stale` to clear it' as const;

// ============================================================================
// Emergency Abort quarantine scope (issue #266)
// ============================================================================

/**
 * `abort` used to quarantine EVERY worktree the repository registered —
 * including other tasks' and external ones — so aborting one task emptied
 * every other task's in-flight work (#266, live #250 instance). These notes
 * single-source the reasons an operator is told about a worktree the abort did
 * NOT touch, so no call site invents its own wording.
 */
/** The checkpoint records no worktree: nothing may be quarantined. */
export const NOTE_ABORT_NO_WORKTREE_RECORDED =
  'this checkpoint records no worktree — nothing to quarantine' as const;

/** The descriptor names a path this repository does not register under `.worktrees`. */
export const NOTE_ABORT_WORKTREE_NOT_REGISTERED =
  'not a registered worktree of this repository (stale descriptor or external worktree) — left untouched' as const;

/** The descriptor names the directory the abort was invoked from. */
export const NOTE_ABORT_WORKTREE_CWD =
  'current working directory — left untouched (run `codeloop abort` from the repository root to quarantine it, or pass --no-quarantine to silence this)' as const;

/** `--no-quarantine` / `--keep-worktrees`. */
export const NOTE_ABORT_QUARANTINE_DISABLED =
  'quarantine disabled by --no-quarantine — left untouched' as const;

/** The worktree was already clean. */
export const NOTE_ABORT_WORKTREE_CLEAN = 'already clean — nothing to quarantine' as const;

/** No abort run may ever quarantine a worktree outside `<repo>/.worktrees` (AC-3). */
export const NOTE_ABORT_EXTERNAL_NEVER_QUARANTINED =
  'external worktrees are never quarantined' as const;

/** Adapter omitted the optional `quarantineWorktree` capability. */
export const NOTE_ABORT_QUARANTINE_UNSUPPORTED =
  'quarantine is not supported by this adapter' as const;

/** Report label for a worktree that recorded nothing. */
export const NOTE_ABORT_NO_WORKTREE_LABEL =
  'NONE (this checkpoint records no worktree)' as const;

// --- Missing worktree descriptor (issue #287 B / #266 D5) ---

/**
 * `next` at IMPLEMENT with `worktree: null`. `{command}` is filled by the
 * application layer, which knows the issue token.
 */
export const NOTE_WORKTREE_MISSING_REPROVISION =
  'No isolated worktree is recorded for this checkpoint, so the IMPLEMENT stage cannot dispatch a subagent. Re-provision it with `{command}` (an existing task branch is reused). If direct root execution was intended, re-run with `--no-worktree`.' as const;

// ============================================================================
// Implementation Evidence (issue #259)
// ============================================================================

/**
 * Untracked path prefixes that are the TOOL's own bookkeeping or that are
 * symlinked into a task worktree.
 *
 * They are never evidence of an implementation: `git status --porcelain`
 * reports `?? node_modules`, `?? artifacts` and `?? .agyloop` in EVERY worktree
 * run (the worktree manager links all three), and the plan scaffold writes
 * `artifacts/plans/` plus the workspace `.gitignore`.
 *
 * The filter applies to UNTRACKED entries only. A TRACKED modification to any
 * of these paths is a real implementation and is always counted.
 */
export const IMPLEMENTATION_EVIDENCE_EXCLUDED_PREFIXES: readonly string[] = Object.freeze([
  '.agyloop/',
  '.codeloop/',
  'artifacts/',
  'node_modules/',
  '.worktrees/',
  'dist/',
  'build/',
  'coverage/',
  'prompts/',
  'rules/',
  'skills/',
  'integrations/',
  'templates/'
]);

/**
 * Untracked files that are the tool's own bookkeeping, plus the lock files the
 * tool already excludes from every diff (`DIFF_EXCLUDE_ARGS`).
 */
export const IMPLEMENTATION_EVIDENCE_EXCLUDED_FILES: readonly string[] = Object.freeze([
  'plugin.json',
  '.gitignore',
  'config.default.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb'
]);

/**
 * The short, honest reason a run refused to advance: nothing was implemented.
 *
 * Used in the lifecycle result message and in the operator-facing ⚠ block. It
 * is NOT written into the state-machine history — a park performs no
 * `transition()`, and history entries are only appended by `transition()`.
 */
export const NOTE_IMPLEMENTATION_EVIDENCE_MISSING =
  'Implementation produced no changes — refusing to advance to quality gates' as const;

/**
 * The full park message for the YOLO fast-path (issue #259). `{baseRef}` is
 * substituted with the reference the probe actually compared against.
 */
export const NOTE_YOLO_NO_IMPLEMENTATION =
  "Implementation produced no changes — refusing to advance to quality gates. The working tree is unchanged relative to '{baseRef}', so no implementation was detected. The YOLO fast-path prepares the implementation but cannot execute the plan (agyloop dispatches subagents, it does not run them): run `codeloop next` to dispatch the Code Implementation Subagent, then re-run `codeloop yolo`. State is checkpointed at IMPLEMENT; nothing is lost." as const;

/**
 * Continuation lines of the operator-facing park block (stderr).
 */
export const NOTE_IMPLEMENTATION_PARK_UNCHANGED =
  "Working tree is unchanged relative to '{baseRef}' — no implementation was detected." as const;
export const NOTE_IMPLEMENTATION_PARK_DISPATCH =
  'The YOLO fast-path prepares the implementation but cannot execute the plan (agyloop dispatches subagents, it does not run them).' as const;
export const NOTE_IMPLEMENTATION_PARK_NEXT =
  'Next: run `codeloop next` to dispatch the Code Implementation Subagent, then re-run `codeloop yolo`.' as const;

/**
 * The plan-empty advisory (issue #259, S10).
 *
 * `codeloop yolo` never dispatches the PLANNER either, so the fast-path's
 * plan is the tool's own blank scaffold — every heading empty, every
 * `**Step N:**` marker without a value. Dispatching the implementer with that
 * document would hand it nothing to execute, so the park says so instead.
 * `{planPath}` names the plan the implementer would have received.
 */
export const NOTE_IMPLEMENTATION_PLAN_EMPTY =
  "The plan at '{planPath}' is still the blank scaffold — the implementer would receive an empty plan" as const;

/**
 * The continuation line of the plan-empty advisory. It REPLACES
 * `NOTE_IMPLEMENTATION_PARK_NEXT` — printing both would tell the operator to
 * dispatch an implementer that has nothing to execute.
 *
 * Issue #267: the path it names must be REACHABLE. `codeloop next` now returns
 * the PLANNER directive (not the implementer) while the plan is blank, and
 * `--plan-path` can supply a plan the operator already wrote. The
 * Architectural Planning Subagent is no longer the sole, unreachable route.
 * `{issue}` is optional: the fallback text stays valid without it.
 */
export const NOTE_IMPLEMENTATION_PLAN_EMPTY_NEXT =
  'Next: run `codeloop next` to obtain the planner directive (or supply your own plan with `codeloop implement --plan-path <file>`), then re-run `codeloop next` to dispatch the Code Implementation Subagent once the plan is non-blank.' as const;

/**
 * The full park message for a YOLO run whose plan is still the blank
 * scaffold. `{baseRef}` is the reference the probe compared against and
 * `{planPath}` names the empty plan.
 *
 * Issue #267: the recovery route is named as the commands the operator can
 * actually run — `codeloop next` (planner directive) or `--plan-path`.
 */
export const NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN =
  "Implementation produced no changes — refusing to advance to quality gates. The working tree is unchanged relative to '{baseRef}', so no implementation was detected. The plan at '{planPath}' is still the blank scaffold (no implementation steps), so dispatching the implementer now would give it nothing to execute: run `codeloop next` to obtain the planner directive (or supply your own plan with `codeloop implement --plan-path <file>`), then run `codeloop next` again. State is checkpointed at IMPLEMENT; nothing is lost." as const;

/**
 * A REPEATED blank-plan park (issue #267, AC-A5).
 *
 * The second occurrence must not read identically to the first: it says how
 * many attempts have been observed, so a re-run with no intervening action is
 * visibly not progress. `{count}` is the recorded park count, `{baseRef}` the
 * probe reference and `{planPath}` the still-blank plan.
 */
export const NOTE_YOLO_NO_IMPLEMENTATION_EMPTY_PLAN_REPEAT =
  "Implementation produced no changes — refusing to advance to quality gates (attempt {count}, the plan is STILL blank). The working tree is unchanged relative to '{baseRef}', so no implementation was detected. The plan at '{planPath}' carries no implementation steps; nothing has changed since the previous park. Run `codeloop next` to obtain the planner directive (or supply a plan with `codeloop implement --plan-path <file>`). State is checkpointed at IMPLEMENT; nothing is lost." as const;

/**
 * The CLI stderr advisory for the SECOND and later blank-plan park
 * (issue #267, AC-A5): `{planPath}` and the attempt `{count}`.
 */
export const NOTE_IMPLEMENTATION_PLAN_EMPTY_REPEAT =
  "The plan at '{planPath}' is STILL the blank scaffold (attempt {count}); no plan was written since the previous park" as const;

/**
 * The VACUOUS gate verdict line: the gates refused to certify a tree that
 * contains no implementation, so NO gate command was executed.
 */
export const MSG_GATE_VACUOUS =
  "VACUOUS — no implementation detected (working tree unchanged relative to '{baseRef}'); quality gate commands were NOT executed." as const;

/**
 * The report label for the implementation-evidence line.
 */
export const LABEL_IMPLEMENTATION_EVIDENCE = 'Implementation' as const;

/**
 * The implementation-evidence line appended to a gate report that DID run:
 * `Implementation : 3 file(s) changed relative to 'main'`.
 */
export const LABEL_IMPLEMENTATION_EVIDENCE_LINE =
  "{label} : {count} file(s) changed relative to '{baseRef}'" as const;

/**
 * Lifecycle refusal messages for a VACUOUS gate verdict. A VACUOUS verdict is
 * NOT a failure: nothing was reverted, because the stage was never advanced.
 */
export const NOTE_GATES_VACUOUS_STANDARD =
  "Quality gates refused to certify an unimplemented tree (VACUOUS) — the working tree is unchanged relative to '{baseRef}'. Pipeline stays at IMPLEMENT." as const;
export const NOTE_GATES_VACUOUS_YOLO =
  'Quality gates refused to certify an unimplemented tree (VACUOUS) — refusing to advance.' as const;

/**
 * The label of the base-freshness line in the gate report (issue #263).
 */
export const LABEL_BASE_FRESHNESS = 'Base freshness' as const;

/**
 * `Base freshness : 2 commit(s) behind 'main' (this branch owns 1; branch point 1823dbf)`
 *
 * `{ahead}` counts commits the base ref has since the branch point; `{own}` counts the
 * branch's own commits; `{mergeBase}` is the first 7 characters of the branch point SHA.
 * The base ref is the LOCAL ref (no `git fetch`), so a base that moved only on the remote
 * is not detected.
 */
export const LABEL_BASE_FRESHNESS_LINE =
  "{label} : {ahead} commit(s) behind '{baseRef}' (this branch owns {own}; branch point {mergeBase})" as const;

/** The gate-report warning for an unmeasurable branch diff (issue #263). */
export const MSG_GATE_UNMEASURABLE =
  "Could not measure this branch's own changes: {error}. The implementation count above comes from 'git status' only." as const;

/** The stale-worktree advisory (issue #263). `{mergeBase}` is the short branch point. */
export const NOTE_IMPLEMENTATION_STALE_WORKTREE =
  "Stale worktree — this branch is {ahead} commit(s) behind '{baseRef}' (branch point {mergeBase}); the gate would validate a build the base branch no longer contains." as const;

/** The CLI's second line when the branch diff could not be measured (issue #263). */
export const NOTE_IMPLEMENTATION_UNMEASURABLE =
  "This branch's own changes could not be measured against '{baseRef}' ({error}) — 'git status' found no implementation, so the tree cannot be certified." as const;

/** The full YOLO park message when the branch diff could not be measured (issue #263). */
export const NOTE_YOLO_NO_IMPLEMENTATION_UNMEASURABLE =
  "Implementation produced no changes — refusing to advance to quality gates. 'git status' found no implementation and this branch's own changes could not be measured against '{baseRef}' ({error}), so the tree cannot be certified. State is checkpointed at IMPLEMENT; nothing is lost." as const;

// ============================================================================
// PR Comment Severity Markers & Dismissal Reporting
// ============================================================================

/**
 * The categories a PR review comment can be classified into. These mirror the
 * `PRCommentCategory` contract carried by the GitHub gateway port.
 */
export const PR_CATEGORY_ERROR = 'error' as const;
export const PR_CATEGORY_SUGGESTION = 'suggestion' as const;
export const PR_CATEGORY_QUESTION = 'question' as const;
export const PR_CATEGORY_INFO = 'info' as const;
export const PR_CATEGORY_GENERAL = 'general' as const;

/**
 * Every category a PR review comment can be classified into.
 *
 * The list lives in the domain so the classifier and the gateway port contract
 * cannot drift apart.
 */
export const PR_CATEGORIES = Object.freeze([
  PR_CATEGORY_ERROR,
  PR_CATEGORY_SUGGESTION,
  PR_CATEGORY_QUESTION,
  PR_CATEGORY_INFO,
  PR_CATEGORY_GENERAL
] as const);

export type PRCategory = typeof PR_CATEGORIES[number];

/**
 * The severity-to-category mapping the comment classifier obeys.
 *
 * The mapping is CONSISTENT: a severity never contradicts its category.
 * `critical`/`error` are ERROR, `warning`/`suggestion` are SUGGESTION, and
 * `info` is informational — INFO.
 *
 * Two categories sit outside the mapping on purpose: QUESTION (a comment that
 * IS a question) and GENERAL (a comment with no marker at all — it carries
 * the informational severity because nothing about it is blocking). An
 * informational FINDING (`ℹ️ **INFO**`) is therefore never rendered as
 * `[GENERAL]` — that conflation was the defect.
 */
export const PR_SEVERITY_CATEGORY_MAPPING: Readonly<Record<ReviewSeverity, PRCategory>> =
  Object.freeze({
    [SEVERITY_CRITICAL]: PR_CATEGORY_ERROR,
    [SEVERITY_ERROR]: PR_CATEGORY_ERROR,
    [SEVERITY_WARNING]: PR_CATEGORY_SUGGESTION,
    [SEVERITY_SUGGESTION]: PR_CATEGORY_SUGGESTION,
    [SEVERITY_INFO]: PR_CATEGORY_INFO
  });

/**
 * The markers that are not severities of their own: `**QUESTION**` selects the
 * question category, `**NIT**` is a non-blocking suggestion.
 */
export const PR_MARKER_QUESTION = 'question' as const;
export const PR_MARKER_NIT = 'nit' as const;

/**
 * The markdown bold form of a marker — the form the review bots actually emit
 * (`ℹ️ **INFO**`, `💡 **SUGGESTION**`, `**CRITICAL**`, `**ERROR**`, `**WARNING**`).
 */
export const PR_MARKDOWN_MARKER_TEMPLATE = '**{marker}**' as const;

/**
 * The legacy bracket form of a marker (`[error]`, `[critical]`, ...). It is
 * still honoured so callers that rely on it keep working.
 */
export const PR_BRACKET_MARKER_TEMPLATE = '[{marker}]' as const;

/**
 * Operator-facing labels for the dismissal report. The dismissal route has to
 * report what it actually achieved, so every count it prints is labelled.
 */
export const LABEL_DISMISS_THREADS = 'Inline threads' as const;
export const LABEL_DISMISS_CONVERSATION = 'PR conversation' as const;
export const LABEL_DISMISS_FAILURES = 'Failures' as const;
export const LABEL_DISMISS_SURFACES = 'Surfaces' as const;

/**
 * What the surfaces line shows when the dismissal touched no surface at all.
 */
export const LABEL_DISMISS_NO_SURFACE = '(none)' as const;

/**
 * The outcome shown on the `Triage Action` line. A dismissal that only
 * partially succeeded must never be reported as an unqualified success.
 */
export const DISMISS_OUTCOME_COMPLETE = 'DISMISS' as const;
export const DISMISS_OUTCOME_PARTIAL = 'DISMISS (PARTIAL)' as const;
export const DISMISS_OUTCOME_FAILED = 'DISMISS (FAILED)' as const;
export const DISMISS_OUTCOME_NOTHING = 'DISMISS (NOTHING DISMISSED)' as const;

/** Why the dismissal route had nothing to dismiss. */
export const NOTE_DISMISS_NO_NOTES = 'no dismissal notes were provided (-m "<notes>")' as const;
export const NOTE_DISMISS_NO_PR = 'no pull request was resolved for this issue' as const;
export const NOTE_DISMISS_NO_GATEWAY = 'the GitHub gateway is unavailable' as const;

/**
 * The generic reason used when a dismissal report carries no more specific
 * reason for having dismissed nothing.
 */
export const NOTE_DISMISS_NOTHING = 'nothing was dismissed' as const;

/**
 * Why a dismissal that ran answered, resolved and skipped nothing at all.
 *
 * The dismissal route may run and find no feedback to act on — for example
 * when the comment fetch failed silently and the gateway listed no threads.
 * Such a run dismissed nothing, so it must never wear the unqualified success
 * line.
 */
export const NOTE_DISMISS_NOTHING_HANDLED =
  'the dismissal ran but no review feedback was handled' as const;

/**
 * The header the review bot puts on a PR conversation summary:
 * `**Review feedback on \`src/app.ts\` (Line 42):**`.
 */
export const REGEX_PR_FEEDBACK_HEADER = /^\s*\*\*Review feedback on `[^`]*`[^*]*\*\*/;

/**
 * The attribution footer the review bot appends: `*Powered by ...*`.
 */
export const REGEX_PR_FEEDBACK_FOOTER = /\*Powered by[^*]*\*\s*$/;

/**
 * Why the inline review threads could not be dismissed: the gateway does not
 * implement the thread surface.
 */
export const MSG_DISMISS_NO_THREAD_SUPPORT =
  'the GitHub gateway cannot list or resolve review threads' as const;

/**
 * Why a PR conversation comment could not be answered: it carries no id.
 */
export const MSG_DISMISS_NO_CONVERSATION_ID =
  'the conversation comment carries no id, so it cannot be answered' as const;

/**
 * Why the PR conversation surface could not be answered: the gateway does not
 * implement it.
 */
export const MSG_DISMISS_NO_CONVERSATION_SUPPORT =
  'the GitHub gateway cannot post replies on the PR conversation surface' as const;

/**
 * How many individual failures the operator-facing output spells out. The
 * count is always exact; only the detail list is truncated, so a run that hit
 * one rate limit on 28 threads stays readable.
 */
export const DISMISS_FAILURE_DETAIL_LIMIT = 10 as const;

/**
 * Why a PR conversation comment was not answered a second time.
 */
export const NOTE_DISMISS_DUPLICATE_FEEDBACK = 'duplicate feedback' as const;

/**
 * Why a PR conversation comment was skipped: the PR's own state proves it was
 * already answered (another comment references its id, or its inline review
 * thread carries the tool's dismissal MARKER).
 *
 * The thread's resolution state is not that proof: the review bot
 * auto-resolves the threads it creates, so a resolved thread can be entirely
 * unanswered.
 */
export const NOTE_DISMISS_ALREADY_ANSWERED = 'already answered' as const;

/**
 * Why a PR conversation comment was ignored altogether: it is the tool's own
 * dismissal reply, not review feedback.
 */
export const NOTE_DISMISS_OWN_REPLY = 'own dismissal reply' as const;

/**
 * Why an unmarked conversation comment was ignored: it is a PRIOR ANSWER the
 * tool cannot attribute, so answering it would be a third reply to the same
 * feedback.
 */
export const NOTE_DISMISS_PRIOR_ANSWER = 'unmarked prior answer' as const;

/**
 * The footer of a PR conversation dismissal reply. GitHub has no threaded
 * reply for conversation comments, so the reply quotes the comment it answers.
 */
export const DISMISS_CONVERSATION_REPLY_FOOTER =
  'Dismissing this PR conversation comment:' as const;

/**
 * The prefix of the reference a dismissal reply carries for the comment it
 * answers. It is what makes a dismissal reply recognisable as the tool's own.
 */
export const DISMISS_CONVERSATION_REPLY_REFERENCE_PREFIX =
  'Answering PR conversation comment:' as const;

/**
 * The canonical reference a dismissal reply carries for the comment it
 * answers. `{permalink}` is substituted with the comment's permalink.
 */
export const DISMISS_CONVERSATION_REPLY_REFERENCE =
  'Answering PR conversation comment: {permalink}' as const;

/**
 * The permalink of a PR conversation comment. The reference above carries it,
 * and its `#issuecomment-<id>` fragment is what makes the reply's target
 * machine-readable: a later run can tell WHICH comment was answered.
 */
export const DISMISS_CONVERSATION_PERMALINK_TEMPLATE =
  'https://github.com/{repo}/pull/{prNumber}#issuecomment-{commentId}' as const;

/**
 * The fragment that identifies the conversation comment a dismissal reply
 * answers. Every reference the tool posts ends with it, so the ids of the
 * comments that were answered can be read back off the PR's conversation.
 */
export const REGEX_DISMISS_CONVERSATION_REFERENCE = /#issuecomment-(\d+)/g;

/**
 * The marker the tool appends to every INLINE review thread reply it posts.
 *
 * The thread's resolution state is NOT proof that the feedback was answered:
 * the review bot auto-resolves the threads it creates, so a resolved thread
 * can be completely unanswered. The marker is the only evidence that survives
 * the process — exactly like the conversation surface's markers above — so a
 * thread that carries it was answered, whatever its resolution state says.
 */
export const DISMISS_INLINE_REPLY_MARKER =
  'Dismissing this inline review thread:' as const;

/**
 * The tool's historic signature on the dismissal notes it posts.
 *
 * Before the inline marker existed, the only tool-owned signal in an inline
 * reply was the signature the notes ended with (`— CodeLoop Triage Subagent
 * (issue #N)`). The replies already posted on PR #261 carry it and nothing
 * else, so it must keep being read as "the tool answered this thread" —
 * otherwise those threads would be answered a second time.
 */
export const DISMISS_INLINE_REPLY_SIGNATURE =
  '— CodeLoop Triage Subagent' as const;

// ============================================================================
// Triage Disposition (issue #269, Defect 1)
// ============================================================================

/**
 * The titles of the repository's OWN automated review summaries.
 *
 * The detector used to count EVERY comment on an OPEN PR as review feedback,
 * so the repository's own `critique.yml` status post — a summary that by
 * construction reports zero findings — was routed to the TRIAGE gate. The
 * subagent was then asked to dispose of a comment that said there was nothing
 * to dispose of, and the disposition was never recorded, so `codeloop next`
 * routed to TRIAGE again (the livelock).
 *
 * The predicate is a case-insensitive SUBSTRING match on the comment body, and
 * the marker list is deliberately EXPLICIT: a bot's inline findings are
 * actionable and must still route. Excluding a STATUS POST does not blind the
 * tool; excluding "bot comments" wholesale would.
 */
export const PR_AUTOMATED_SUMMARY_MARKERS: readonly string[] = Object.freeze([
  'Critique AI Review Run Summary',
  'Critique Review Summary',
  'CodeLoop AI Review Run Summary'
]);

/**
 * The actions a triage disposition can record.
 *
 * This is the SINGLE definition of the triage action set: the application
 * layer's `TriageAction` is re-typed as an alias of it, so the CLI, the
 * checkpoint and the disposition can never disagree about the vocabulary.
 */
export const TRIAGE_DISPOSITION_ACTIONS = Object.freeze([
  'implement',
  'plan',
  'discovery',
  'completed',
  'dismiss'
] as const);

export type TriageDispositionAction = (typeof TRIAGE_DISPOSITION_ACTIONS)[number];

/**
 * The ONE routing-command template the triage directive names (issue #241, D1).
 *
 * The dispatched prompt and the operator-facing surfaces are both built from
 * this template, so the command a subagent is told to run is a command the CLI
 * accepts as written — no environment marker to discover, no second copy to
 * drift. `{action}` is substituted with the placeholder or a concrete action;
 * `{issue}` only appears when an issue is known.
 */
export const TRIAGE_ROUTING_COMMAND_TEMPLATE = 'codeloop triage {action} --issue {issue}' as const;
export const TRIAGE_ROUTING_COMMAND_NO_ISSUE_TEMPLATE = 'codeloop triage {action}' as const;

/**
 * What each triage action DOES, as an operator-facing side effect (#277/AC3).
 *
 * `completed` and `dismiss` both record a disposition, but only `dismiss`
 * writes to GitHub. That distinction is the whole reason an operator chooses
 * one over the other, so it is data, not hand-typed help prose.
 */
export const TRIAGE_ACTION_SIDE_EFFECTS: Readonly<Record<TriageDispositionAction, string>> = Object.freeze({
  implement: 'routes to IMPLEMENT with the review comments as context',
  plan: 'routes to PLAN for structural plan revision',
  discovery: 'routes to DISCOVERY for investigative root-cause analysis',
  completed: 'records a disposition and posts nothing to the PR (non-destructive exit)',
  dismiss: 'records a disposition and replies to/resolves the PR threads (writes to GitHub)'
});

export const TRIAGE_ACTION_LIST_SEPARATOR = '|' as const;
export const TRIAGE_ACTION_SIDE_EFFECT_SEPARATOR = '; ' as const;

/**
 * The action vocabulary, derived from `TRIAGE_DISPOSITION_ACTIONS`.
 *
 * Consumers: the CLI parser, the CLI error text, `--help`, the read-only hint,
 * the triage system prompt and task prompt, and the TRIAGE operator summary.
 */
export function formatTriageActionList(
  separator: string = TRIAGE_ACTION_LIST_SEPARATOR
): string {
  return TRIAGE_DISPOSITION_ACTIONS.join(separator);
}

/** The action vocabulary as `action <side effect>` pairs. */
export function formatTriageActionSideEffects(): string {
  return TRIAGE_DISPOSITION_ACTIONS
    .map((action) => `${action} ${TRIAGE_ACTION_SIDE_EFFECTS[action]}`)
    .join(TRIAGE_ACTION_SIDE_EFFECT_SEPARATOR);
}

/**
 * The exact command a triage subagent must run, with the action and issue
 * interpolated when they are known.
 */
export function formatTriageRoutingCommand(
  params: { readonly action?: string | null; readonly issue?: number | string | null } = {}
): string {
  const action = params.action && String(params.action).trim() ? String(params.action) : '<action>';
  const hasIssue =
    params.issue !== null && params.issue !== undefined && String(params.issue).trim().length > 0;

  if (!hasIssue) {
    return TRIAGE_ROUTING_COMMAND_NO_ISSUE_TEMPLATE.replace('{action}', action);
  }

  return TRIAGE_ROUTING_COMMAND_TEMPLATE
    .replace('{action}', action)
    .replace('{issue}', String(params.issue));
}

/**
 * The replacement for the removed `AGY_SUBAGENT` marker guard (issue #241/R1).
 *
 * This is a DIFFERENT protection from the one it replaces: it prevents routing
 * the WRONG checkpoint, not "a root agent routing". A dispatcher cannot
 * distinguish its own root from a subagent, and pretending otherwise was the
 * defect.
 */
export const MSG_TRIAGE_ROUTING_REQUIRES_GATE =
  'Error: A triage routing action requires the checkpoint to be at the TRIAGE gate. Run `codeloop next` to reach the gate; a routing action never moves a checkpoint from any other stage.' as const;

/**
 * The triage subagent's default system prompt (issue #241, D1/D4).
 *
 * Lives here rather than as a `DEFAULT_*` constant so it can interpolate the
 * action vocabulary and the routing command without a declaration-order cycle.
 */
export function buildDefaultTriageSystemPrompt(): string {
  return [
    '# AgyLoop Triage Subagent System Prompt',
    'You are the Triage Subagent. Your goal is to inspect PR comments and route the pipeline.',
    `Route with \`${formatTriageRoutingCommand()}\`, where \`<action>\` is one of: ${formatTriageActionList()}.`,
    `${formatTriageActionSideEffects()}.`,
    'A routing action requires the checkpoint to be at the TRIAGE gate (`codeloop next` is the entry path).'
  ].join('\n');
}

/**
 * The cap on the number of feedback keys a single disposition may carry.
 *
 * The disposition lives in the checkpoint's snapshot, so an unbounded key set
 * would grow the state file without limit. The OLDEST keys are dropped first:
 * a disposition records what was disposed of, and the most recent feedback is
 * the one that matters for the next triage.
 */
export const MAX_TRIAGE_DISPOSITION_FEEDBACK_KEYS = 200 as const;

/**
 * The history/summary note for a recorded triage disposition.
 */
export const NOTE_TRIAGE_DISPOSITION_RECORDED =
  'Triage disposition recorded: {action} (PR #{prNumber}, {count} feedback item(s) at {recordedAt})' as const;

/**
 * Why NO disposition was recorded.
 *
 * An empty key set must never masquerade as "everything was dispositioned":
 * if no feedback could be read, the tool knows nothing about what was disposed
 * of, and the next triage must see the PR afresh.
 */
export const NOTE_TRIAGE_DISPOSITION_NOT_RECORDED =
  'no triage disposition recorded — no PR review feedback could be read' as const;

/**
 * The exit condition of the TRIAGE gate, stated in the tool's own output.
 *
 * The gate re-opens on every `codeloop next` while the PR is open, so the
 * operator must be told what ENDS it: a recorded disposition, or the PR being
 * merged/closed.
 */
export const NOTE_TRIAGE_GATE_EXIT_CONDITION =
  "This gate ends when the feedback is dispositioned (the disposition is recorded in the checkpoint) or when the PR is merged/closed. Until then 'codeloop next' reports this gate again." as const;

/**
 * The operator-facing label of the triage disposition line.
 */
export const LABEL_TRIAGE_DISPOSITION = 'Triage Disposition' as const;

/**
 * The surfaces the triage disposition line is rendered for (issue #269, R5).
 *
 * ONE renderer, THREE surfaces: the CLI's triage output, the idle report and
 * the checkpoint history note each used to hand-render the SAME facts, so the
 * wording could drift apart. The frames live here, beside the note they
 * belong to, and the renderer in `value-objects/triage-disposition.ts` is the
 * single place that fills them.
 */
export const TRIAGE_DISPOSITION_SURFACES = Object.freeze([
  'history-note',
  'idle-report',
  'triage-cli'
] as const);

export type TriageDispositionSurface = (typeof TRIAGE_DISPOSITION_SURFACES)[number];

/**
 * The operator-facing disposition line, per surface (issue #269, R5).
 *
 * Placeholders:
 *
 * - `{action}` — the disposition action, as recorded (`completed`);
 * - `{actionUpper}` — the same action, upper-cased (`COMPLETED`);
 * - `{prNumber}` — the pull request the disposition applies to;
 * - `{count}` — the number of dispositioned feedback items;
 * - `{recordedAt}` — the instant the disposition was recorded;
 * - `{label}` — the operator-facing label of the line.
 *
 * The history note IS `NOTE_TRIAGE_DISPOSITION_RECORDED` — the domain constant
 * that already existed and was used for exactly one surface.
 */
export const TRIAGE_DISPOSITION_LINE_TEMPLATES = Object.freeze({
  'history-note': NOTE_TRIAGE_DISPOSITION_RECORDED,
  'idle-report':
    'Triage disposition recorded: action={action}, PR #{prNumber}, {count} feedback item(s), at {recordedAt}.',
  'triage-cli':
    '{label} : recorded (action={actionUpper}, PR #{prNumber}, {count} feedback item(s), at {recordedAt})'
} as const);

export const COMMAND_PLAN = 'plan' as const;
export const COMMAND_IMPLEMENT = 'implement' as const;
export const COMMAND_COMMIT = 'commit' as const;
export const COMMAND_YOLO = 'yolo' as const;
export const COMMAND_STATUS = 'status' as const;
export const COMMAND_CONFIG = 'config' as const;
export const COMMAND_MODELS = 'models' as const;
export const COMMAND_PROMPT = 'prompt' as const;
export const COMMAND_RESET = 'reset' as const;
export const COMMAND_TRANSITION = 'transition' as const;
export const COMMAND_WORKTREE = 'worktree' as const;
export const COMMAND_RELEASE = 'release' as const;
export const COMMAND_NEXT = 'next' as const;
export const COMMAND_BRANCH_INFO = 'branch-info' as const;
export const COMMAND_TRIAGE = 'triage' as const;
export const COMMAND_SYNC = 'sync' as const;
export const COMMAND_ABORT = 'abort' as const;
export const COMMAND_INIT = 'init' as const;
export const COMMAND_OPENCODE = 'opencode' as const;

/**
 * CLI sub-command that clears a persisted gate pause.
 *
 * This is the ONLY command that calls `StateMachine.resumeFromGate()` and
 * persists the cleared checkpoint, so it is the only one that may be advertised
 * as "the way out of a pause". `codeloop next` merely prints the next directive;
 * it never touches `pausedAtGate`.
 *
 * Declared beside the other `COMMAND_*` constants rather than after
 * `CLI_COMMANDS`: it is a member of that registry (issue #276), and a
 * declaration that sits below the map is how it went missing from it.
 */
export const COMMAND_RESUME = 'resume' as const;

/**
 * Inbound quota-halt channel (issue #220).
 *
 * An external agent runtime calls `codeloop halt --reason quota` when it
 * observes a 429, persisting a `CIRCUIT_BREAKER` pause that `COMMAND_RESUME`
 * (declared below) later clears. This restores reachability of the quota-halt
 * state without wiring `AgentRunnerPort` into the lifecycle.
 */
export const COMMAND_HALT = 'halt' as const;

/**
 * The inbound channel for a dispatched reviewer subagent's verdict (issue #269).
 *
 * The reviewer subagent produces a `REVIEW_STATUS: APPROVED | CHANGES_REQUESTED`
 * block, and `RunReviewParams.reviewOutput` is the domain's chosen seam for
 * it — but no command ever supplied it, so the verdict was structurally
 * unrecordable. This command IS that producer.
 */
export const COMMAND_REVIEW = 'review' as const;

/**
 * The flags that carry a dispatched reviewer verdict to the checkpoint.
 */
export const FLAG_VERDICT_FILE = '--verdict-file' as const;
export const FLAG_REVIEW_OUTPUT = '--review-output' as const;
export const FLAG_VERDICT_STDIN = '--verdict-stdin' as const;

/**
 * The verdict-filing channel, named in the REVIEW directive's OPERATOR fields
 * (issue #272).
 *
 * #269 built the channel (`codeloop review --verdict-file`) but the dispatch
 * directive the operator reads never mentioned it, so the reviewer was
 * re-dispatched forever. The command is COMPOSED from `COMMAND_REVIEW` and
 * `FLAG_VERDICT_FILE`, and the concrete issue is interpolated when known so the
 * operator is handed a string they can paste.
 */
export const REVIEW_VERDICT_CHANNEL_COMMAND_TEMPLATE =
  `codeloop ${COMMAND_REVIEW} --issue {issue} ${FLAG_VERDICT_FILE} <path>` as const;
export const REVIEW_VERDICT_CHANNEL_COMMAND_NO_ISSUE_TEMPLATE =
  `codeloop ${COMMAND_REVIEW} --issue <n> ${FLAG_VERDICT_FILE} <path>` as const;

export function formatReviewVerdictChannelCommand(issue?: number | string | null): string {
  if (issue === null || issue === undefined || String(issue).trim().length === 0) {
    return REVIEW_VERDICT_CHANNEL_COMMAND_NO_ISSUE_TEMPLATE;
  }
  return REVIEW_VERDICT_CHANNEL_COMMAND_TEMPLATE.replace('{issue}', String(issue));
}

/** The filing instruction; `{command}` is `formatReviewVerdictChannelCommand`. */
export const NOTE_REVIEW_VERDICT_CHANNEL =
  `File the verdict before the COMMIT gate: {command} (or \`codeloop ${COMMAND_REVIEW} --issue <n> ${FLAG_REVIEW_OUTPUT} "<block>"\`, or pipe the block into \`codeloop ${COMMAND_REVIEW} --issue <n> ${FLAG_VERDICT_STDIN}\`).` as const;

/**
 * What ENDS the REVIEW gate (issue #272/AC2) — the same shape as
 * `NOTE_TRIAGE_GATE_EXIT_CONDITION`.
 */
export const NOTE_REVIEW_GATE_EXIT_CONDITION =
  "This gate ends when the verdict is filed (the checkpoint records a reviewVerdict) or when the review is intentionally abandoned. Until then 'codeloop next' reports this gate again." as const;

/** The per-read re-dispatch record: `{n}` of `{max}`. */
export const NOTE_REVIEW_DISPATCH_ORDINAL =
  'Reviewer dispatch {n} of {max} for this review round.' as const;

/** The breaker's description: it names the cap AND the way out. */
export const NOTE_REVIEW_DISPATCH_CAP =
  'The reviewer has been dispatched {max} times without a filed verdict. File the verdict with `{command}` (or abandon the review) before continuing.' as const;

/** The operator-facing label of the re-dispatch count (additive `status` line). */
export const LABEL_REVIEW_DISPATCHES = 'Review Dispatches' as const;

// ============================================================================
// Stage dispatch directives (issue #292)
// ============================================================================

/**
 * The command that ADVANCES the DISCOVERY stage (issue #292).
 *
 * The directive used to name neither the completion condition nor the command
 * that moves the pipeline on, so an operator (or an external runner) following
 * `codeloop next` re-dispatched the discovery subagent forever.
 */
export const DISCOVERY_ADVANCE_COMMAND_TEMPLATE =
  `codeloop ${COMMAND_PLAN} --issue {issue}` as const;
export const DISCOVERY_ADVANCE_COMMAND_NO_ISSUE_TEMPLATE =
  `codeloop ${COMMAND_PLAN} --issue <n>` as const;

export function formatDiscoveryAdvanceCommand(issue?: number | string | null): string {
  if (issue === null || issue === undefined || String(issue).trim().length === 0) {
    return DISCOVERY_ADVANCE_COMMAND_NO_ISSUE_TEMPLATE;
  }
  return DISCOVERY_ADVANCE_COMMAND_TEMPLATE.replace('{issue}', String(issue));
}

/** The command that ADVANCES the PLAN stage (issue #292). */
export const PLAN_ADVANCE_COMMAND_TEMPLATE =
  `codeloop ${COMMAND_TRANSITION} APPROVAL --issue {issue}` as const;
export const PLAN_ADVANCE_COMMAND_NO_ISSUE_TEMPLATE =
  `codeloop ${COMMAND_TRANSITION} APPROVAL --issue <n>` as const;

export function formatPlanAdvanceCommand(issue?: number | string | null): string {
  if (issue === null || issue === undefined || String(issue).trim().length === 0) {
    return PLAN_ADVANCE_COMMAND_NO_ISSUE_TEMPLATE;
  }
  return PLAN_ADVANCE_COMMAND_TEMPLATE.replace('{issue}', String(issue));
}

/** What ENDS the DISCOVERY stage (issue #292). */
export const NOTE_DISCOVERY_ADVANCE_CONDITION =
  'This stage ends when a populated RCA report exists for the issue.' as const;

/** What ENDS the PLAN stage (issue #292). */
export const NOTE_PLAN_ADVANCE_CONDITION =
  'This stage ends when the plan file is non-blank.' as const;

/** The per-read re-dispatch record for DISCOVERY: `{n}`. */
export const NOTE_DISCOVERY_DISPATCH_ORDINAL =
  'Discovery dispatch {n} for this stage.' as const;

/** The per-read re-dispatch record for PLAN: `{n}`. */
export const NOTE_PLAN_DISPATCH_ORDINAL =
  'Planner dispatch {n} for this stage.' as const;

/**
 * The number of blank-plan parks after which the advisory reports a REPEAT
 * (issue #267, AC-A5). ONE definition shared by the lifecycle message chooser
 * and the CLI advisory so the two can never disagree about "attempt 2".
 */
export const PLAN_EMPTY_PARK_REPEAT_THRESHOLD = 2 as const;

/** Operator-facing labels of the two new re-dispatch counters. */
export const LABEL_DISCOVERY_DISPATCHES = 'Discovery Dispatches' as const;
export const LABEL_PLAN_DISPATCHES = 'Planner Dispatches' as const;

/** Operator-facing label of the recorded blank-plan park count. */
export const LABEL_PLAN_EMPTY_PARKS = 'Blank-Plan Parks' as const;

/**
 * Recorded in history metadata when `codeloop plan` re-enters PLAN from an
 * IMPLEMENT checkpoint (issue #267). Re-planning is the supported recovery
 * from the blank-plan park.
 */
export const NOTE_REOPENED_PLAN_FROM_IMPLEMENT =
  'Re-opened the plan from an IMPLEMENT checkpoint (blank-plan recovery)' as const;

/**
 * The blank-plan IMPLEMENT directive (issue #267, AC-A2).
 *
 * `codeloop next` at a blank-plan checkpoint returns the PLANNER instead of the
 * implementer, so the operator is handed the payload that can actually fill the
 * plan. `{planPath}` is the spec to complete, `{issue}` the task, `{command}`
 * the advance command.
 */
export const NOTE_BLANK_PLAN_DISPATCH_PLANNER =
  "The plan at '{planPath}' is still blank, so dispatching the implementer would give it nothing to execute. Dispatch the PLANNER to write the specification (or supply a plan with `codeloop implement --plan-path <file>`), then run `codeloop next` again. {command}." as const;

/**
 * Appends the checked paths to the DISCOVERY park message (issue #283, AC3).
 *
 * Kept as a formatter rather than a second constant so the base note stays the
 * exact fallback when no path is known (a dry run, a checkpoint with no
 * directory) — and so a parked operator is always told WHICH file was read.
 */
export function formatDiscoveryParkAwaitingRca(checkedPaths?: string | null): string {
  if (!checkedPaths || String(checkedPaths).trim().length === 0) {
    return NOTE_DISCOVERY_PARK_AWAITING_RCA;
  }
  return `${NOTE_DISCOVERY_PARK_AWAITING_RCA} Checked: ${checkedPaths}.`;
}


/**
 * The operator-facing source of an INLINE reviewer verdict.
 *
 * The verdict-file source is the path itself; the stdin source is
 * `VERDICT_INPUT_SOURCE_STDIN`.
 */
export const VERDICT_INPUT_SOURCE_STDIN = 'stdin' as const;

/**
 * The diagnostic for a verdict flag that was PRESENT but carried no value
 * (issue #269, R1).
 *
 * A verdict that was never read must fail LOUDLY. Falling through to the
 * critique path would record a `SKIPPED` verdict — a silent downgrade of the
 * reviewer's real verdict, and the exact defect this channel exists to
 * remove.
 */
export const NOTE_VERDICT_INPUT_MISSING =
  '{flag} was provided without a reviewer verdict. No verdict was recorded and the review did NOT run: a verdict that was never read must fail loudly, never fall through to the critique path. {hint}' as const;

/**
 * How to supply the verdict the `--verdict-file` flag asked for.
 */
export const HINT_VERDICT_FILE_INPUT =
  'Pass the path of the file that carries the verdict block, e.g. `codeloop review --issue 269 --verdict-file verdict.md`.' as const;

/**
 * How to supply the verdict the `--review-output` flag asked for.
 */
export const HINT_REVIEW_OUTPUT_INPUT =
  'Pass the verdict block inline, e.g. `codeloop review --issue 269 --review-output "REVIEW_STATUS: APPROVED"`, or pipe it in with --verdict-stdin.' as const;

/**
 * How to supply the verdict the `--verdict-stdin` flag asked for.
 */
export const HINT_VERDICT_STDIN_INPUT =
  'Pipe the verdict block into the command, e.g. `cat verdict.md | codeloop review --issue 269 --verdict-stdin`.' as const;

/**
 * WHERE the recorded verdict came from (issue #269).
 *
 * The source is part of the RECORD: a consumer must never read "the reviewer
 * said CHANGES_REQUESTED" when the reviewer said APPROVED and the Tier 1
 * critique report escalated the verdict.
 *
 * - `reviewer-output` — the dispatched Reviewer subagent's verdict block
 *   (Tier 2), filed through `codeloop review --verdict-file`.
 * - `critique-report` — the critique CLI's report (Tier 1).
 * - `skipped` — the advisory fail-open: no reviewer output and no critique
 *   report (issue #236).
 * - `reviewer-output+critique-escalation` — the reviewer APPROVED, but the
 *   TWO-TIER INVARIANT escalated the verdict to CHANGES_REQUESTED because the
 *   critique report carried a blocking/error finding. The source names BOTH
 *   contributors: plain `reviewer-output` would claim that the reviewer asked
 *   for changes the reviewer never asked for.
 */
export const REVIEW_SOURCE_REVIEWER_OUTPUT = 'reviewer-output' as const;
export const REVIEW_SOURCE_CRITIQUE_REPORT = 'critique-report' as const;
export const REVIEW_SOURCE_SKIPPED = 'skipped' as const;
export const REVIEW_SOURCE_REVIEWER_OUTPUT_ESCALATED = 'reviewer-output+critique-escalation' as const;

export type ReviewSource =
  | (typeof REVIEW_SOURCE_REVIEWER_OUTPUT)
  | (typeof REVIEW_SOURCE_CRITIQUE_REPORT)
  | (typeof REVIEW_SOURCE_SKIPPED)
  | (typeof REVIEW_SOURCE_REVIEWER_OUTPUT_ESCALATED);

export const FORGE_GITHUB = 'github' as const;
export const FORGE_GITLAB = 'gitlab' as const;
export const FORGE_GENERIC = 'generic' as const;

export const CODELOOP_STATE_DIR = '.codeloop' as const;
export const CODELOOP_CONFIG_FILE = 'config.json' as const;
export const DEFAULT_SMOKE_TIMEOUT_SECONDS = 300 as const;

/**
 * Ephemeral runtime paths that must be git-ignored. `.codeloop/config.json` and
 * `.agyloop/config.json` are intentionally absent so project config stays tracked.
 */
export const INIT_GITIGNORE_RULES: readonly string[] = Object.freeze([
  '.codeloop/state.json',
  '.codeloop/tasks/',
  '.codeloop/locks/',
  '.codeloop/logs/',
  '.codeloop/critique-update-cache.json',
  '.codeloop/*.bak',
  '.agyloop',        // bare entry matches the .agyloop symlink created in worktrees (git mode 120000)
  '!.agyloop/',      // re-include the real directory so .agyloop/config.json stays trackable
  '.agyloop/state.json',
  '.agyloop/tasks/',
  '.agyloop/locks/',
  '.agyloop/logs/',
  '.agyloop/critique-update-cache.json',
  '.agyloop/*.bak',
  '.worktrees/'
]);

export const CLI_COMMANDS = Object.freeze({
  INIT: COMMAND_INIT,
  PLAN: COMMAND_PLAN,
  IMPLEMENT: COMMAND_IMPLEMENT,
  COMMIT: COMMAND_COMMIT,
  YOLO: COMMAND_YOLO,
  STATUS: COMMAND_STATUS,
  CONFIG: COMMAND_CONFIG,
  MODELS: COMMAND_MODELS,
  PROMPT: COMMAND_PROMPT,
  RESET: COMMAND_RESET,
  RESUME: COMMAND_RESUME,
  TRANSITION: COMMAND_TRANSITION,
  WORKTREE: COMMAND_WORKTREE,
  RELEASE: COMMAND_RELEASE,
  NEXT: COMMAND_NEXT,
  BRANCH_INFO: COMMAND_BRANCH_INFO,
  CRITIQUE: COMMAND_CRITIQUE,
  OPENCODE: COMMAND_OPENCODE,
  TRIAGE: COMMAND_TRIAGE,
  SYNC: COMMAND_SYNC,
  ABORT: COMMAND_ABORT,
  HALT: COMMAND_HALT,
  REVIEW: COMMAND_REVIEW
});

export type CliCommandName = typeof CLI_COMMANDS[keyof typeof CLI_COMMANDS];

/**
 * The DOCUMENTED command set of the CLI (issue #269, AC2.2; reconciled in #276).
 *
 * The OpenCode skill documents a set of commands; this list is the contract
 * the skill↔CLI test asserts against, so the skill and the CLI can never
 * disagree about a command that does not exist.
 *
 * DERIVED, deliberately: `CLI_DOCUMENTED_COMMANDS` is `Object.values` of the
 * one command-NAME map, so a removed command cannot linger in the documented
 * list and a new command cannot be forgotten here. The exported type stays
 * `readonly string[]` because the contract test calls `.includes(command)` with
 * a plain string.
 *
 * `gate` / `gates` are deliberately ABSENT: they were removed commands whose
 * case only prints "use `agyloop next` instead", and they are not documented
 * commands.
 */
export const CLI_DOCUMENTED_COMMANDS: readonly string[] = Object.freeze(
  Object.values(CLI_COMMANDS)
);

// SemVer Release Bumps & GitHub Release Labels
export const RELEASE_BUMP_MAJOR = 'major' as const;
export const RELEASE_BUMP_MINOR = 'minor' as const;
export const RELEASE_BUMP_PATCH = 'patch' as const;

export const RELEASE_BUMPS = Object.freeze({
  MAJOR: RELEASE_BUMP_MAJOR,
  MINOR: RELEASE_BUMP_MINOR,
  PATCH: RELEASE_BUMP_PATCH
});
export type ReleaseBumpType = typeof RELEASE_BUMPS[keyof typeof RELEASE_BUMPS];

export const RELEASE_LABEL_MAJOR = 'release:major' as const;
export const RELEASE_LABEL_MINOR = 'release:minor' as const;
export const RELEASE_LABEL_PATCH = 'release:patch' as const;

export const RELEASE_LABELS = Object.freeze({
  MAJOR: RELEASE_LABEL_MAJOR,
  MINOR: RELEASE_LABEL_MINOR,
  PATCH: RELEASE_LABEL_PATCH
});
export type ReleaseLabelName = typeof RELEASE_LABELS[keyof typeof RELEASE_LABELS];

// Pre-Flight Check Actions
export const PREFLIGHT_ACTION_PROCEED = 'PROCEED' as const;
export const PREFLIGHT_ACTION_RESUME = 'RESUME' as const;
export const PREFLIGHT_ACTION_HALT = 'HALT' as const;
export const PREFLIGHT_ACTION_HALT_CLOSED = 'HALT_CLOSED' as const;
export const PREFLIGHT_ACTION_HALT_PR_MERGED = 'HALT_PR_MERGED' as const;

export const PREFLIGHT_ACTIONS = Object.freeze({
  PROCEED: PREFLIGHT_ACTION_PROCEED,
  RESUME: PREFLIGHT_ACTION_RESUME,
  HALT: PREFLIGHT_ACTION_HALT,
  HALT_CLOSED: PREFLIGHT_ACTION_HALT_CLOSED,
  HALT_PR_MERGED: PREFLIGHT_ACTION_HALT_PR_MERGED
});
export type PreFlightActionType = typeof PREFLIGHT_ACTIONS[keyof typeof PREFLIGHT_ACTIONS];

// Issue Migration Modes
export const MIGRATION_MODE_PER_TASK = 'per_task' as const;
export const MIGRATION_MODE_MILESTONE_ONLY = 'milestone_only' as const;

export const MIGRATION_MODES = Object.freeze({
  PER_TASK: MIGRATION_MODE_PER_TASK,
  MILESTONE_ONLY: MIGRATION_MODE_MILESTONE_ONLY
});
export type MigrationModeType = typeof MIGRATION_MODES[keyof typeof MIGRATION_MODES];

export const DEFAULT_TRACKER_REPO = 'ajxcodes/projects' as const;

// Versioning Strategies
export const VERSIONING_STRATEGY_PACKAGE_JSON = 'package_json' as const;
export const VERSIONING_STRATEGY_GIT_TAG_ONLY = 'git_tag_only' as const;
export const VERSIONING_STRATEGY_NONE = 'none' as const;

export const VERSIONING_STRATEGIES = Object.freeze({
  PACKAGE_JSON: VERSIONING_STRATEGY_PACKAGE_JSON,
  GIT_TAG_ONLY: VERSIONING_STRATEGY_GIT_TAG_ONLY,
  NONE: VERSIONING_STRATEGY_NONE
});
export type VersioningStrategyType = typeof VERSIONING_STRATEGIES[keyof typeof VERSIONING_STRATEGIES];

export const FLAG_YOLO = '--yolo' as const;
export const FLAG_COMMIT_AFTER = '--commit-after' as const;
export const FLAG_YES = '--yes' as const;
export const FLAG_YES_SHORT = '-y' as const;
export const FLAG_STAGED = '--staged' as const;
export const FLAG_STAGED_SHORT = '-s' as const;
export const FLAG_MESSAGE = '--message' as const;
export const FLAG_MESSAGE_SHORT = '-m' as const;
export const FLAG_ISSUE = '--issue' as const;
export const FLAG_TITLE = '--title' as const;
export const FLAG_TYPE = '--type' as const;
export const FLAG_CONFIG = '--config' as const;
export const FLAG_DRY_RUN = '--dry-run' as const;
export const FLAG_REFRESH = '--refresh' as const;
export const FLAG_WORKTREE = '--worktree' as const;
export const FLAG_NO_WORKTREE = '--no-worktree' as const;
export const FLAG_HELP = '--help' as const;
export const FLAG_HELP_SHORT = '-h' as const;
export const FLAG_VERSION = '--version' as const;
export const FLAG_VERSION_SHORT = '-v' as const;
export const FLAG_KEEP_WORKTREE = '--keep-worktree' as const;
export const FLAG_JSON = '--json' as const;
export const FLAG_FORCE = '--force' as const;
export const FLAG_FORCE_SHORT = '-f' as const;
export const FLAG_QUARANTINE = '--quarantine' as const;
/**
 * Operator-supplied plan inputs (issue #267).
 *
 * `--plan-path <file>` names a plan the lifecycle must execute instead of
 * scaffolding a fresh one; `--plan-dir <dir>` names its directory. Implemented
 * end to end — never silently discarded.
 */
export const FLAG_PLAN_PATH = '--plan-path' as const;
export const FLAG_PLAN_DIR = '--plan-dir' as const;

export const CLI_FLAGS = Object.freeze({
  YOLO: FLAG_YOLO,
  COMMIT_AFTER: FLAG_COMMIT_AFTER,
  YES: FLAG_YES,
  YES_SHORT: FLAG_YES_SHORT,
  STAGED: FLAG_STAGED,
  STAGED_SHORT: FLAG_STAGED_SHORT,
  MESSAGE: FLAG_MESSAGE,
  MESSAGE_SHORT: FLAG_MESSAGE_SHORT,
  ISSUE: FLAG_ISSUE,
  TITLE: FLAG_TITLE,
  TYPE: FLAG_TYPE,
  CONFIG: FLAG_CONFIG,
  DRY_RUN: FLAG_DRY_RUN,
  REFRESH: FLAG_REFRESH,
  WORKTREE: FLAG_WORKTREE,
  NO_WORKTREE: FLAG_NO_WORKTREE,
  KEEP_WORKTREE: FLAG_KEEP_WORKTREE,
  JSON: FLAG_JSON,
  FORCE: FLAG_FORCE,
  FORCE_SHORT: FLAG_FORCE_SHORT,
  QUARANTINE: FLAG_QUARANTINE,
  HELP: FLAG_HELP,
  HELP_SHORT: FLAG_HELP_SHORT,
  VERSION: FLAG_VERSION,
  VERSION_SHORT: FLAG_VERSION_SHORT
});

// Git Push & Authentication Fallback Constants
export const GIT_GITHUB_HOST = 'github.com' as const;
export const GIT_SSH_URL_PREFIX = 'git@github.com:' as const;
export const GIT_HTTPS_URL_PREFIX = 'https://github.com/' as const;

/**
 * Returns git CLI configuration arguments to redirect SSH and standard HTTPS pushes
 * through the provided GitHub authentication token.
 */
export function buildGitTokenRedirectConfig(token: string): string {
  const tokenUrl = `https://x-access-token:${token}@${GIT_GITHUB_HOST}/`;
  return `-c url."${tokenUrl}".insteadOf="${GIT_SSH_URL_PREFIX}" -c url."${tokenUrl}".insteadOf="${GIT_HTTPS_URL_PREFIX}"`;
}

// Default Branch Resolution (issue #218 / AC5)

/**
 * Terminal fallback for the default/base branch. Only used when a repository exposes
 * neither a remote HEAD, nor an attached local branch, nor any well-known candidate.
 */
export const DEFAULT_BASE_BRANCH = 'main' as const;

/**
 * Well-known base-branch candidates, most preferred first, probed in this exact
 * order by both default-branch resolvers (`InitProjectUseCase.detectGit` and
 * `GitWorktreeManager.resolveBaseBranch`). Single definition on purpose: the two
 * resolvers must agree on precedence, so a second verbatim copy is a drift bug.
 * `DEFAULT_BASE_BRANCH` above is only the terminal fallback when none resolve.
 */
export const DEFAULT_BASE_BRANCH_CANDIDATES = Object.freeze([
  'develop',
  'master',
  'main',
  'trunk'
] as const);

// OpenCode Integration Installer (issue #218 / AC1-AC3)

/** XDG-style config root beneath `$HOME`. */
export const OPENCODE_CONFIG_DIR_NAME = '.config' as const;

/** OpenCode's per-application directory beneath the config root. */
export const OPENCODE_APP_DIR_NAME = 'opencode' as const;

/** Config filenames in precedence order: `.jsonc` first, plain `.json` second. */
export const OPENCODE_CONFIG_FILENAMES = Object.freeze([
  'opencode.jsonc',
  'opencode.json'
] as const);

/**
 * Filename used when no OpenCode config exists yet. Freshly created configs carry no
 * comments, so a strict-JSON filename is the honest choice.
 */
export const OPENCODE_CONFIG_CREATE_FILENAME = 'opencode.json' as const;

/** Suffix for the pre-rewrite snapshot of a hand-maintained OpenCode config. */
export const OPENCODE_CONFIG_BACKUP_SUFFIX = '.codeloop.bak' as const;

/** Skill directory name; must match the skill frontmatter `name`. */
export const OPENCODE_SKILL_NAME = 'codeloop' as const;

/** OpenCode scans a directory named after the skill, containing this file. */
export const OPENCODE_SKILL_FILENAME = 'SKILL.md' as const;

/** Repo-relative path of the skill asset, resolved against the workspace root. */
export const OPENCODE_SKILL_ASSET_RELATIVE_PATH = 'integrations/opencode/codeloop-skill.md' as const;

/** Repo-relative path of the slash-command payload asset. */
export const OPENCODE_COMMAND_ASSET_RELATIVE_PATH = 'integrations/opencode/codeloop-command.json' as const;

/** Legacy (never-scanned) install root left behind by pre-#218 installers. */
export const OPENCODE_LEGACY_DIR_NAME = '.opencode' as const;

/** Legacy flat filename that produced the live dangling symlink. */
export const OPENCODE_LEGACY_SKILL_FILENAME = 'codeloop.md' as const;

/** Slash-command key registered in `opencode.json(c)` under `command`. */
export const OPENCODE_COMMAND_NAME = 'codeloop' as const;

/** Compiled-in fallback used when the command asset cannot be read. */
export const OPENCODE_COMMAND_DESCRIPTION =
  'Run the CodeLoop multi-subagent development lifecycle' as const;

/** Compiled-in fallback used when the command asset cannot be read. */
export const OPENCODE_COMMAND_TEMPLATE =
  'Execute the codeloop multi-subagent lifecycle pipeline for the current task: $ARGUMENTS' as const;

/**
 * `symlinkSync` error codes that justify a copy fallback. Anything else is treated as a
 * programming/environment error and rethrown rather than silently downgraded.
 */
export const OPENCODE_SYMLINK_FALLBACK_CODES = Object.freeze([
  'EEXIST',
  'EPERM',
  'EXDEV',
  'ENOTSUP',
  'ENOSYS'
] as const);

// ---- Quota exhaustion (issue #218 / AC4) ---------------------------------

// ERR_QUOTA_EXHAUSTED is declared in the error-code block above (it must precede
// ERROR_CODES) and registered as ERROR_CODES.QUOTA_EXHAUSTED there.

/** The single HTTP status every provider quota rejection maps to. */
export const QUOTA_STATUS = 429 as const;

/**
 * Fully-qualified resume command printed in every breaker/quota diagnostic.
 *
 * MUST name a command that actually clears the pause (see `COMMAND_RESUME`).
 * A hint that merely *suggests* re-running a stage leaves the checkpoint marked
 * as paused forever, which is the bug this constant used to ship.
 */
export const QUOTA_RESUME_COMMAND = 'codeloop resume' as const;

/** One-line help string for the resume sub-command (CLI help output). */
export const RESUME_COMMAND_HELP =
  'Clear a persisted gate pause (e.g. CIRCUIT_BREAKER after a quota halt) and keep the pipeline checkpointed at its current stage' as const;

/**
 * Fallback reset window used when a provider rejects without a `Retry-After`
 * header. One hour matches the dominant rolling-window quota policies.
 */
export const QUOTA_DEFAULT_RETRY_AFTER_SECONDS = 3600 as const;

/** Max length of the raw provider output retained as quota evidence. */
export const QUOTA_EVIDENCE_MAX_CHARS = 400 as const;

/**
 * Distinct exit code for quota-driven halts so CI can tell "provider said no"
 * apart from an ordinary lifecycle failure. Never used for anything else.
 *
 * Deliberately NOT `EXIT_CODE_FAILURE`: a quota halt is a *recoverable* stop
 * (state is checkpointed at the CIRCUIT_BREAKER gate and cleared by
 * `QUOTA_RESUME_COMMAND`), whereas exit 1 means the run actually broke. Collapsing them makes a scheduled
 * job retry a provider that will keep saying no until the window resets, and
 * hides the halt from CI rules that alert on `!= 0`. Scripts that only ever
 * handled `1` must treat any non-zero as failure — see the documented contract
 * in `printHelp()`.
 */
export const EXIT_CODE_QUOTA_EXHAUSTED = 2 as const;

/** Pause note emitted whenever the lifecycle halts at the circuit-breaker gate. */
export const NOTE_PAUSED_CIRCUIT_BREAKER_GATE = 'Paused at circuit breaker gate' as const;

/** Circuit-breaker action taken when a runner fails over after quota exhaustion. */
export const CB_ACTION_FAILOVER = 'failover' as const;

/** Breaker name recorded when the primary runner fails over to a fallback runner. */
export const CB_FAILOVER_BREAKER_NAME = 'runnerFailover' as const;
