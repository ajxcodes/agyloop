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
export const ROLE_DESC_GATE =
  'Automated build, test suite, typecheck, and lint verification subagent executing in isolated shell execution' as const;


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


export const ERR_INVALID_TRANSITION = 'ERR_INVALID_TRANSITION' as const;
export const ERR_PHYSICAL_WRITE_VIOLATION = 'ERR_PHYSICAL_WRITE_VIOLATION' as const;
export const ERR_GITHUB_CONTEXT = 'ERR_GITHUB_CONTEXT' as const;
export const ERR_CONFIG_RESOLUTION = 'ERR_CONFIG_RESOLUTION' as const;
export const ERR_STATE_STORAGE = 'ERR_STATE_STORAGE' as const;
export const ERR_VALIDATION = 'ERR_VALIDATION' as const;
export const ERR_GATE_TIMEOUT = 'ERR_GATE_TIMEOUT' as const;
export const ERR_GATE_EXECUTION = 'ERR_GATE_EXECUTION' as const;
export const ERR_BUILD_DETECTION = 'ERR_BUILD_DETECTION' as const;

export const ERROR_CODES = Object.freeze({
  INVALID_TRANSITION: ERR_INVALID_TRANSITION,
  PHYSICAL_WRITE_VIOLATION: ERR_PHYSICAL_WRITE_VIOLATION,
  GITHUB_CONTEXT: ERR_GITHUB_CONTEXT,
  CONFIG_RESOLUTION: ERR_CONFIG_RESOLUTION,
  STATE_STORAGE: ERR_STATE_STORAGE,
  VALIDATION: ERR_VALIDATION,
  GATE_TIMEOUT: ERR_GATE_TIMEOUT,
  GATE_EXECUTION: ERR_GATE_EXECUTION,
  BUILD_DETECTION: ERR_BUILD_DETECTION
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
export const PROMPT_FILE_GATE = 'gate.md' as const;

// Transition Notes
export const NOTE_DEVELOPER_APPROVED = 'Approved by developer' as const;
export const NOTE_AUTO_APPROVED_YOLO = 'Auto-approved in YOLO mode' as const;
export const NOTE_MANUAL_TRANSITION = 'Manual CLI transition' as const;
export const NOTE_INITIATED_PLANNING = 'Initiated planning mode' as const;
export const NOTE_GENERATING_SPECS = 'Generating plan specifications' as const;
export const NOTE_AWAITING_REVIEW = 'Awaiting human review' as const;
export const NOTE_MANUAL_GATES_RUN = 'Manual gates run' as const;
export const NOTE_EXECUTING_GATES = 'Executing quality gates' as const;
export const NOTE_GATES_PASSED = 'Quality gates passed successfully' as const;
export const NOTE_GATES_FAILED = 'Quality gates failed' as const;

// Status Identifiers
export const STATUS_PASSED = 'PASSED' as const;
export const STATUS_FAILED = 'FAILED' as const;
export const STATUS_TIMED_OUT = 'TIMED_OUT' as const;
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

export const MARKER_GRADLEW = 'gradlew' as const;
export const MARKER_GRADLEW_BAT = 'gradlew.bat' as const;
export const MARKER_BUILD_GRADLE = 'build.gradle' as const;
export const MARKER_BUILD_GRADLE_KTS = 'build.gradle.kts' as const;
export const MARKER_SETTINGS_GRADLE = 'settings.gradle' as const;
export const MARKER_SETTINGS_GRADLE_KTS = 'settings.gradle.kts' as const;

export const MARKER_POM_XML = 'pom.xml' as const;

export const MARKER_EXT_CSPROJ = '.csproj' as const;
export const MARKER_EXT_SLN = '.sln' as const;
export const MARKER_EXT_FSPROJ = '.fsproj' as const;

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

2. **Full Modification Capability**:
   - You are equipped with both inspection tools (\`view_file\`, \`grep_search\`, \`find_by_name\`, \`list_dir\`) and modification tools (\`write_to_file\`, \`replace_file_content\`, \`run_command\`).
   - Use \`replace_file_content\` for surgical modifications to existing files.
   - Use \`write_to_file\` exclusively when creating brand-new source or test files.
   - Use \`run_command\` to execute tests, linters, and build commands to verify your changes.

---

## 2. Implementation Methodology

### Phase A: Target Verification
- Inspect the targeted files and symbols before editing using \`view_file\` or \`grep_search\`.
- Validate line numbers, imports, and surrounding syntax before constructing file replacements.

### Phase B: Surgical Implementation
- Apply modifications in logical, verifiable increments following the task checklist in the approved plan.
- Ensure all public APIs, types, interfaces, and value objects maintain strict backward compatibility unless explicitly deprecated in the approved plan.
- Preserve existing documentation, comments, and project conventions.

### Phase C: Empirical Verification
- After each milestone, run automated tests using \`run_command\` (e.g. \`npm test\` or targeted test runner commands).
- If tests fail or regressions occur, diagnose the failure immediately and rectify before advancing to subsequent checklist items.
- Ensure typecheck and linting commands succeed with zero errors and zero warnings.

---

## 3. Communication & Handoff

- Provide structured, concise status reports on completed checklist items.
- Reference modified files and test verification results explicitly.
- When all plan items are satisfied and tests pass, signal completion to the parent coordinator.` as const;

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


