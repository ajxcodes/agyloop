/* eslint-disable @typescript-eslint/no-unused-vars */
import { STAGE_IMPLEMENT, STAGE_QUALITY_GATE, STAGE_REVIEW, formatTransitionCommand } from './lifecycle-stages';
import { TOOL_RUN_COMMAND, TOOL_VIEW_FILE } from './tools';
import type { SmokeProtocolWireValue } from './value-objects/smoke-protocol';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _messages = () => require('./messages');
import { COMMAND_GATE_REPORT, COMMAND_TRANSITION, FLAG_REPORT_FILE, FLAG_REPORT_STDIN } from './cli-contract';



export const GATE_TOOLS = Object.freeze([
  TOOL_RUN_COMMAND,
  TOOL_VIEW_FILE
] as const);

/** The marker a dispatched gate subagent emits as the last block of its response. */
export const GATE_REPORT_JSON_MARKER = 'GATE_REPORT_JSON:' as const;

/** The recorded gate verdict that means "the gate stage exited with no evidence". */
export const GATE_VERDICT_NOT_RECORDED = 'NOT_RECORDED' as const;


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


/**
 * Gate command provenance (issue #298).
 *
 * The resolver returns the source it used so a dispatched payload or an
 * in-process gate can state WHY this list was executed. The source is never
 * inferred by a consumer.
 */
export const GATE_COMMAND_SOURCE_EXPLICIT = 'explicit' as const;

export const GATE_COMMAND_SOURCE_PLAN = 'plan' as const;

export const GATE_COMMAND_SOURCE_CONFIG = 'config' as const;

export const GATE_COMMAND_SOURCE_ACT = 'act' as const;

export const GATE_COMMAND_SOURCE_AUTO_DETECT = 'auto-detect' as const;

export const GATE_COMMAND_SOURCE_DEFAULT = 'default' as const;


/** The ONE precedence string quoted by prompts and reports. */
export const GATE_COMMAND_PRECEDENCE =
  'explicit > plan > config > act > auto-detect > default' as const;

/**
 * The tool's single `GATE_REPORT_JSON:` marker producer (issue #413). A check
 * that builds its report through `formatGateReportExample` carries the marker
 * `GateResultReport.parseBlock` requires, so Rule C must not refuse it. The
 * producer only counts on a non-comment line: prose naming it is not a report.
 */
export const GATE_REPORT_MARKER_PRODUCER = 'formatGateReportExample' as const;


/** Static Quality Gate Target findings (issue #348, #369). */
export const GATE_TARGET_RULE_COMMITTED_TREE_ASSERTION = 'committed-tree-assertion' as const;

/** A declared entry the parser could not turn into an executable command (#369). */
export const GATE_TARGET_RULE_UNEXECUTABLE_TARGET = 'unexecutable-target' as const;

/** The change touches workflows but the composed command list has no linter (#369). */
export const GATE_TARGET_RULE_WORKFLOW_LINT_MISSING = 'workflow-lint-missing' as const;


/**
 * The documented gate-command contract (issue #348, AC2; composed by #369).
 *
 * ONE sentence block rendered in the gate task prompt, the planner system
 * prompt (both the on-disk copy and the compiled fallback) and the skill doc,
 * so no plan author or gate subagent has to infer the execution semantics.
 */
export const GATE_COMMAND_WORKTREE_CONTRACT =
  '**Gate command contract.** Gate commands run in the task worktree, in plan order, with that worktree as the working directory, and they run **before the commit gate**. No synthetic commit is created: the commands see the **UNCOMMITTED** change. Every command must therefore pass on that dirty tree. A committed-tree **assertion** — `git diff --exit-code`, `git diff --quiet`, `git diff HEAD --exit-code` (bare or behind a shell wrapper such as `bash -c`) — can never pass there and is rejected at plan approval, naming the command. **Listing** forms are allowed because they exit 0 on a dirty tree: `git diff`, `git diff --stat`, `git diff --name-only HEAD`, `git diff --check`, `git diff --cached`, `git diff HEAD`, `git status --porcelain`. Keep committed-tree invariants in CI (`.github/workflows/ci.yml`), or express them in a script the gate can run (`bash scripts/<name>.sh`) that snapshots the pre-state and compares after. Editing the plan after approval invalidates the approved digest, so fix the command *before* approving. Command-list precedence is `explicit > plan > config > act > auto-detect > default` (`GATE_COMMAND_PRECEDENCE`). Declaring targets replaces the act container gate, so when the change under test touches `.github/workflows/**` a plan-sourced list is COMPOSED with a workflow linter (`act -j <job>` first, then `actionlint`) with visible provenance, and the gate refuses when neither can be resolved.' as const;


export const VERDICT_APPROVED = 'APPROVED' as const;

export const VERDICT_CHANGES_REQUESTED = 'CHANGES_REQUESTED' as const;

/**
 * Third verdict state (issue #236): "review did not run". Set ONLY by the system
 * (RunReviewUseCase) when there is neither Reviewer-subagent output nor a critique
 * report — an advisory fail-open that never reverts the pipeline.
 */
export const VERDICT_SKIPPED = 'SKIPPED' as const;


// ============================================================================
// Operational Modes, Flags, Gate Names & Lifecycle Notes
// ============================================================================

export const GATE_APPROVAL = 'APPROVAL' as const;

export const GATE_COMMIT = 'COMMIT' as const;

export const GATE_TRIAGE = 'TRIAGE' as const;

export const GATE_CIRCUIT_BREAKER = 'CIRCUIT_BREAKER' as const;


export function formatTriageGateEndedNote(state: string, prNumber?: number | null): string {
  const target =
    prNumber === null || prNumber === undefined
      ? 'the pull request'
      : `PR #${prNumber}`;
  const normalized = state.toUpperCase();
  // Only a measured CLOSED state carries the non-delivery clause. MERGED (and
  // any value the tool does not recognise) keeps the neutral sentence: the note
  // must never invent a delivery verdict it did not measure.
  const template =
    normalized === 'CLOSED'
      ? _messages().NOTE_TRIAGE_GATE_ENDED_BY_PR_STATE_NOT_DELIVERED
      : _messages().NOTE_TRIAGE_GATE_ENDED_BY_PR_STATE;
  return template.replace('{pr}', target).replace('{state}', normalized);
}


/**
 * The gate-evidence channel, named in the QUALITY_GATE directive (issue #284).
 *
 * Mirrors `formatReviewVerdictChannelCommand`: composed from the command and
 * flag constants, with the concrete issue interpolated when known so the
 * orchestrator is handed a string it can paste.
 */
export const GATE_REPORT_CHANNEL_COMMAND_TEMPLATE =
  `codeloop ${COMMAND_GATE_REPORT} --issue {issue} ${FLAG_REPORT_FILE} <path>` as const;

export const GATE_REPORT_CHANNEL_COMMAND_NO_ISSUE_TEMPLATE =
  `codeloop ${COMMAND_GATE_REPORT} --issue <n> ${FLAG_REPORT_FILE} <path>` as const;


export function formatGateReportChannelCommand(issue?: number | string | null): string {
  if (issue === null || issue === undefined || String(issue).trim().length === 0) {
    return GATE_REPORT_CHANNEL_COMMAND_NO_ISSUE_TEMPLATE;
  }
  return GATE_REPORT_CHANNEL_COMMAND_TEMPLATE.replace('{issue}', String(issue));
}


/**
 * The filing instruction, addressed to the ORCHESTRATOR (issue #284).
 *
 * Same single-voice contract as `formatReviewVerdictChannelNote`: the dispatched
 * gate only emits the block, and the orchestrator files it. A command named in
 * the gate's own prompt would be a promise the `AGY_SUBAGENT` guard breaks.
 */
export function formatGateReportChannelNote(issue?: number | string | null): string {
  const command = formatGateReportChannelCommand(issue);
  const issueToken =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? '<n>'
      : String(issue);
  return `Orchestrator: file the gate's emitted GATE_REPORT_JSON block before advancing: ${command} (or pipe it into \`codeloop ${COMMAND_GATE_REPORT} --issue ${issueToken} ${FLAG_REPORT_STDIN}\`). \`codeloop ${COMMAND_TRANSITION} ${STAGE_REVIEW} --issue ${issueToken}\` refuses until this round's block is filed, so the gate cannot exit without evidence.`;
}


/**
 * The gate prompt's emitted `GATE_REPORT_JSON` example (issue #311).
 *
 * ONE producer, so the example the prompt shows is literally what
 * `GateResultReport.parseBlock` accepts: well-formed JSON, a member of
 * `SMOKE_PROTOCOL_VALUES` for `smokeProtocol` (never a false `PASSED` when the
 * plan declares no protocol), and placeholders confined to strings and zeroes.
 */
export function formatGateReportExample(smokeProtocol: SmokeProtocolWireValue): string {
  // A plan with no protocol has no check to show: the example must not model
  // an invented check (issue #338, R6). The shape is still published by
  // _messages().NOTE_GATE_REPORT_EVIDENCE_SHAPES.
  const smokeChecks =
    smokeProtocol === 'NOT_DECLARED'
      ? '[]'
      : '[{ "id": "<check-id>", "label": "<check label>", "passed": true }]';
  return [
    GATE_REPORT_JSON_MARKER,
    `{ "verdict": "${STATUS_PASSED}", "buildSystem": "<id>", "buildStatus": "${STATUS_PASSED}",`,
    `  "testsStatus": "${STATUS_PASSED} (N passed)", "testsPassed": 0, "testsFailed": 0,`,
    `  "durationMs": 0, "executedCommands": ["<command>"],`,
    `  "commandResults": [{ "command": "<command>", "passed": 0, "failed": 0 }],`,
    `  "smokeChecks": ${smokeChecks}, "smokeProtocol": "${smokeProtocol}",`,
    `  "notRun": [{ "id": "<gate-id>", "label": "<gate label>", "reason": "<why it did not run>" }] }`
  ].join('\n');
}


/** The command that ADVANCES the QUALITY_GATE stage (issue #311). */
export const GATE_ADVANCE_COMMAND_TEMPLATE =
  `codeloop ${COMMAND_TRANSITION} ${STAGE_REVIEW} --issue {issue}` as const;

export const GATE_ADVANCE_COMMAND_NO_ISSUE_TEMPLATE =
  `codeloop ${COMMAND_TRANSITION} ${STAGE_REVIEW}` as const;


/**
 * The command that ADVANCES the QUALITY_GATE stage (issue #337).
 *
 * ONE renderer for the gate exit: `gate-report`'s `Next:` line, the filed-
 * evidence directive and the stale-block directive all compose it, so the
 * hop they name cannot drift apart.
 */
export function formatGateAdvanceCommand(issue?: number | string | null): string {
  if (issue === null || issue === undefined || String(issue).trim().length === 0) {
    return GATE_ADVANCE_COMMAND_NO_ISSUE_TEMPLATE;
  }
  return GATE_ADVANCE_COMMAND_TEMPLATE.replace('{issue}', String(issue));
}


/**
 * The `Next:` line `gate-report` may print, derived from the CHECKPOINT stage
 * (issue #311).
 *
 * Filing evidence is only meaningful at `QUALITY_GATE`: that is the only stage
 * whose exit ingests the record. Printing the same line at `REVIEW` advised a
 * self-transition the state machine rejects. Anything that is not the filing
 * stage gets no advice at all (`null`) rather than an illegal command.
 */
export function formatGateReportAdvanceCommand(
  stage: string | null | undefined,
  issue?: number | string | null
): string | null {
  if (stage !== STAGE_QUALITY_GATE) {
    return null;
  }
  return formatGateAdvanceCommand(issue);
}


/**
 * The QUALITY_GATE completion note when THIS round's evidence is filed
 * (issue #337).
 *
 * `next` reads the same evidence `transition REVIEW` ingests, so it can no
 * longer tell the operator to file a block the checkpoint already holds.
 */
export function formatGateEvidenceFiledNote(issue?: number | string | null): string {
  return `${_messages().NOTE_GATE_EVIDENCE_FILED} Advance with \`${formatGateAdvanceCommand(issue)}\`.`;
}


/**
 * The retry route a filed `FAILED` verdict names (issue #337).
 *
 * The stage is still complete — the gate ran and its block is on record — so
 * the directive stays an `advance`; this only names the legal next hop for a
 * failed run. Verdict ROUTING policy is out of scope.
 */
export function formatGateFailedRetryNote(issue?: number | string | null): string {
  return `The filed verdict is FAILED: to fix the failures and retry, advance with \`${formatTransitionCommand(STAGE_IMPLEMENT, issue)}\`.`;
}


/**
 * The gate-failure block attached to a re-dispatched implementer (issue #337).
 *
 * The recorded diagnostics (`gateTokens` / `selfCorrectionPayload` /
 * `failureSnippet`) travel VERBATIM under a heading that supplies the context
 * the raw record lacks — the same rule `buildReviewRemediation` applies to the
 * reviewer's `reviewTokens`. A gate filed through `gate-report` records the
 * verdict only, so the block is still emitted (the heading and the framing
 * sentence) and simply carries no diagnostics.
 */
export function formatGateFailureRemediationPayload(
  diagnostics?: string | null
): string {
  const body = (diagnostics ?? '').trim();
  const head = `${_messages().NOTE_IMPLEMENT_GATE_FAILED_HEADING}\n${_messages().NOTE_IMPLEMENT_GATE_FAILED_INTRO}`;
  return body.length > 0 ? `${head}\n\n${body}` : head;
}


/**
 * The refusal `transition QUALITY_GATE -> REVIEW` raises with no usable
 * evidence (issue #327, Defect 3).
 *
 * It names the filing command that IS accepted at `QUALITY_GATE` and the retry,
 * so the operator is never told to do something the state machine rejects.
 */
export function formatGateEvidenceRequiredMessage(
  issue: number | string | null | undefined,
  gateRound: number,
  filedRound: number | null
): string {
  const filing = formatGateReportChannelCommand(issue);
  const retry = formatTransitionCommand(STAGE_REVIEW, issue);
  const reason =
    filedRound === null
      ? `no GATE_REPORT_JSON block was filed for gate round ${gateRound}, so there is nothing to certify`
      : `the filed GATE_REPORT_JSON block certifies gate round ${filedRound}, not gate round ${gateRound}, so there is nothing to certify this round`;
  const action =
    filedRound === null
      ? `File it with \`${filing}\``
      : `File this round's block with \`${filing}\``;

  return `Gate evidence refused: ${reason}. ${action}, then re-run \`${retry}\`. Nothing was written.`;
}


/** Which side of the evidence channel is refusing. */
export type GateCoverageChannel = 'filing' | 'ingest';
export const GATE_COVERAGE_FILING_REFILE = 're-file the block' as const;
export const GATE_COVERAGE_INGEST_REFILE = 're-file a corrected block' as const;
export const GATE_COVERAGE_FILING_TAIL = 'Nothing was written.' as const;
export const GATE_COVERAGE_INGEST_TAIL =
  'The filed report was NOT consumed: it is still readable and the checkpoint is unchanged at QUALITY_GATE.' as const;


/**
 * The ingest tail (issue #408, D1): a refusal no longer consumes the filed
 * report, so the message must say the evidence survived. "Nothing was written"
 * would be false for the operator's most important artifact.
 */

export function formatGateTargetCoverageRefusal(
  missing: readonly string[],
  declaredCount: number,
  issue?: number | string | null,
  channel: GateCoverageChannel = 'filing'
): string {
  const rendered = (Array.isArray(missing) ? missing : [])
    .map((command) => `\`${command}\``)
    .join(', ');
  const ingest = channel === 'ingest';
  return _messages().MSG_GATE_EVIDENCE_COVERAGE_MISSING
    .replace('{missingCount}', String(Array.isArray(missing) ? missing.length : 0))
    .replace('{declaredCount}', String(declaredCount))
    .replace('{missing}', () => rendered)
    .replace('{refile}', ingest ? GATE_COVERAGE_INGEST_REFILE : GATE_COVERAGE_FILING_REFILE)
    .replace('{command}', formatGateReportChannelCommand(issue))
    .replace('{tail}', ingest ? GATE_COVERAGE_INGEST_TAIL : GATE_COVERAGE_FILING_TAIL);
}


/** Why a PASSED report's smoke evidence is refused (issue #444). */
export type GateSmokeCoverageReason =
  | 'not-assessed'
  | 'ok'
  | 'protocol-not-declared'
  | 'protocol-missing'
  | 'protocol-failed'
  | 'duplicate'
  | 'unknown'
  | 'missing'
  | 'skipped'
  | 'failed';


/** The input to the one smoke-coverage refusal renderer (issue #444). */
export interface GateSmokeCoverageRefusalParams {
  readonly reason: GateSmokeCoverageReason;
  readonly protocol: string | null;
  readonly declaredCount: number;
  readonly missing: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
  readonly unknown: readonly string[];
  readonly duplicate: readonly string[];
  readonly issue?: number | string | null;
  readonly channel?: GateCoverageChannel;
}


/** Why a `PASSED` report that ran tests cannot be certified (issue #415). */
export const GATE_TEST_EVIDENCE_GAP_ZERO = 'zero' as const;

export const GATE_TEST_EVIDENCE_GAP_UNMEASURED = 'unmeasured' as const;


export type GateTestEvidenceGap =
  | typeof GATE_TEST_EVIDENCE_GAP_ZERO
  | typeof GATE_TEST_EVIDENCE_GAP_UNMEASURED;


export function formatGateZeroTestRefusal(
  commands: readonly string[],
  issue?: number | string | null,
  channel: GateCoverageChannel = 'filing',
  gap: GateTestEvidenceGap = GATE_TEST_EVIDENCE_GAP_ZERO
): string {
  const rendered = (Array.isArray(commands) ? commands : [])
    .map((command) => `\`${command}\``)
    .join(', ');
  const ingest = channel === 'ingest';
  const template =
    gap === GATE_TEST_EVIDENCE_GAP_UNMEASURED
      ? _messages().MSG_GATE_PASSED_UNMEASURED_TESTS
      : _messages().MSG_GATE_PASSED_ZERO_TESTS;
  return template
    .replace('{commands}', () => rendered)
    .replace('{refile}', ingest ? GATE_COVERAGE_INGEST_REFILE : GATE_COVERAGE_FILING_REFILE)
    .replace('{command}', formatGateReportChannelCommand(issue))
    .replace('{tail}', ingest ? GATE_COVERAGE_INGEST_TAIL : GATE_COVERAGE_FILING_TAIL);
}


/**
 * The note a refused gate exit appends when the filed report SURVIVED it
 * (issue #408, D1).
 *
 * #327/AC-3 promised a refusal that writes nothing, but the consume-on-ingest
 * clear ran before the digest guard, so the checkpoint was byte-identical while
 * the evidence file was deleted. The report is now consumed only on the
 * committed path; the refusal says so, because the operator still needs it.
 */
export function formatGateReportPreservedNote(
  issue: number | string | null | undefined,
  gateRound: number
): string {
  const retry = formatTransitionCommand(STAGE_REVIEW, issue);
  return `The filed gate report for round ${gateRound} was NOT consumed: it is still filed and readable, so restore the approved plan and re-run \`${retry}\` to certify with the same block.`;
}


/**
 * The note a QUALITY_GATE exit appends when the checkpoint COMMIT failed, so the
 * filed report was never consumed (issue #410).
 *
 * #408 moved the consume-on-ingest clear onto the committed path but left it
 * BEFORE `stateRepo.save`. A save that throws therefore deleted the evidence
 * while the checkpoint stayed at QUALITY_GATE — the same D1 symptom on the one
 * remaining refusal path. The clear now runs only after a successful commit;
 * this note says so, because the operator's next move is to repair the write
 * and retry with the SAME block (a gate subagent that already returned cannot
 * be asked to file again).
 */
export function formatGateReportSaveFaultNote(
  issue: number | string | null | undefined,
  gateRound: number
): string {
  const retry = formatTransitionCommand(STAGE_REVIEW, issue);
  return `The filed gate report for round ${gateRound} was NOT consumed: the checkpoint save failed, so the report is still filed and readable. Repair the checkpoint write and re-run \`${retry}\` to certify with the same block.`;
}



/**
 * The operator-facing source of an INLINE reviewer verdict.
 *
 * The verdict-file source is the path itself; the stdin source is
 * `VERDICT_INPUT_SOURCE_STDIN`.
 */
export const VERDICT_INPUT_SOURCE_STDIN = 'stdin' as const;
