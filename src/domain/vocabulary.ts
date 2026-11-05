/* eslint-disable @typescript-eslint/no-unused-vars */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _messages = () => require('./messages');
import { LifecycleGateName, STAGE_QUALITY_GATE } from './lifecycle-stages';
import { READ_ONLY_TOOLS, TOOL_FIND_BY_NAME, TOOL_GREP_SEARCH, TOOL_LIST_DIR, TOOL_REPLACE_FILE_CONTENT, TOOL_RUN_COMMAND, TOOL_VIEW_FILE, TOOL_WRITE_TO_FILE } from './tools';
import { ERROR_CODES, ERR_QUOTA_EXHAUSTED } from './errors';
import { GATE_APPROVAL, GATE_CIRCUIT_BREAKER, GATE_COMMIT, GATE_TRIAGE, VERDICT_APPROVED, VERDICT_CHANGES_REQUESTED, VERDICT_SKIPPED } from './gate-verdicts';
import { MARKER_BUILD_GRADLE, MARKER_BUILD_GRADLE_KTS, MARKER_EXT_CSPROJ, MARKER_EXT_FSPROJ, MARKER_EXT_SLN, MARKER_PLAYWRIGHT_CONFIG_CJS, MARKER_PLAYWRIGHT_CONFIG_JS, MARKER_PLAYWRIGHT_CONFIG_MJS, MARKER_PLAYWRIGHT_CONFIG_TS, MARKER_PYPROJECT_TOML, MARKER_PYTEST_INI, MARKER_REQUIREMENTS_TXT, MARKER_SETTINGS_GRADLE, MARKER_SETTINGS_GRADLE_KTS, MARKER_SETUP_PY } from './output-labels';
import { PLAN_DEVIATIONS_COMMIT_HEADER, PlanDeviationSummary, formatPlanDeviationsForCommitBody } from './plan-contract';
import { COMMAND_NEXT, COMMAND_PLAN, COMMAND_RESUME, COMMAND_REVIEW, COMMAND_TRANSITION, FLAG_CRITIQUE_REPORT, FLAG_REVIEW_OUTPUT, FLAG_VERDICT_FILE, FLAG_VERDICT_STDIN } from './cli-contract';
import { CRITIQUE_REPORT_RETURN_PREFIX } from './critique';


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


// Numeric Constants & Default Invariants
export const STATE_SCHEMA_VERSION = '1.0.0' as const;

export const MS_PER_SECOND = 1000 as const;

export const SECONDS_PER_MINUTE = 60 as const;

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


// Dispatch Counter Vocabulary & Warning (issue #242, absorbs #309.2)
//
// The counter labels were a repeated inline literal union and the warning was
// an inline template in `get-next-action.ts`. Both live here so every counter
// emits the same sentence byte-for-byte, pinned by a test.
export const DISPATCH_COUNTER_REVIEW = 'review' as const;

export const DISPATCH_COUNTER_DISCOVERY = 'discovery' as const;

export const DISPATCH_COUNTER_PLAN = 'plan' as const;

export const DISPATCH_COUNTER_IMPLEMENTATION = 'implementation' as const;


export const DISPATCH_COUNTER_KINDS = Object.freeze([
  DISPATCH_COUNTER_REVIEW,
  DISPATCH_COUNTER_DISCOVERY,
  DISPATCH_COUNTER_PLAN,
  DISPATCH_COUNTER_IMPLEMENTATION
] as const);


export type DispatchCounterKind = (typeof DISPATCH_COUNTER_KINDS)[number];


export function formatDispatchCounterUnrecorded(
  counter: DispatchCounterKind,
  stateFilePath: string
): string {
  return _messages().MSG_DISPATCH_COUNTER_UNRECORDED_TEMPLATE
    .replace('{counter}', counter)
    .replace('{path}', stateFilePath);
}


export const CB_ACTION_PAUSE_FOR_HUMAN = 'pause_for_human' as const;

export const CB_ACTION_ABORT = 'abort' as const;

export const CB_ACTION_WARN = 'warn' as const;


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
  // `review` records the reviewed verdict into the checkpoint, so it mutates
  // it exactly like `triage` does — it must be listed here for the
  // `AGY_SUBAGENT` root mutation guard to cover it. There is NO carve-out: the
  // dispatched REVIEWER only emits a verdict block, and the orchestrator (a
  // root session) is the one that files it (issue #297).
  'review',
  // `gate-report` files the dispatched gate subagent's evidence block into the
  // workspace (issue #284). Like `review`, it is NOT carved out: the GATE
  // subagent only EMITS the block, and the orchestrator (a root session) files
  // it — so a dispatched subagent can never certify its own round.
  'gate-report',
  // `deviation` records an implementer's plan deviation (issue #432). Like
  // `gate-report`, it is NOT carved out: the implementer emits the block and
  // the orchestrator files it, so a subagent cannot certify its own finding.
  'deviation',
  null
] as const);


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

/** A duration cell that cannot be attributed to the stage on the row. */
export const DURATION_NOT_RECORDED = '-' as const;

/** The summary's phrasing when evidence is absent (never `PENDING`). */
export const EVIDENCE_NOT_RECORDED = 'not recorded' as const;

export const PROMPT_FILE_PLANNER = 'planner.md' as const;

export const PROMPT_FILE_IMPLEMENTER = 'implementer.md' as const;

export const PROMPT_FILE_GATE = 'gate.md' as const;

export const PROMPT_FILE_REVIEWER = 'reviewer.md' as const;

export const PROMPT_FILE_DISCOVERY = 'discovery.md' as const;

export const PROMPT_FILE_TRIAGE = 'triage.md' as const;


/**
 * The plan's verification headings (issue #298). Case-insensitive, optional
 * numbering. The FIRST heading present wins; the smoke heading always ends
 * target collection.
 */
export const HEADING_QUALITY_GATE_TARGETS = 'Quality Gate Targets' as const;

export const HEADING_QUALITY_GATE_VERIFICATION = 'Quality Gate & Test Verification' as const;

export const HEADING_AUTOMATED_TEST_TARGETS = 'Automated Test Targets' as const;

export const HEADING_BUILD_LINT_COMMANDS = 'Build / Lint Commands' as const;

export const HEADING_MANUAL_SMOKE_TEST_PROTOCOL = 'Manual Smoke Test Protocol' as const;

/** The optional plan section that backs every declared baseline (issue #388). */
export const HEADING_BASELINE_EVIDENCE = 'Baseline Evidence' as const;


/** Static plan-baseline findings (issue #388). */
export const BASELINE_RULE_MISSING_EVIDENCE = 'missing-baseline-evidence' as const;

export const BASELINE_RULE_MISSING_VALUE = 'missing-baseline-value' as const;

export const BASELINE_RULE_MISSING_COMMAND = 'missing-baseline-command' as const;

export const BASELINE_RULE_MISSING_OUTPUT = 'missing-baseline-output' as const;

export const BASELINE_RULE_BODY_MISMATCH = 'baseline-body-mismatch' as const;

export const WORKFLOW_LINT_BINARY = 'actionlint' as const;


/** Shell-wrapper unwrap cap: deeper nesting is opaque, never an assertion (#369). */
export const MAX_SHELL_WRAPPER_DEPTH = 3 as const;


/** Test-run signals that relax the cross-worktree state guard (issue #298). */
export const ENV_NODE_ENV = 'NODE_ENV' as const;

export const ENV_NODE_VALUE_TEST = 'test' as const;

export const ENV_NODE_TEST_CONTEXT = 'NODE_TEST_CONTEXT' as const;

export const ENV_ALLOW_WORKTREE_ISSUE_MISMATCH = 'AGYLOOP_ALLOW_WORKTREE_ISSUE_MISMATCH' as const;

/**
 * The gate's smoke signal (issue #440): set ONLY on the frozen smoke script's
 * execution options, so a checkpoint mutation outside a recognised sandbox is
 * refused at runtime even for a block the static rule could not classify.
 */
export const ENV_AGYLOOP_SMOKE = 'AGYLOOP_SMOKE' as const;

export const ENV_FLAG_ENABLED = '1' as const;


/**
 * The ONE documented escape hatch from the cross-worktree state guard
 * (issues #405, #412).
 *
 * Tool-owned on purpose: Node's test runner reads `NODE_TEST_CONTEXT` to detect
 * a nested run, so advertising that variable made every documented test command
 * skip its files and exit 0. `NODE_TEST_CONTEXT` remains a silent
 * backward-compatible alias in `isTestCaseRun()`; no dispatch prompt may name
 * it. `NODE_ENV=test` is the legacy test-mode marker and is not advertised
 * either.
 */
export const WORKTREE_GUARD_SIGNAL = ENV_ALLOW_WORKTREE_ISSUE_MISMATCH;

/**
 * The ONE statement of the `Declared:`/`Output:` relationship (issue #402, D1).
 *
 * It is embedded verbatim in the planner directive, the plan template, the
 * refusal messages and the CLI help, so an author learns the label shape before
 * writing a claim and a refused author is told exactly which edit to make.
 */
export const BASELINE_DECLARED_SHAPE_SENTENCE =
  '`Declared:` must be the command\'s literal stdout (copy it verbatim); `Output:` must be the stdout that command printed. APPROVAL runs each command once and checks both against the fresh measurement — a `Declared:` carrying a value the command does not print is refused, and so is an `Output:` that does not match — while a prose `Declared:` is accepted only when `Output:` verifies.' as const;


/**
 * The ONE statement of the root-build mutation boundary (issue #402, Defect 2).
 *
 * The DISCOVERY directive, the APPROVAL baseline behaviour and the CLI help all
 * interpolate this constant instead of re-typing the rule.
 */
export const ROOT_BUILD_PROHIBITION_SENTENCE =
  'Never rebuild the repository root — the root build is what the installed `codeloop` executes, so a rebuild mid-run changes the pipeline\'s own tool.' as const;


/**
 * The ONE statement of the baseline command cwd contract (issue #418).
 *
 * The same guard measures a claim at APPROVAL (the operator's workspace) and at
 * IMPLEMENT (the task worktree, a pristine checkout with no build output). The
 * planner directive, both plan template copies, the CLI help and the
 * build-output refusal all interpolate this constant instead of re-typing the
 * rule.
 *
 * It must carry no `{placeholder}` braces: the constant is interpolated into
 * the plan template, which `renderTemplate` walks for `{Name}` tokens.
 */
export const BASELINE_COMMAND_CWD_CONTRACT =
  'Baseline commands are measured in more than one directory: APPROVAL runs each command in the workspace it is invoked from (the `--workspace` root, otherwise the current directory), and IMPLEMENT runs it again in the task worktree, which is a pristine checkout with no build output because `dist/` is git-ignored. A command must therefore print the same stdout in both directories, which rules out resolving the workspace\'s own build output (`./dist`, `./build`) at all. Every refusal names the cwd it measured in.' as const;


export const MAX_FILTERED_LOG_LINES = 30 as const;

export const MAX_FILTERED_OUTPUT_CHARS = 2500 as const;


export const MAX_DIAGNOSTIC_LINES = 25 as const;

export const MAX_DIAGNOSTIC_CHARS = 2000 as const;

export const DIAGNOSTIC_TRUNCATION_MARKER = '... [diagnostics truncated under 25 lines limit]' as const;


export const HEADER_QUALITY_GATE_REPORT = '=== CodeLoop: Quality Gate Report ===' as const;

export const SECTION_SELF_CORRECTION_TITLE = '### Self-Correction Quality Gate Failure Diagnostics:' as const;

/**
 * Canonical rejection text for an invalid `--issue` token (issue #250).
 *
 * `{raw}` is substituted with the offending token. ONE source of truth: the CLI
 * choke point, the checkpoint resolver, the file adapter and the reset use case
 * all quote the operator the same sentence.
 */
export const ISSUE_TOKEN_INVALID_MESSAGE = "Invalid --issue '{raw}'. Expected a positive integer (digits only), e.g. --issue 250." as const;

export const DIVIDER_DASHED = '----------------------------------------------------------------------' as const;


export const REVIEW_VERDICTS = Object.freeze([
  VERDICT_APPROVED,
  VERDICT_CHANGES_REQUESTED,
  VERDICT_SKIPPED
] as const);


export type ReviewVerdictState = typeof REVIEW_VERDICTS[number];


export const HEADER_REVIEW_VERDICT_REPORT = '=== CodeLoop: Review Verdict Report ===' as const;

export const SECTION_REVIEW_SELF_CORRECTION_TITLE = '### Reviewer Subagent Self-Correction Remediation Guidance:' as const;


export const STANDARD_CANDIDATE_PATHS = Object.freeze([
  '.github/critique.md',
  '.critique.md',
  '.github/ai-reviewer-standards.md',
  'AGENTS.md',
  'STANDARDS.md',
  'CONTRIBUTING.md'
] as const);


/** The human-gate title for a tracked write outside the plan directory. */
export const TITLE_DISCOVERY_BOUNDARY_VIOLATION = 'Discovery Boundary Violation' as const;


/**
 * The roots the boundary probe watches.
 *
 * `dist`/`build` are ignored build artefacts (invisible to `git status`), which
 * is exactly the reported defect class; `artifacts` is where the plan directory
 * lives, so an escape above the plan directory is still measured. `node_modules`
 * is deliberately absent: it is unbounded and not a candidate root build.
 */
export const WORKSPACE_MUTATION_WATCHED_ROOTS: readonly string[] = Object.freeze([
  'dist',
  'build',
  'artifacts'
]);


/** Upper bound on the files digested per root, so a read stays cheap. */
export const WORKSPACE_MUTATION_MAX_FILES_PER_ROOT = 20000;


/** Upper bound on the tracked paths a single comparison reports. */
export const WORKSPACE_MUTATION_MAX_REPORTED_PATHS = 20;


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


export const PYTHON_MARKERS = Object.freeze([
  MARKER_PYPROJECT_TOML,
  MARKER_PYTEST_INI,
  MARKER_SETUP_PY,
  MARKER_REQUIREMENTS_TXT
] as const);


export const GRADLE_MARKERS = Object.freeze([
  MARKER_BUILD_GRADLE,
  MARKER_BUILD_GRADLE_KTS,
  MARKER_SETTINGS_GRADLE,
  MARKER_SETTINGS_GRADLE_KTS
] as const);


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

export const FALLBACK_ECOSYSTEM_PRIORITY = 999 as const;


// Confidence Levels
export const CONFIDENCE_CERTAIN = 1.0 as const;

export const CONFIDENCE_NONE = 0.0 as const;


export const KEYWORD_CHECK = 'check' as const;

export const KEYWORD_VET = 'vet' as const;


/**
 * Wall-clock budget for one container runtime health probe (`podman info` /
 * `docker info`, issue #295). One place so the detector and any sibling probe
 * cannot drift apart.
 */
export const CONTAINER_PROBE_TIMEOUT_MS = 5000 as const;


// Detection Indicators & Script Constants
export const SCRIPT_NAME_TYPECHECK = 'typecheck' as const;

export const SCRIPT_NAME_BUILD = 'build' as const;

export const SCRIPT_NAME_LINT = 'lint' as const;

export const SCRIPT_NAME_TEST = 'test' as const;

export const NPM_DEFAULT_TEST_STUB = 'no test specified' as const;

export const PYTEST_INDICATOR_KEYWORD = 'pytest' as const;

export const PYTEST_CONFIG_HEADER = '[tool.pytest' as const;


// Polyglot / multi-workspace discovery vocabulary (issue #334)
/** Joins multiple ecosystem types into one composite label: 'node+dotnet'. */
export const ECOSYSTEM_LABEL_SEPARATOR = '+' as const;


/** Monorepo container directories whose children are subproject candidates. */
export const SUBPROJECT_CONTAINER_DIRS = Object.freeze([
  'apps',
  'projects',
  'packages',
  'services',
  'libs'
] as const);


/** Well-known single-project directories (one level, or two when marker-less). */
export const SUBPROJECT_NAMED_DIRS = Object.freeze([
  'backend',
  'frontend',
  'server',
  'client',
  'web',
  'api',
  'src-tauri'
] as const);


/** Directories that are never subprojects and are never descended into. */
export const SUBPROJECT_IGNORED_DIRS = Object.freeze([
  '.git',
  'node_modules',
  '.worktrees',
  'dist',
  'build',
  'target',
  '.next',
  'coverage',
  'artifacts',
  '.agyloop',
  '.codeloop',
  '.venv',
  'venv',
  '__pycache__',
  'obj',
  'bin',
  'out',
  '.turbo',
  '.nx',
  'vendor',
  'tmp'
] as const);


/** Bounded traversal depth (repo-relative segments below the workspace root). */
export const SUBPROJECT_MAX_DEPTH = 2 as const;

/** Hard cap on discovered subprojects, applied after the deterministic sort. */
export const SUBPROJECT_MAX_COUNT = 64 as const;


// Validation & Plan Constants
export const VALIDATION_FIELD_PLAN_PATH = 'planPath' as const;

/** The plan title a derived folder/filename is refused for (issue #364). */
export const VALIDATION_FIELD_PLAN_TITLE = 'planTitle' as const;

/** The plan artifact type an unclassified, unreadable entry refuses (#382). */
export const VALIDATION_FIELD_PLAN_TYPE = 'type' as const;



export const ANTI_INCEPTION_GUARDRAIL = `### Anti-Inception & Role Boundary Guardrail:
- You are an isolated worker subagent, NOT the orchestrator.
- You are STRICTLY FORBIDDEN from dispatching or spawning other subagents (including via your harness's subagent/task tool).
- Do not attempt to orchestrate lifecycle stages; perform your specific role directly.` as const;


/** Idempotent: a body that already carries the section is returned unchanged. */
export function planDeviationsCommitBody(
  body: string | null,
  records: readonly PlanDeviationSummary[]
): string | null {
  if (records.length === 0) return body;
  if (body !== null && body.includes(PLAN_DEVIATIONS_COMMIT_HEADER)) return body;
  const section = formatPlanDeviationsForCommitBody(records);
  if (section === null) return body;
  return body !== null && body.trim().length > 0 ? `${body}\n\n${section}` : section;
}






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

export const NODE_RUNTIME_BINARY = 'node' as const;

export const PATH_USER_DATA_CRITIQUE_DIR = '.local/share/critique' as const;

export const PATH_USER_DATA_CRITIQUE_MAC = 'Library/Application Support/critique' as const;


export const ENV_FILE_NAME = '.env' as const;

export const ENV_VAR_GEMINI_API_KEY = 'GEMINI_API_KEY' as const;


// Messages & Headings
export const BANNER_REVIEW_TITLE = '# 🤖 Independent AI PR Review' as const;

export const BANNER_CODE_COMMENTS = '## 📝 Code Comments' as const;

export const BANNER_SUMMARY = '## Summary' as const;


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


/**
 * The reviewer's three-status `AC_EVIDENCE` vocabulary (issue #506).
 *
 * ONE definition for all three surfaces a reviewer reads: the static prompt
 * below interpolates it, `buildReviewerTaskPrompt` renders it, and
 * `prompts/reviewer.md` carries it verbatim (DOC14 pins the three together).
 *
 * `out-of-scope` is the status a plan-declared operator step needs: no
 * delivered path can exist, and `unverifiable` always escalates (#432 AC5).
 */
export const REVIEWER_AC_EVIDENCE_STATUS_CONTRACT = [
  'The status you report is what the tool certifies, so choose it by where the evidence lives:',
  '- `met` — the criterion is satisfied by files in this diff; cite their paths.',
  '- `unverifiable` — a path that must ship in this diff is missing from it, or the only evidence is gitignored or outside this worktree. Name the path: the review command refuses an `APPROVED` verdict that carries one, so never use it for a criterion that has no delivered evidence BY DESIGN.',
  '- `out-of-scope` — the plan declares the criterion an operator step, a post-merge action, or deliberately undelivered: no delivered path can exist and none is expected. Report it `out-of-scope` with no path and name the plan declaration in the note; it is recorded and never escalates an `APPROVED` verdict. Never use it to excuse a change that should have shipped.'
].join('\n');






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


/**
 * The conventional-commit subject limit (issue #345 in #339, AC-4.4).
 *
 * `CommitMessage.toSingleLine()` truncates the DESCRIPTION at a word boundary
 * to respect it, so the drafted subject and the committed subject agree by
 * construction (single source).
 */
export const COMMIT_SUBJECT_MAX_LENGTH = 72;


export const PROMPT_CONFIRM_COMMIT = 'Commit staged changes with message? (y/N): ' as const;

export const CONFIRMATION_AFFIRMATIVE_RESPONSES = Object.freeze(['y', 'yes'] as const);


export const HEADER_COMMIT_DRAFT_REPORT = '=== CodeLoop: Conventional Commit Draft ===' as const;

export const SECTION_COMMIT_DETAILS_TITLE = '## Commit & Release Details' as const;


export const LIFECYCLE_GATES = Object.freeze({
  APPROVAL: GATE_APPROVAL,
  COMMIT: GATE_COMMIT,
  TRIAGE: GATE_TRIAGE,
  CIRCUIT_BREAKER: GATE_CIRCUIT_BREAKER
});


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


/**
 * Conditionally appends the resume hint to a park note (issue #315, AC-9).
 *
 * A park with no recorded pause returns the note unchanged: a hint to resume a
 * paused pipeline that is not paused is unreachable advice, which is exactly
 * Defect G.8.
 */
export function withRecordedPauseHint(
  note: string,
  pausedAtGate?: string | null
): string {
  const gate = (pausedAtGate ?? '').trim();
  return gate.length > 0 ? `${note} ${_messages().NOTE_RESUME_FIRST_WHEN_PAUSED}` : note;
}


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
 * Pathspecs the commit gate refuses to commit (issue #301, absorbing #319).
 *
 * ONE list: `DraftCommitUseCase` filters the printed list with the same
 * predicate `ExecuteCommitUseCase` uses for `git rm --cached`, so
 * `Files to commit (N)` can never disagree with what is committed.
 */
export const COMMIT_EXCLUDED_PATHSPECS: readonly string[] = Object.freeze([
  '.agyloop',
  'node_modules',
  'artifacts'
]);


/** True when a repo-relative path is one of the excluded trees. */
export function isCommitExcludedPath(rawPath: string): boolean {
  const normalised = rawPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!normalised) return false;
  return COMMIT_EXCLUDED_PATHSPECS.some(
    (excluded) => normalised === excluded || normalised.startsWith(`${excluded}/`)
  );
}

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
 * The outcome shown on the `Triage Action` line. A dismissal that only
 * partially succeeded must never be reported as an unqualified success.
 */
export const DISMISS_OUTCOME_COMPLETE = 'DISMISS' as const;

export const DISMISS_OUTCOME_PARTIAL = 'DISMISS (PARTIAL)' as const;

export const DISMISS_OUTCOME_FAILED = 'DISMISS (FAILED)' as const;

export const DISMISS_OUTCOME_NOTHING = 'DISMISS (NOTHING DISMISSED)' as const;


/**
 * The outcome shown when the dismissal was REFUSED before it could do
 * anything, or when the dry run predicts that refusal (#336).
 *
 * It is deliberately distinct from {@link DISMISS_OUTCOME_NOTHING}: that line
 * reports a run that happened and achieved nothing, while this one reports a
 * run that was never attempted — and must not be mistaken for one that was.
 */
export const DISMISS_OUTCOME_REFUSED = 'DISMISS (REFUSED)' as const;


/**
 * How many individual failures the operator-facing output spells out. The
 * count is always exact; only the detail list is truncated, so a run that hit
 * one rate limit on 28 threads stays readable.
 */
export const DISMISS_FAILURE_DETAIL_LIMIT = 10 as const;


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
  dismiss:
    'records a disposition and replies to/resolves the PR threads using -m "<notes>" (writes to GitHub; without -m nothing is posted and the dismissal is refused)'
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


/** The history-metadata marker for a gate that ended because the PR did (issue #351). */
export const TRIAGE_EXIT_PULL_REQUEST_TERMINAL = 'pr-terminal' as const;


/**
 * The surfaces the triage disposition line is rendered for (issue #269, R5).
 *
 * ONE renderer, FOUR surfaces: the CLI's triage output, the idle report, the
 * `status` report and the checkpoint history note each used to hand-render the
 * SAME facts, so the wording could drift apart. The frames live here, beside
 * the note they belong to, and the renderer in
 * `value-objects/triage-disposition.ts` is the single place that fills them.
 */
export const TRIAGE_DISPOSITION_SURFACES = Object.freeze([
  'history-note',
  'idle-report',
  'triage-cli',
  'status-report'
] as const);


export type TriageDispositionSurface = (typeof TRIAGE_DISPOSITION_SURFACES)[number];
const TRIAGE_DISPOSITION_RECORDED_FRAME =
  'recorded (action={actionUpper}, PR #{prNumber}, {count} feedback item(s), at {recordedAt})' as const;


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
 * The history note IS `_messages().NOTE_TRIAGE_DISPOSITION_RECORDED` — the domain constant
 * that already existed and was used for exactly one surface.
 */
/**
 * The disposition line's frame, declared ONCE (#336).
 *
 * `status` and the triage CLI render the same sentence about the same
 * disposition, so a second hand-typed frame is exactly how the two surfaces
 * would drift into contradicting each other.
 */

export const TRIAGE_DISPOSITION_LINE_TEMPLATES = Object.freeze({
  'history-note': 'Triage disposition recorded: {action} (PR #{prNumber}, {count} feedback item(s) at {recordedAt})',
  'idle-report':
    'Triage disposition recorded: action={action}, PR #{prNumber}, {count} feedback item(s), at {recordedAt}.',
  'triage-cli': `{label} : ${TRIAGE_DISPOSITION_RECORDED_FRAME}`,
  'status-report': `{label} : ${TRIAGE_DISPOSITION_RECORDED_FRAME}`
} as const);


/**
 * `sync`'s merged-PR page size (issue #447).
 *
 * `gh pr list` has no `--paginate` and caps an unflagged request at 30 results,
 * which is why `sync` used to process only the 30 most recent merges. The scan
 * asks for a page at a time and doubles until a page comes back SHORT.
 */
export const SYNC_MERGED_PR_PAGE_SIZE = 100 as const;


/**
 * The most merged PRs one `sync` scan will read (issue #447).
 *
 * A FULL page at this limit proves the window is incomplete, so the run
 * refuses every write and exits non-zero instead of reporting success.
 */
export const SYNC_MERGED_PR_SCAN_CEILING = 1000 as const;


/**
 * The contexts in which `act` (the CI-workflow simulation) was declared but not
 * executed (issue #325.4, AC-19).
 */
export type ActSkipContext =
  | 'plan-precedence'
  | 'runtime-unavailable'
  | 'no-workflows'
  | 'disabled';


/**
 * The TOOL's reason for `act` not running (issue #325.4, AC-19).
 *
 * The `Not Run` line used to publish the gate agent's prose, and the #311 gate
 * wrote "this repo is a local TypeScript/Node project with no CI-workflow
 * simulation in scope" — false: `.github/workflows/` exists. The true reason was
 * precedence: approved plan targets outrank `resolveActCommand`. An agent's
 * explanation of its own omission is not evidence, so the reason is derived
 * here from what the tool knows.
 */
export function formatActNotRunReason(context: {
  readonly planTargetCount: number;
  readonly actSkip: ActSkipContext;
}): string {
  switch (context.actSkip) {
    case 'plan-precedence': {
      const count = Number.isFinite(context.planTargetCount) ? Math.max(0, context.planTargetCount) : 0;
      return (
        'plan targets took precedence' +
        (count > 0 ? ` (${count} verification target${count === 1 ? '' : 's'})` : '')
      );
    }
    case 'no-workflows':
      return 'no workflow files exist to simulate';
    case 'disabled':
      return 'the CI-workflow simulation is disabled for this workspace';
    case 'runtime-unavailable':
    default:
      return 'the container runtime (act) is not available on this host';
  }
}


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


export function formatReviewVerdictChannelCommand(
  issue?: number | string | null,
  critiqueReportPath?: string | null
): string {
  const base =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? REVIEW_VERDICT_CHANNEL_COMMAND_NO_ISSUE_TEMPLATE
      : REVIEW_VERDICT_CHANNEL_COMMAND_TEMPLATE.replace('{issue}', String(issue));
  return critiqueReportPath ? `${base} ${FLAG_CRITIQUE_REPORT} '${critiqueReportPath}'` : base;
}


/**
 * The filing instruction, addressed to the ORCHESTRATOR (issue #297).
 *
 * #269 built the channel and #272 named it — but it was named inside the
 * DISPATCHED PROMPT, next to "Never attempt to write or edit files", so the
 * read-only reviewer was told to run a checkpoint-advancing command. The
 * contract is now single-voice: the reviewer emits the block, the orchestrator
 * (this directive's reader) files it.
 *
 * Every snippet interpolates the real issue when it is known, so the operator
 * is handed strings they can paste.
 */
export function formatReviewVerdictChannelNote(
  issue?: number | string | null,
  critiqueReportPath?: string | null
): string {
  const command = formatReviewVerdictChannelCommand(issue, critiqueReportPath);
  const issueToken =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? '<n>'
      : String(issue);
  const base = `Orchestrator: file the reviewer's emitted verdict block before the COMMIT gate: ${command} (or \`codeloop ${COMMAND_REVIEW} --issue ${issueToken} ${FLAG_REVIEW_OUTPUT} "<block>"\`, or pipe the block into \`codeloop ${COMMAND_REVIEW} --issue ${issueToken} ${FLAG_VERDICT_STDIN}\`).`;
  if (!critiqueReportPath) {
    return base;
  }
  return `${base} Tier 1 evidence: the reviewer writes it to the path above and names it on a \`${CRITIQUE_REPORT_RETURN_PREFIX}\` line. Pass that exact path with \`${FLAG_CRITIQUE_REPORT}\`; never auto-discover a file. If the reviewer named none, file without the flag — \`review\` will run critique itself.`;
}


// ============================================================================
// Finding actionability (issue #349)
// ============================================================================

/**
 * What a critique finding's BODY asks for, independent of its severity label
 * (issue #349).
 *
 * The model labels an affirmation ("Correctly pins actions/checkout@v7") as
 * `critical` often enough that severity alone is not a safe local gate. The
 * classification is a deterministic predicate over the body, and the ONLY
 * thing it decides is whether the finding requests a change:
 *
 *  - `change-request` — the body asks for (or names) a defect ⇒ it blocks;
 *  - `affirmation` — the body asserts the code is fine ⇒ it does NOT block;
 *  - `ambiguous` — no cue at all ⇒ it blocks (**fail closed**).
 *
 * `AiReviewFinding.isBlocking()` stays severity-only and unchanged: it is the
 * structural predicate the CI threshold vocabulary uses. Actionability is
 * layered ON TOP of it, never instead of it.
 */
export const FINDING_ACTIONABILITY_CHANGE_REQUEST = 'change-request' as const;

export const FINDING_ACTIONABILITY_AFFIRMATION = 'affirmation' as const;

export const FINDING_ACTIONABILITY_AMBIGUOUS = 'ambiguous' as const;

export const FINDING_ACTIONABILITIES = Object.freeze([
  FINDING_ACTIONABILITY_CHANGE_REQUEST,
  FINDING_ACTIONABILITY_AFFIRMATION,
  FINDING_ACTIONABILITY_AMBIGUOUS
] as const);

export type FindingActionability = (typeof FINDING_ACTIONABILITIES)[number];


/** How many characters of a finding body a note (and `--json`) prints. */
export const FINDING_BODY_EXCERPT_CHARS = 160 as const;


/** A finding body, whitespace-collapsed and cut to `FINDING_BODY_EXCERPT_CHARS`. */
export function excerptFindingBody(body: string): string {
  const collapsed = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= FINDING_BODY_EXCERPT_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, FINDING_BODY_EXCERPT_CHARS - 3)}...`;
}


/**
 * The structural shape of an exempted (affirmation) blocking finding.
 *
 * Declared HERE, not in the value object, so this module needs no import from
 * `value-objects/` (no cycle) and the CLI/use case map `AiReviewFinding` into
 * it explicitly. It is also the `--json` shape.
 */
export interface NonActionableFindingSummary {
  readonly path: string;
  readonly line: number;
  readonly severity: string;
  readonly actionability: FindingActionability;
  readonly body: string;
}


/** Never silent: every exempted finding is named on stderr, both output modes. */
export function formatNonActionableFindingsNote(
  findings: readonly NonActionableFindingSummary[]
): string {
  if (!findings || findings.length === 0) {
    return '';
  }
  const lines = [_messages().NOTE_REVIEW_NON_ACTIONABLE_HEADER.replace('{n}', String(findings.length))];
  for (const finding of findings) {
    lines.push(
      _messages().NOTE_REVIEW_NON_ACTIONABLE_LINE
        .replace('{path}', finding.path)
        .replace('{line}', String(finding.line))
        .replace('{severity}', finding.severity)
        .replace('{actionability}', finding.actionability)
        .replace('{body}', excerptFindingBody(finding.body))
    );
  }
  return lines.join('\n');
}

/** Splits `--refute` at the FIRST occurrence: `<location>=<reason>`. */
export const REFUTATION_REASON_SEPARATOR = '=' as const;

/** The optional severity selector, split at the LAST occurrence: `<path>:<line>#<severity>`. */
export const REFUTATION_SEVERITY_MARKER = '#' as const;


/** The structural shape of one applied refutation (stderr + `--json` + checkpoint). */
export interface RefutedFindingSummary {
  readonly target: string;
  readonly severity: string;
  readonly actionability: FindingActionability;
  readonly body: string;
  readonly reason: string;
}


export function formatRefutedFindingsNote(findings: readonly RefutedFindingSummary[]): string {
  if (!findings || findings.length === 0) {
    return '';
  }
  const lines = [_messages().NOTE_REVIEW_REFUTED_HEADER.replace('{n}', String(findings.length))];
  for (const finding of findings) {
    lines.push(
      _messages().NOTE_REVIEW_REFUTED_LINE
        .replace('{target}', finding.target)
        .replace('{severity}', finding.severity)
        .replace('{actionability}', finding.actionability)
        .replace('{body}', excerptFindingBody(finding.body))
    );
    lines.push(_messages().NOTE_REVIEW_REFUTED_REASON_LINE.replace('{reason}', finding.reason));
  }
  return lines.join('\n');
}


/**
 * ONE renderer for a `codeloop transition <STAGE>` command (issue #327).
 *
 * Every recovery path this boundary prints is composed from this, so a named
 * hop cannot drift from the stage the table actually allows.
 */
export const TRANSITION_COMMAND_TEMPLATE =
  `codeloop ${COMMAND_TRANSITION} {stage} --issue {issue}` as const;

export const TRANSITION_COMMAND_NO_ISSUE_TEMPLATE =
  `codeloop ${COMMAND_TRANSITION} {stage}` as const;


// ============================================================================
// IMPLEMENT -> QUALITY_GATE boundary contract (issue #327, Defect 4)
// ============================================================================

/** The command that ADVANCES the IMPLEMENT stage (issue #327). */
export const IMPLEMENT_ADVANCE_COMMAND_TEMPLATE =
  `codeloop ${COMMAND_TRANSITION} ${STAGE_QUALITY_GATE} --issue {issue}` as const;

export const IMPLEMENT_ADVANCE_COMMAND_NO_ISSUE_TEMPLATE =
  `codeloop ${COMMAND_TRANSITION} ${STAGE_QUALITY_GATE}` as const;


export function formatImplementAdvanceCommand(issue?: number | string | null): string {
  if (issue === null || issue === undefined || String(issue).trim().length === 0) {
    return IMPLEMENT_ADVANCE_COMMAND_NO_ISSUE_TEMPLATE;
  }
  return IMPLEMENT_ADVANCE_COMMAND_TEMPLATE.replace('{issue}', String(issue));
}


/**
 * The real command that starts a new lifecycle (issue #337).
 *
 * `codeloop plan --issue <n>` scaffolds the plan directory and halts at the
 * APPROVAL gate; before #337 the idle directive named the literal placeholder
 * `codeloop <task>`, which is not a command.
 */
export const NEW_LIFECYCLE_COMMAND = `codeloop ${COMMAND_PLAN} --issue <n>` as const;


/** The real command that re-opens a COMPLETED checkpoint (issue #337). */
export const REOPEN_COMPLETED_COMMAND = `codeloop ${COMMAND_NEXT} --restart --issue <n>` as const;


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


/**
 * Ephemeral runtime paths that must be git-ignored.
 *
 * One documented split (issue #315, AC-12): **config in `.codeloop/`, state in
 * `.agyloop/`.** Every checkpoint the tool reads or writes lands under
 * `.agyloop/`, so only those state paths are listed. The former
 * `.codeloop/state.json`, `tasks/`, `locks/`, `logs/`, `critique-update-cache.json`
 * and `*.bak` rules were dead — no code path ever wrote them — and gitignoring a
 * path the tool does not use is a false claim about where state lives.
 *
 * `.codeloop/config.json` and `.agyloop/config.json` are intentionally absent so
 * project config stays tracked.
 */
export const INIT_GITIGNORE_RULES: readonly string[] = Object.freeze([
  '.agyloop',        // bare entry matches the .agyloop symlink created in worktrees (git mode 120000)
  '!.agyloop/',      // re-include the real directory so .agyloop/config.json stays trackable
  '.agyloop/state.json',
  '.agyloop/tasks/',
  '.agyloop/critique/',     // dispatched-review Tier 1 evidence (issue #397)
  '.agyloop/locks/',
  '.agyloop/logs/',
  '.agyloop/critique-update-cache.json',
  '.agyloop/*.bak',
  '.worktrees/'
]);


/** The reviewer's per-AC evidence block (issue #432, AC5). */
export const AC_EVIDENCE_MARKER = 'AC_EVIDENCE:' as const;


/**
 * The reviewer prompt's ONLY AC_EVIDENCE coverage claim (issue #439, D2).
 *
 * `filedVerdictEvidenceRefusal` enforces a present, parseable block and
 * classifies each reported entry — never per-criterion coverage. The
 * pre-#439 sentence demanded an entry for every declared criterion, which
 * nothing checks.
 */
export const REVIEWER_AC_EVIDENCE_SENTENCE =
  'Report every criterion you verified; a criterion the plan declares an operator step or deliberately undelivered is `out-of-scope` with no path, a criterion you cannot evidence is `unverifiable`, never `met`, and "None" is not an entry.' as const;


/** The plan's Test Register heading (issue #432, AC3). */
export const HEADING_TEST_REGISTER = 'Test Register' as const;


/** The planner's deliberate non-delivery declaration (issue #432, AC6). */
export const HEADING_OUT_OF_SCOPE = 'Out of Scope' as const;


/** The third two-tier escalation reason (issue #432, AC5). */
export const REVIEW_ESCALATION_UNVERIFIABLE_EVIDENCE = 'unverifiable-evidence' as const;


/**
 * The deviation statuses the reviewer may report for one AC (issue #432).
 */
export const AC_EVIDENCE_STATUS_MET = 'met' as const;

export const AC_EVIDENCE_STATUS_UNVERIFIABLE = 'unverifiable' as const;

export const AC_EVIDENCE_STATUS_OUT_OF_SCOPE = 'out-of-scope' as const;


export type AcEvidenceStatus =
  | typeof AC_EVIDENCE_STATUS_MET
  | typeof AC_EVIDENCE_STATUS_UNVERIFIABLE
  | typeof AC_EVIDENCE_STATUS_OUT_OF_SCOPE;


export function formatAcEvidenceOperatorStepDiagnostic(declaration: string): string {
  return _messages().MSG_AC_EVIDENCE_OPERATOR_STEP.replace('{declaration}', () => declaration);
}


export function formatAcEvidenceOperatorStepRemedy(ac: string): string {
  return _messages().MSG_AC_EVIDENCE_OPERATOR_STEP_REMEDY.replace('{ac}', () => ac);
}


export function formatAcEvidenceOperatorStepSummary(count: number): string {
  return _messages().MSG_AC_EVIDENCE_OPERATOR_STEP_SUMMARY.replace('{count}', String(count));
}


/** The line-level shape the malformed-block formatter renders (issue #435). */
export interface AcEvidenceIssueSummary {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}


/** The refusal for an APPROVED verdict with no reported block. */
export function formatAcEvidenceRequiredMessage(count: number): string {
  return _messages().MSG_AC_EVIDENCE_REQUIRED.replace('{count}', String(count));
}


/**
 * The refusal for a reported block that parsed to nothing.
 *
 * Every offending line is named with its number and text, so the reviewer can
 * fix the block without guessing which line was rejected.
 */
export function formatAcEvidenceMalformedMessage(
  issues: readonly AcEvidenceIssueSummary[]
): string {
  const lines =
    issues.length === 0
      ? 'The block carries no entries.'
      : issues.map((issue) => `line ${issue.line} (\`${issue.text}\`) — ${issue.reason}`).join('\n  ');
  return _messages().MSG_AC_EVIDENCE_MALFORMED.replace('{lines}', () => lines);
}


/** The reviewer prompt's AC evidence block example, built from the marker. */
export function formatAcEvidenceExample(): string {
  return [
    `${AC_EVIDENCE_MARKER}`,
    `- AC1: ${AC_EVIDENCE_STATUS_MET} — \`src/domain/plan-deviation.ts\`, \`tests/domain/plan-deviation.test.ts\``,
    `- AC2: ${AC_EVIDENCE_STATUS_UNVERIFIABLE} — \`src/domain/missing-module.ts\``,
    `- AC4: ${AC_EVIDENCE_STATUS_OUT_OF_SCOPE} — the plan declares Step 11 an operator step, so no delivered path exists`
  ].join('\n');
}


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


/** Circuit-breaker action taken when a runner fails over after quota exhaustion. */
export const CB_ACTION_FAILOVER = 'failover' as const;


/** Breaker name recorded when the primary runner fails over to a fallback runner. */
export const CB_FAILOVER_BREAKER_NAME = 'runnerFailover' as const;
