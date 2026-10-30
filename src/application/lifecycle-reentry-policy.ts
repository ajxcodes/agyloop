/**
 * agyloop - Lifecycle Re-Entry Policy (Application Layer)
 *
 * The single chokepoint for every "a checkpoint is already at a stage, what now?"
 * decision (issue #237).
 *
 * Why this module exists: three orchestrated re-entry points used to each
 * re-implement the same rule inline, and the copies drifted. `StartPlanningUseCase`
 * advanced DISCOVERY -> PLAN unconditionally, which let an unattended YOLO re-run
 * stream straight out of a pristine, unpopulated discovery scaffold and bypass the
 * RCA gate entirely. `GetNextActionUseCase` inferred operator intent from whether
 * `--issue` happened to be supplied, destructively `reset()`ing a COMPLETED
 * checkpoint and persisting the forbidden `{ currentStage: "PLAN", planDir: null }`
 * snapshot. The root pattern is identical: application code re-implementing a
 * lifecycle decision inline instead of consulting one policy.
 *
 * Purity: depends on `../domain` only. No ports, no `fs`, no `process`, no
 * network — every export is a pure function or frozen data, so the rule tables
 * are unit-testable without a single mock.
 */

import { StageName, STAGE_DISCOVERY, STAGE_COMPLETED, STAGE_TRIAGE, IssueKind } from '../domain';

// ---- Discovery park (Defect 1) ------------------------------------------

/** Decision for a checkpoint already resting at DISCOVERY. */
export type DiscoveryReentryDecision = 'ADVANCE_TO_PLAN' | 'PARK_AT_DISCOVERY';

export interface DiscoveryReentryInput {
  /** Fail-closed guard: the rule only governs a checkpoint at DISCOVERY. */
  readonly currentStage: StageName;
  /** True when an RCA artifact with real content exists on disk. */
  readonly discoveryReportPresent: boolean;
  /** Explicit operator opt-in to bypass the RCA gate (`--skip-discovery`). */
  readonly skipDiscovery: boolean;
}

/** One row of the DISCOVERY re-entry table. `'any'` = wildcard. */
export interface DiscoveryReentryRule {
  readonly skipDiscovery: boolean | 'any';
  readonly discoveryReportPresent: boolean | 'any';
  readonly decision: DiscoveryReentryDecision;
}

/**
 * Ordered, first-match-wins. `currentStage !== DISCOVERY` never reaches this
 * table — `resolveDiscoveryReentry` short-circuits to the fail-closed park.
 *
 * R1/R2/R3 are ordered so the explicit opt-in wins (it is the documented escape
 * hatch and must never be shadowed), then content evidence, then the default.
 */
export const DISCOVERY_REENTRY_RULES: readonly DiscoveryReentryRule[] = Object.freeze([
  {
    skipDiscovery: true,
    discoveryReportPresent: 'any',
    decision: 'ADVANCE_TO_PLAN'
  },
  {
    skipDiscovery: false,
    discoveryReportPresent: true,
    decision: 'ADVANCE_TO_PLAN'
  },
  {
    skipDiscovery: false,
    discoveryReportPresent: false,
    decision: 'PARK_AT_DISCOVERY'
  }
] as const);

/**
 * Fail-closed decision for a checkpoint resting at DISCOVERY.
 *
 * Total function: never throws, never returns `undefined`. A non-DISCOVERY
 * stage returns the park before the table is consulted, and a table miss falls
 * through to the final `else` — so an exhaustive-table refactor can never
 * silently change a caller's behaviour into "advance".
 */
export function resolveDiscoveryReentry(input: DiscoveryReentryInput): DiscoveryReentryDecision {
  if (input.currentStage !== STAGE_DISCOVERY) {
    return 'PARK_AT_DISCOVERY';
  }

  for (const rule of DISCOVERY_REENTRY_RULES) {
    if (rule.skipDiscovery !== 'any' && rule.skipDiscovery !== input.skipDiscovery) {
      continue;
    }
    if (
      rule.discoveryReportPresent !== 'any' &&
      rule.discoveryReportPresent !== input.discoveryReportPresent
    ) {
      continue;
    }
    return rule.decision;
  }

  return 'PARK_AT_DISCOVERY';
}

// ---- Completed checkpoint (Defect 2) -----------------------------------

export type CompletedReentryDecision = 'REPORT_IDLE_COMPLETED' | 'ROUTE_TRIAGE' | 'RESTART';

export interface CompletedReentryInput {
  /** Fail-closed guard: the rule only governs a checkpoint at COMPLETED. */
  readonly currentStage: StageName;
  /** True only when the operator passed the explicit opt-in flag (`--restart`). */
  readonly restartOptIn: boolean;
  /** True when an OPEN PR carries review comments or CHANGES_REQUESTED. */
  readonly hasOpenReviewFeedback: boolean;
}

export interface CompletedReentryRule {
  readonly restartOptIn: boolean;
  readonly hasOpenReviewFeedback: boolean;
  readonly decision: CompletedReentryDecision;
}

/**
 * Ordered, first-match-wins. `currentStage !== COMPLETED` never reaches this
 * table — `resolveCompletedReentry` short-circuits to the idle report.
 *
 * R4 before R5 is the only non-obvious row: open review feedback OUTRANKS a
 * restart, because destroying a checkpoint that still has unaddressed feedback
 * would lose that feedback.
 *
 * R4 and R6 are the `hasOpenReviewFeedback: true` half of the rule, and
 * `resolveCompletedReentry` does NOT re-test that flag to reach them — it asks
 * `shouldRouteToTriage`, the one predicate `RunLifecycleUseCase` also consults.
 * These two rows are therefore a declarative mirror of the shared rule, kept
 * exhaustive so all four input combinations are readable in one place and the
 * table-driven test still covers them. Do not "fix" them into a literal
 * `hasOpenReviewFeedback: true` match: that was the original defect, where the
 * precedence was written twice and the two copies were free to drift.
 */
export const COMPLETED_REENTRY_RULES: readonly CompletedReentryRule[] = Object.freeze([
  {
    restartOptIn: true,
    hasOpenReviewFeedback: true,
    decision: 'ROUTE_TRIAGE'
  },
  {
    restartOptIn: true,
    hasOpenReviewFeedback: false,
    decision: 'RESTART'
  },
  {
    restartOptIn: false,
    hasOpenReviewFeedback: true,
    decision: 'ROUTE_TRIAGE'
  },
  {
    restartOptIn: false,
    hasOpenReviewFeedback: false,
    decision: 'REPORT_IDLE_COMPLETED'
  }
] as const);

/**
 * Fail-closed decision for a checkpoint resting at COMPLETED.
 *
 * Total function: never throws. A non-COMPLETED stage returns the idle report
 * before the table is consulted.
 *
 * The "feedback wins" precedence is DERIVED from `shouldRouteToTriage` rather
 * than re-encoded here. At COMPLETED that predicate reduces to exactly
 * `hasOpenReviewFeedback` (the stage can never already be TRIAGE), which is
 * what rows R4 and R6 of `COMPLETED_REENTRY_RULES` declare — so the precedence
 * has one definition and the two call sites can never disagree.
 *
 * Note the inputs: `restartOptIn` (explicit `--restart`) and evidence. There is
 * deliberately NO "isExplicit" input — inferring intent from whether `--issue`
 * happened to be supplied was the side-channel that produced Defect 2 in the
 * first place.
 */
export function resolveCompletedReentry(input: CompletedReentryInput): CompletedReentryDecision {
  if (input.currentStage !== STAGE_COMPLETED) {
    return 'REPORT_IDLE_COMPLETED';
  }

  if (
    shouldRouteToTriage({
      currentStage: input.currentStage,
      hasOpenReviewFeedback: input.hasOpenReviewFeedback
    })
  ) {
    return 'ROUTE_TRIAGE';
  }

  for (const rule of COMPLETED_REENTRY_RULES) {
    if (rule.restartOptIn !== input.restartOptIn) {
      continue;
    }
    if (rule.hasOpenReviewFeedback !== input.hasOpenReviewFeedback) {
      continue;
    }
    return rule.decision;
  }

  return 'REPORT_IDLE_COMPLETED';
}

// ---- Shared evidence predicate -----------------------------------------

export interface TriageRoutingInput {
  readonly currentStage: StageName;
  readonly hasOpenReviewFeedback: boolean;
}

/**
 * True when open PR review feedback must outrank whatever else the current run
 * was about.
 *
 * Shared by `RunLifecycleUseCase` (which routes to TRIAGE from ANY stage) and by
 * `resolveCompletedReentry` (COMPLETED only, where it supplies rows R4 and R6 of
 * `COMPLETED_REENTRY_RULES`), so the "feedback wins" precedence has one
 * definition and the two call sites can never disagree.
 *
 * The `currentStage !== STAGE_TRIAGE` clause is what makes it idempotent: a
 * checkpoint already parked at the TRIAGE gate must not be routed there again
 * by the feedback that put it there.
 */
export function shouldRouteToTriage(input: TriageRoutingInput): boolean {
  return input.hasOpenReviewFeedback && input.currentStage !== STAGE_TRIAGE;
}

// ---- Triage gate (issue #351) -------------------------------------------

export type TriageReentryDecision = 'REPORT_TRIAGE_GATE' | 'EXIT_TO_COMPLETED';

export interface TriageReentryInput {
  readonly currentStage: StageName;
  /** `GitHubPullRequestData.state` verbatim (`'OPEN' | 'MERGED' | 'CLOSED'`), or null when unmeasured. */
  readonly pullRequestState: string | null;
}

/**
 * Decision for a checkpoint already resting at TRIAGE (issue #351).
 *
 * `NOTE_TRIAGE_GATE_EXIT_CONDITION` names TWO endings and only the disposition
 * one was implemented: the TRIAGE directive was built without ever reading the
 * PR, so a merged/closed PR still demanded `codeloop resume` + `codeloop triage`.
 *
 * Fail-closed by construction: `null` (no gateway, gateway threw, no issue, no
 * PR) and any state the tool does not recognise REPORT the gate. The only input
 * that ends it is a measured terminal state, spelled exactly as the port spells
 * it (`GitHubPullRequestData.state`, upper-case, `MERGED` when `mergedAt` is set).
 */
export function resolveTriageReentry(input: TriageReentryInput): TriageReentryDecision {
  if (input.currentStage !== STAGE_TRIAGE) {
    return 'REPORT_TRIAGE_GATE';
  }
  const state = (input.pullRequestState ?? '').toUpperCase();
  if (state === 'MERGED' || state === 'CLOSED') {
    return 'EXIT_TO_COMPLETED';
  }
  return 'REPORT_TRIAGE_GATE';
}

// ---- Plan entry (issue #379) --------------------------------------------

/**
 * Which stage a `plan` entry takes, and which artifact it scaffolds.
 *
 * `PlanArtifactType` is what `scaffoldPlanDirectory` receives, so the artifact
 * prefix can never disagree with the entry stage.
 */
export type PlanEntryStage = 'DISCOVERY' | 'PLAN';
export type PlanArtifactType = 'discovery' | 'implementation';
export type PlanEntrySource =
  | 'skip-discovery'
  | 'type-override'
  | 'issue-kind-bug'
  | 'issue-kind-feature'
  | 'discovery-report-present'; // assigned by the use case, never by the table

export interface PlanEntryInput {
  readonly requestedType?: string | null;
  readonly issueKind: IssueKind;
  readonly skipDiscovery: boolean;
}

export interface PlanEntryDecision {
  readonly stage: PlanEntryStage;
  readonly artifactType: PlanArtifactType;
  readonly source: PlanEntrySource;
  readonly reason: string;
}

/** One row of the plan-entry table. `'any'` = wildcard. */
export interface PlanEntryRule {
  readonly skipDiscovery: boolean | 'any';
  readonly requestedType: 'discovery' | 'implementation' | 'auto' | 'any';
  readonly issueKind: IssueKind | 'any';
  readonly stage: PlanEntryStage;
  readonly source: PlanEntrySource;
  readonly reason: string;
}

/**
 * Ordered, first-match-wins.
 *
 * Precedence is the whole point: the explicit `--skip-discovery` escape hatch
 * must never be shadowed (R1), then an explicit `--type` override decides
 * (R2/R3), and only then does the issue kind select the stage (R4/R5).
 *
 * R5 closes the `auto` branch for every non-bug kind, so the table is
 * exhaustive for normalised input. `resolvePlanEntry` still falls back to the
 * R5-equivalent decision — advancing to PLAN is the historical, non-destructive
 * default — rather than parking a feature on an RCA requirement that does not
 * exist.
 */
export const PLAN_ENTRY_RULES: readonly PlanEntryRule[] = Object.freeze([
  {
    skipDiscovery: true,
    requestedType: 'any',
    issueKind: 'any',
    stage: 'PLAN',
    source: 'skip-discovery',
    reason: 'The operator explicitly bypassed the RCA gate with --skip-discovery.'
  },
  {
    skipDiscovery: false,
    requestedType: 'implementation',
    issueKind: 'any',
    stage: 'PLAN',
    source: 'type-override',
    reason: 'The operator explicitly requested an implementation plan.'
  },
  {
    skipDiscovery: false,
    requestedType: 'discovery',
    issueKind: 'any',
    stage: 'DISCOVERY',
    source: 'type-override',
    reason: 'The operator explicitly requested a discovery (RCA) entry.'
  },
  {
    skipDiscovery: false,
    requestedType: 'auto',
    issueKind: 'bug',
    stage: 'DISCOVERY',
    source: 'issue-kind-bug',
    reason: 'A bug issue needs root-cause analysis before a plan can be written.'
  },
  {
    skipDiscovery: false,
    requestedType: 'auto',
    issueKind: 'feature',
    stage: 'PLAN',
    source: 'issue-kind-feature',
    reason: 'A feature issue has no defect to root-cause, so planning starts directly.'
  }
] as const);

/**
 * Normalise the `--type` value.
 *
 * Only `discovery` and `implementation` are real values; everything else
 * (including `null`, `undefined`, `''`, `'feature'` and `'auto'` itself) means
 * "infer from the issue kind". Never throws.
 */
export function parseRequestedPlanType(
  raw?: string | null
): 'discovery' | 'implementation' | 'auto' {
  const normalised = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (normalised === 'discovery' || normalised === 'implementation') {
    return normalised;
  }
  return 'auto';
}

/**
 * Resolve the plan entry stage/artifact from the requested type, the issue kind
 * and the explicit skip flag.
 *
 * Total function: never throws, never returns `undefined`, and returns a frozen
 * decision. The artifact type is computed independently of the entry stage so a
 * bug with `--skip-discovery` still scaffolds its `[Discovery]` report while
 * entering PLAN — matching the behaviour that predates this policy.
 */
export function resolvePlanEntry(input: PlanEntryInput): PlanEntryDecision {
  const requestedType = parseRequestedPlanType(input.requestedType);

  const artifactType: PlanArtifactType =
    requestedType === 'discovery' || requestedType === 'implementation'
      ? requestedType
      : input.issueKind === 'bug'
        ? 'discovery'
        : 'implementation';

  for (const rule of PLAN_ENTRY_RULES) {
    if (rule.skipDiscovery !== 'any' && rule.skipDiscovery !== input.skipDiscovery) {
      continue;
    }
    if (rule.requestedType !== 'any' && rule.requestedType !== requestedType) {
      continue;
    }
    if (rule.issueKind !== 'any' && rule.issueKind !== input.issueKind) {
      continue;
    }
    return Object.freeze({
      stage: rule.stage,
      artifactType,
      source: rule.source,
      reason: rule.reason
    } as const);
  }

  // Fail-closed to the historical default: plan, never park, when the table
  // cannot describe the input (e.g. an unrecognised kind from a future caller).
  return Object.freeze({
    stage: 'PLAN',
    artifactType,
    source: 'issue-kind-feature',
    reason: 'Unrecognised entry input: advancing to PLAN is the non-destructive default.'
  } as const);
}
