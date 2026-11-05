/* eslint-disable @typescript-eslint/no-unused-vars */
export const CLI_VERSION = '0.7.0' as const;


/** Plan-sourced command definitions (issue #298). */
export const CMD_PREFIX_PLAN = 'plan' as const;

export const CMD_ID_PLAN_TARGET_PREFIX = `${CMD_PREFIX_PLAN}-` as const;

export const CMD_LABEL_PLAN_TARGET = 'Plan Target' as const;


/** Synthetic gate report ids for plan-contract failures (issue #298). */
export const CMD_ID_SMOKE_PROTOCOL = 'smoke-protocol' as const;

export const CMD_LABEL_SMOKE_PROTOCOL = 'Manual Smoke Test Protocol' as const;

export const CMD_ID_PLAN_INTEGRITY = 'plan-integrity' as const;

export const CMD_LABEL_PLAN_INTEGRITY = 'Approved Plan Integrity' as const;

/** Synthetic gate report id for a committed-tree gate target (issue #348). */
export const CMD_ID_GATE_TARGET_CONTRACT = 'gate-target-contract' as const;

export const CMD_LABEL_GATE_TARGET_CONTRACT = 'Quality Gate Target Contract' as const;


/** Workflow-lint composition definition (issue #369). */
export const CMD_ID_WORKFLOW_LINT = 'workflow-lint' as const;

export const CMD_LABEL_WORKFLOW_LINT = 'Workflow Lint (actionlint)' as const;


// Structured Quality Gate Summary Protocol Tokens & Thresholds
export const TOKEN_GATE_STATUS = 'GATE_STATUS' as const;

export const TOKEN_BUILD_STATUS = 'BUILD_STATUS' as const;

export const TOKEN_TEST_METRICS = 'TEST_METRICS' as const;

export const TOKEN_TEST_COUNT = 'TEST_COUNT' as const;

export const TOKEN_FAILURE_FILE = 'FAILURE_FILE' as const;

export const TOKEN_FAILING_ASSERTION = 'FAILING_ASSERTION' as const;

export const TOKEN_DIAGNOSTIC_SNIPPET = 'DIAGNOSTIC_SNIPPET' as const;

export const TOKEN_EXECUTION_MATRIX = 'EXECUTION_MATRIX' as const;


// Structured Review Verdict Protocol Tokens, Verdicts & Thresholds
export const TOKEN_REVIEW_STATUS = 'REVIEW_STATUS' as const;

export const TOKEN_REVIEW_SUMMARY = 'REVIEW_SUMMARY' as const;

export const TOKEN_UNFULFILLED_AC = 'UNFULFILLED_AC' as const;

export const TOKEN_REMEDIATION_GUIDANCE = 'REMEDIATION_GUIDANCE' as const;

export const TOKEN_REVIEW_FINDINGS = 'REVIEW_FINDINGS' as const;


// Command IDs
export const CMD_ID_TYPECHECK = 'typecheck' as const;

export const CMD_ID_BUILD = 'build' as const;

export const CMD_ID_LINT = 'lint' as const;

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


// Command Labels
export const CMD_LABEL_TYPECHECK = 'TypeScript Compilation & Typecheck' as const;

export const CMD_LABEL_BUILD = 'Build Script' as const;

export const CMD_LABEL_LINT = 'Lint' as const;

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

export const CMD_LABEL_CUSTOM = 'Custom Command' as const;

export const CMD_LABEL_CONFIG = 'Configured Command' as const;


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


/** `cd <relDir> && <command>` scoping (#334). */
export const CMD_SCOPE_WITH_DIR = 'cd' as const;

export const CMD_SCOPE_SEPARATOR = '&&' as const;


export const CMD_FLAG_MANIFEST_PATH = '--manifest-path' as const;

export const CMD_FLAG_PROJECT_DIR = '-p' as const;

export const CMD_FLAG_MAVEN_FILE = '-f' as const;


/** Separates a subproject command id from its repo-relative directory (#334). */
export const CMD_ID_SCOPE_SEPARATOR = ':' as const;


export const COMMAND_CRITIQUE = 'critique' as const;


export const TOKEN_BREAKING_CHANGE = 'BREAKING CHANGE:' as const;

export const TOKEN_BREAKING_EXCLAMATION = '!' as const;


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
 * `resume` is the command for a pause with **no forward command** — e.g. a
 * `CIRCUIT_BREAKER` quota halt. The gates that DO have one consume the pause
 * they answer: `implement` (`APPROVAL`), `commit` (`COMMIT`), and the terminal
 * TRIAGE exit performed by `next` (issue #367 corrects the old "ONLY command"
 * claim, which was already false). `codeloop next` otherwise merely prints the
 * next directive; it never touches `pausedAtGate`.
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
 * The inbound channel for a dispatched gate subagent's evidence (issue #284).
 *
 * The GATE subagent emits a `GATE_REPORT_JSON:` block — and until this command
 * existed there was no way to persist it, so the summary's gate metrics kept
 * the template's `PENDING` forever. This command IS that producer: the
 * orchestrator files the block, and `transition REVIEW` ingests it.
 */
export const COMMAND_GATE_REPORT = 'gate-report' as const;


/** The flags that carry a dispatched gate report to the evidence file. */
export const FLAG_REPORT_FILE = '--report-file' as const;

export const FLAG_REPORT_STDIN = '--report-stdin' as const;


/**
 * The flags that carry a dispatched reviewer verdict to the checkpoint.
 */
export const FLAG_VERDICT_FILE = '--verdict-file' as const;

export const FLAG_REVIEW_OUTPUT = '--review-output' as const;

export const FLAG_VERDICT_STDIN = '--verdict-stdin' as const;

/**
 * The hermetic Tier 1 evidence channel (issue #297).
 *
 * `codeloop review` executes the critique CLI so a supplied verdict cannot
 * bypass Tier 1. This flag supplies that report instead — the deduped,
 * subprocess-free path used by the CLI fixtures and by any caller that already
 * holds a critique JSON payload.
 */
export const FLAG_CRITIQUE_REPORT = '--critique-report' as const;


// ============================================================================
// Operator refutations (issue #349 / #242 AC4)
// ============================================================================

/**
 * The explicit refutation channel: `--refute '<path>:<line>[#<severity>]=<reason>'`.
 *
 * Content-aware blocking can never refute a FACTUAL false claim ("v7 does not
 * exist" when it does) — that sentence genuinely requests a change. This flag
 * is the operator's act of saying "I checked; this finding is false", and it is
 * deliberately loud: the reason is mandatory, every applied refutation is named
 * on stderr and recorded under `reviewRefutations` in the checkpoint.
 */
export const FLAG_REFUTE = '--refute' as const;


/** The command that files/acknowledges/list deviations. */
export const COMMAND_DEVIATION = 'deviation' as const;


/** The deviation channel's input flags. */
export const FLAG_DEVIATION_FILE = '--deviation-file' as const;

export const FLAG_DEVIATION_STDIN = '--deviation-stdin' as const;

export const FLAG_ACK = '--ack' as const;

export const FLAG_REASON = '--reason' as const;


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
  REVIEW: COMMAND_REVIEW,
  GATE_REPORT: COMMAND_GATE_REPORT,
  DEVIATION: COMMAND_DEVIATION
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
 * case only prints "use `codeloop next` instead", and they are not documented
 * commands.
 */
export const CLI_DOCUMENTED_COMMANDS: readonly string[] = Object.freeze(
  Object.values(CLI_COMMANDS)
);


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
