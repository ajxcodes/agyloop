/* eslint-disable @typescript-eslint/no-unused-vars */

/** Operator-facing prompts / report labels (issue #298). */
export const LABEL_EXECUTION_CWD = 'Execution Cwd' as const;

export const LABEL_COMMAND_SOURCE = 'Command Source' as const;

export const LABEL_PLAN_INTEGRITY = 'Plan Integrity' as const;

export const LABEL_SMOKE_PROTOCOL = 'Smoke Protocol' as const;

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

export const LABEL_REVIEW_STATUS = 'Review Status' as const;

export const LABEL_REVIEW_SUMMARY = 'Review Summary' as const;

export const LABEL_UNFULFILLED_AC = 'Unfulfilled Acceptance Criteria' as const;

export const LABEL_REMEDIATION_GUIDANCE = 'Remediation Guidance' as const;


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

export const MARKER_GITHUB_WORKFLOWS = '.github/workflows' as const;


export const MARKER_EXT_CSPROJ = '.csproj' as const;

export const MARKER_EXT_SLN = '.sln' as const;

export const MARKER_EXT_FSPROJ = '.fsproj' as const;


export const MARKER_PNPM_WORKSPACE = 'pnpm-workspace.yaml' as const;

export const MARKER_TURBO_JSON = 'turbo.json' as const;

export const MARKER_NX_JSON = 'nx.json' as const;

export const MARKER_LERNA_JSON = 'lerna.json' as const;

export const MARKER_GO_WORK = 'go.work' as const;


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
 * The operator-facing label of the triage disposition line.
 */
export const LABEL_TRIAGE_DISPOSITION = 'Triage Disposition' as const;


/** The operator-facing label of the re-dispatch count (additive `status` line). */
export const LABEL_REVIEW_DISPATCHES = 'Review Dispatches' as const;


/** The operator-facing label of the IMPLEMENT re-dispatch count. */
export const LABEL_IMPLEMENT_DISPATCHES = 'Implementer Dispatches' as const;


/** Operator-facing labels of the two new re-dispatch counters. */
export const LABEL_DISCOVERY_DISPATCHES = 'Discovery Dispatches' as const;

export const LABEL_PLAN_DISPATCHES = 'Planner Dispatches' as const;


/** Operator-facing label of the recorded blank-plan park count. */
export const LABEL_PLAN_EMPTY_PARKS = 'Blank-Plan Parks' as const;
