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
  [STAGE_INITIALIZED]: Object.freeze([STAGE_DISCOVERY, STAGE_PLAN]),
  [STAGE_DISCOVERY]: Object.freeze([STAGE_PLAN]),
  [STAGE_PLAN]: Object.freeze([STAGE_APPROVAL, STAGE_IMPLEMENT]), // IMPLEMENT allowed only in YOLO mode
  [STAGE_APPROVAL]: Object.freeze([STAGE_IMPLEMENT, STAGE_PLAN]), // PLAN allowed if re-planning requested
  [STAGE_IMPLEMENT]: Object.freeze([STAGE_QUALITY_GATE]),
  [STAGE_QUALITY_GATE]: Object.freeze([STAGE_REVIEW, STAGE_IMPLEMENT]), // IMPLEMENT allowed if gates fail
  [STAGE_REVIEW]: Object.freeze([STAGE_COMMIT, STAGE_IMPLEMENT]), // IMPLEMENT allowed if review changes required
  [STAGE_COMMIT]: Object.freeze([STAGE_COMPLETED, STAGE_QUALITY_GATE, STAGE_IMPLEMENT, STAGE_PLAN]),
  [STAGE_COMPLETED]: Object.freeze([STAGE_INITIALIZED, STAGE_IMPLEMENT, STAGE_QUALITY_GATE, STAGE_REVIEW]) // Can start next task or reopen for fixes/review
});

export const MODE_STANDARD = 'standard' as const;
export const MODE_PLAN = 'plan' as const;
export const MODE_IMPLEMENT = 'implement' as const;
export const MODE_GATES = 'gates' as const;
export const MODE_COMMIT = 'commit' as const;
export const MODE_YOLO = 'yolo' as const;

export const EXECUTION_MODES = Object.freeze({
  STANDARD: MODE_STANDARD,
  PLAN: MODE_PLAN,
  IMPLEMENT: MODE_IMPLEMENT,
  GATES: MODE_GATES,
  COMMIT: MODE_COMMIT,
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
export const ROLE_DESC_GATE =
  'Automated build, test suite, typecheck, and lint verification subagent executing in isolated shell execution' as const;
export const ROLE_DESC_REVIEWER =
  'Standards compliance, code quality, and acceptance criteria review subagent' as const;


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
  MILESTONE_SEALED: ERR_MILESTONE_SEALED
});


export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// Numeric Constants & Default Invariants
export const STATE_SCHEMA_VERSION = '1.0.0' as const;
export const CLI_VERSION = '0.5.0' as const;
export const DEFAULT_GATE_TIMEOUT_SECONDS = 300 as const;
export const MS_PER_SECOND = 1000 as const;
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms (24 hours)
export const EXIT_CODE_SUCCESS = 0 as const;
export const EXIT_CODE_FAILURE = 1 as const;

// Path & File Constants
export const DEFAULT_STATE_DIR = '.agyloop' as const;
export const DEFAULT_STATE_FILE = 'state.json' as const;
export const DEFAULT_PLANS_DIR = 'artifacts/plans' as const;
export const DEFAULT_SUMMARY_FILENAME = 'AgyLoop Summary.md' as const;
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
export const NOTE_REOPEN_IMPLEMENTATION_COMPLETED = 'Reopening implementation from completed stage to address review findings' as const;
export const NOTE_RERUN_GATES_COMPLETED = 'Re-executing quality gates from completed stage' as const;

// Status Identifiers
export const STATUS_PASSED = 'PASSED' as const;
export const STATUS_FAILED = 'FAILED' as const;
export const STATUS_TIMED_OUT = 'TIMED_OUT' as const;
export const STATUS_DISPLAY_TIMED_OUT = 'TIMED OUT' as const;
export const STATUS_SKIPPED = 'SKIPPED' as const;

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

export const HEADER_QUALITY_GATE_REPORT = '=== AgyLoop: Quality Gate Report ===' as const;
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
export const DIVIDER_DASHED = '----------------------------------------------------------------------' as const;

// Structured Review Verdict Protocol Tokens, Verdicts & Thresholds
export const TOKEN_REVIEW_STATUS = 'REVIEW_STATUS' as const;
export const TOKEN_REVIEW_SUMMARY = 'REVIEW_SUMMARY' as const;
export const TOKEN_UNFULFILLED_AC = 'UNFULFILLED_AC' as const;
export const TOKEN_REMEDIATION_GUIDANCE = 'REMEDIATION_GUIDANCE' as const;
export const TOKEN_REVIEW_FINDINGS = 'REVIEW_FINDINGS' as const;

export const VERDICT_APPROVED = 'APPROVED' as const;
export const VERDICT_CHANGES_REQUESTED = 'CHANGES_REQUESTED' as const;

export const REVIEW_VERDICTS = Object.freeze([
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED
] as const);

export type ReviewVerdictState = typeof REVIEW_VERDICTS[number];

export const HEADER_REVIEW_VERDICT_REPORT = '=== AgyLoop: Review Verdict Report ===' as const;
export const LABEL_REVIEW_STATUS = 'Review Status' as const;
export const LABEL_REVIEW_SUMMARY = 'Review Summary' as const;
export const LABEL_UNFULFILLED_AC = 'Unfulfilled Acceptance Criteria' as const;
export const LABEL_REMEDIATION_GUIDANCE = 'Remediation Guidance' as const;
export const SECTION_REVIEW_SELF_CORRECTION_TITLE = '### Reviewer Subagent Self-Correction Remediation Guidance:' as const;

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

export const REGEX_ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
export const REGEX_STACK_FRAME = /^\s*at\s+(?:(?<callSite>.*?)\s+\((?<fileLocation>[^)]+:\d+:\d+)\)|(?<directLocation>[^\s()]+\.[a-zA-Z0-9]+:\d+:\d+))/;
export const REGEX_FILE_LOCATION = /(?:at\s+.*?\(([^)]+:\d+:\d+)\)|at\s+([^\s()]+\.[a-zA-Z0-9]+:\d+:\d+)|([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+:\d+:\d+))/;
export const REGEX_ASSERTION_FAILURE = /(?:AssertionError|Assertion failed|Expected:|Received:|assert(?:\.[a-zA-Z0-9_]+)?\s*\(|Error:\s*.+|expect\(.*\)\..*)/i;
export const REGEX_ERROR_BANNER = /(?:FAIL|ERROR|FAILURE|✖|×)\s+(.+)/;
export const REGEX_NOISE_NODE_INTERNAL = /(?:node:internal\/|\/node_modules\/)/;
export const REGEX_NOISE_NPM_ERR = /^npm\s+ERR!/;
export const REGEX_NOISE_PASSING = /^\s*(?:✔|√|PASS|ok\s+\d+)\s+/;

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


// Default System Prompts (Embedded Domain Fallbacks)
export const DEFAULT_PLANNER_SYSTEM_PROMPT = `# AgyLoop Planning Subagent System Prompt

You are the **AgyLoop Architectural Planning Subagent**, a specialized, analytical, read-only software architect and investigator in Google Antigravity.

Your primary purpose is deep codebase inspection, comprehensive root-cause analysis (RCA), edge-case discovery, and producing production-grade technical specifications for downstream implementation.

---

## 1. Absolute Read-Only Mandate & Safety Invariants

1. **Zero Source Code Modifications**:
   - You are equipped exclusively with inspection tools: \`view_file\`, \`grep_search\`, \`find_by_name\`, and \`list_dir\`.
   - You are physically and procedurally restricted from mutating workspace files or running write/build/execute commands.
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
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9_.\-\/]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/i;
export const REGEX_BREAKING_CHANGE_FOOTER =
  /^BREAKING[ -]CHANGE:\s*(.+)$/im;
export const REGEX_DIFF_FILE_HEADER =
  /^diff --git\/(.+?) b\/(.+?)$/gm;
export const REGEX_ISSUE_NUMBER_REF = /#(\d+)/;
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

export const HEADER_COMMIT_DRAFT_REPORT = '=== AgyLoop: Conventional Commit Draft ===' as const;
export const SECTION_COMMIT_DETAILS_TITLE = '## Commit & Release Details' as const;

// ============================================================================
// Operational Modes, Flags, Gate Names & Lifecycle Notes
// ============================================================================

export const GATE_APPROVAL = 'APPROVAL' as const;
export const GATE_COMMIT = 'COMMIT' as const;

export const LIFECYCLE_GATES = Object.freeze({
  APPROVAL: GATE_APPROVAL,
  COMMIT: GATE_COMMIT
});

export type LifecycleGateName = typeof LIFECYCLE_GATES[keyof typeof LIFECYCLE_GATES];

export const NOTE_LIFECYCLE_STARTED = 'Lifecycle execution started' as const;
export const NOTE_LIFECYCLE_COMPLETED = 'Lifecycle completed successfully' as const;
export const NOTE_PAUSED_APPROVAL_GATE = 'Paused at plan approval gate' as const;
export const NOTE_PAUSED_COMMIT_GATE = 'Paused at conventional commit gate' as const;
export const NOTE_AUTO_APPROVED_PLAN = 'Plan auto-approved in YOLO mode' as const;
export const NOTE_COMMIT_AFTER_EXECUTED = 'Commit automatically executed via --commit-after' as const;
export const NOTE_ALREADY_COMPLETED = 'Pipeline already completed' as const;
export const NOTE_WORKTREE_CREATED = 'Isolated git worktree provisioned' as const;
export const NOTE_WORKTREE_REMOVED = 'Isolated git worktree detached and cleaned' as const;
export const NOTE_WORKTREE_PRUNED = 'Dangling git worktrees pruned' as const;

export const COMMAND_PLAN = 'plan' as const;
export const COMMAND_IMPLEMENT = 'implement' as const;
export const COMMAND_GATES = 'gates' as const;
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

export const CLI_COMMANDS = Object.freeze({
  PLAN: COMMAND_PLAN,
  IMPLEMENT: COMMAND_IMPLEMENT,
  GATES: COMMAND_GATES,
  COMMIT: COMMAND_COMMIT,
  YOLO: COMMAND_YOLO,
  STATUS: COMMAND_STATUS,
  CONFIG: COMMAND_CONFIG,
  MODELS: COMMAND_MODELS,
  PROMPT: COMMAND_PROMPT,
  RESET: COMMAND_RESET,
  TRANSITION: COMMAND_TRANSITION,
  WORKTREE: COMMAND_WORKTREE,
  RELEASE: COMMAND_RELEASE,
  NEXT: COMMAND_NEXT,
  BRANCH_INFO: COMMAND_BRANCH_INFO,
  CRITIQUE: COMMAND_CRITIQUE
});

export type CliCommandName = typeof CLI_COMMANDS[keyof typeof CLI_COMMANDS];

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
  HELP: FLAG_HELP,
  HELP_SHORT: FLAG_HELP_SHORT,
  VERSION: FLAG_VERSION,
  VERSION_SHORT: FLAG_VERSION_SHORT
});




