/* eslint-disable @typescript-eslint/no-unused-vars */
import { STAGE_APPROVAL, STAGE_COMMIT, STAGE_IMPLEMENT, STAGE_PLAN, STAGE_QUALITY_GATE, STAGE_REVIEW, formatTransitionCommand } from './lifecycle-stages';
import { COMMAND_DEVIATION, COMMAND_PLAN, COMMAND_TRANSITION, FLAG_ACK, FLAG_DEVIATION_FILE, FLAG_DEVIATION_STDIN, FLAG_REASON } from './cli-contract';


export const PLAN_TARGET_HEADING_CANDIDATES: readonly string[] = Object.freeze([
  'Quality Gate Targets',
  'Quality Gate & Test Verification',
  'Automated Test Targets',
  'Build / Lint Commands'
]);


/** Plan integrity verdicts (issue #298). */
export const PLAN_INTEGRITY_VERIFIED = 'verified' as const;

export const PLAN_INTEGRITY_UNVERIFIED = 'unverified' as const;

export const PLAN_INTEGRITY_MISMATCH = 'mismatch' as const;

export const PLAN_INTEGRITY_MISSING = 'missing' as const;


export type PlanIntegrityStatus =
  | typeof PLAN_INTEGRITY_VERIFIED
  | typeof PLAN_INTEGRITY_UNVERIFIED
  | typeof PLAN_INTEGRITY_MISMATCH
  | typeof PLAN_INTEGRITY_MISSING;

export const PLAN_DEFAULT_SPECIFICATION_TITLE = 'Plan Specification' as const;

export const PLAN_DEFAULT_TITLE = 'Task Plan' as const;






export const PLAN_DEVIATION_REQUIRED_KEYS = Object.freeze([
  'planSection',
  'planLiteral',
  'implementedAssertion',
  'reason'
] as const);


/** One accepted prose spelling and the wire key it maps onto (issue #451). */
export interface PlanDeviationProseLabel {
  readonly label: string;
  readonly field: 'planSection' | 'planLiteral' | 'implementedAssertion' | 'reason' | 'files';
}


/** The prose labels the refusal message names, in message order (issue #451). */
export const PLAN_DEVIATION_PROSE_LABEL_ENTRIES = Object.freeze([
  { label: 'Plan section', field: 'planSection' },
  { label: 'Plan literal', field: 'planLiteral' },
  { label: 'Implemented', field: 'implementedAssertion' },
  { label: 'Reason', field: 'reason' }
] as const);


/** Additional prose spellings the parser accepts without advertising them. */
export const PLAN_DEVIATION_PROSE_LABEL_ALIASES = Object.freeze([
  { label: 'Implemented assertion', field: 'implementedAssertion' },
  { label: 'Files', field: 'files' }
] as const);
const PROSE_LABEL_QUOTES = PLAN_DEVIATION_PROSE_LABEL_ENTRIES.map(
  (entry) => `\`${entry.label}:\``
);



/**
 * The prose labels the parser also accepts (issue #451).
 *
 * Rendered from the same table the parser builds its regexes from, so the
 * refusal text cannot advertise a label the parser does not match.
 */
export const PLAN_DEVIATION_PROSE_LABELS = `${PROSE_LABEL_QUOTES.slice(0, -1).join(
  ', '
)} and ${PROSE_LABEL_QUOTES[PROSE_LABEL_QUOTES.length - 1]}`;

/** The ONE accepted-shape example every surface reproduces. */

export const PLAN_DEVIATION_EXAMPLE =
  'PLAN_DEVIATION:\n' +
  '{ "planSection": "<the plan section or Test Register row>",\n' +
  '  "planLiteral": "<the approved literal>",\n' +
  '  "implementedAssertion": "<the assertion actually written>",\n' +
  '  "reason": "<why the new literal is right>",\n' +
  '  "files": ["<path:line>"] }';


/** The commit/PR body heading for recorded deviations (issue #437, AC4). */
export const PLAN_DEVIATIONS_COMMIT_HEADER = 'Plan deviations (recorded):' as const;


/** Renders the recorded deviations as one commit/PR body section. */
export function formatPlanDeviationsForCommitBody(
  records: readonly PlanDeviationSummary[]
): string | null {
  if (records.length === 0) return null;
  const lines: string[] = [PLAN_DEVIATIONS_COMMIT_HEADER];
  for (const record of records) {
    lines.push(
      `- ${record.id} ${record.planSection}: plan said "${record.planLiteral}"; implemented "${record.implementedAssertion}"`
    );
  }
  return lines.join('\n');
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


/**
 * The LEGAL re-approval sequence a gate blocker prescribes (issue #327,
 * Defect 2).
 *
 * `QUALITY_GATE -> PLAN` is legal (the table was widened with this issue), and
 * `PLAN -> APPROVAL -> IMPLEMENT` is the fresh-approval hop that re-records the
 * plan digest — which is what makes an EDITED plan pass the immutability check
 * on the next gate exit. Naming only the first hop would leave the operator
 * stuck one step later.
 *
 * `planDir` is the checkpoint's recorded plan directory. `transition PLAN`
 * halts on `PreFlightHaltError` without one, so the prerequisite is prefixed
 * instead of printing a hop that cannot run.
 */
export function formatPlanReapprovalRecovery(
  issue?: number | string | null,
  planDir?: string | null
): string {
  const issueToken =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? '<n>'
      : String(issue);
  const hops = [
    formatTransitionCommand(STAGE_PLAN, issue),
    formatTransitionCommand(STAGE_APPROVAL, issue),
    formatTransitionCommand(STAGE_IMPLEMENT, issue)
  ].join(', then ');

  const hasPlanDir = (planDir ?? '').trim().length > 0;
  const prerequisite = hasPlanDir
    ? 're-run planning and approval: '
    : `\`codeloop ${COMMAND_PLAN} --issue ${issueToken} --plan-dir <dir>\` first (the checkpoint records no plan directory), then re-run planning and approval: `;

  return `${prerequisite}${hops} (the fresh-approval hop re-records the plan digest, so the edited plan stops failing the immutability check)`;
}


/**
 * The number of blank-plan parks after which the advisory reports a REPEAT
 * (issue #267, AC-A5). ONE definition shared by the lifecycle message chooser
 * and the CLI advisory so the two can never disagree about "attempt 2".
 */
export const PLAN_EMPTY_PARK_REPEAT_THRESHOLD = 2 as const;



// ---- Plan deviations and delivered-evidence contracts (issue #432) --------

/**
 * The implementer's machine-readable deviation channel.
 *
 * An approved plan literal that cannot be satisfied as written is a DEVIATION,
 * not a licence to change the assertion silently: the implementer emits one
 * `PLAN_DEVIATION:` block per changed literal and the orchestrator files it with
 * `codeloop deviation`. The checkpoint then carries the finding, so the gate and
 * the reviewer can both see it (issue #432, absorbing #433).
 */
export const PLAN_DEVIATION_MARKER = 'PLAN_DEVIATION:' as const;


/**
 * Stable rule ids for the deviation contract. Used by diagnostics and prompts;
 * never parsed as evidence.
 */
export const PLAN_DEVIATION_RULE_SILENT_OVERRIDE = 'silent-plan-override' as const;

export const PLAN_DEVIATION_RULE_FILING = 'plan-deviation-filing' as const;

export const PLAN_DEVIATION_RULE_ACK = 'plan-deviation-ack' as const;


/** The record shape the refusal formatters need, without a cycle. */
export interface PlanDeviationSummary {
  readonly id: string;
  readonly planSection: string;
  readonly planLiteral: string;
  readonly implementedAssertion: string;
}


/** One deviation, rendered as a single auditable line. */
export function formatPlanDeviationLine(record: PlanDeviationSummary): string {
  return `${record.id}: plan section "${record.planSection}" — planLiteral "${record.planLiteral}", implementedAssertion "${record.implementedAssertion}"`;
}


/** The legal exits are explicit: acknowledge, or send the plan back. */
export function formatPlanDeviationUnacknowledgedMessage(
  records: readonly PlanDeviationSummary[],
  issue?: number | string | null
): string {
  const issueToken =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? '<n>'
      : String(issue);
  const ids = records.map((record) => record.id).join(', ');
  const lines = records.map((record) => `  - ${formatPlanDeviationLine(record)}`).join('\n');
  const first = records[0]?.id ?? 'PD-1';
  return (
    `Plan deviation${records.length === 1 ? '' : 's'} ${ids} ${records.length === 1 ? 'is' : 'are'} unacknowledged, so this round cannot be certified.\n` +
    `${lines}\n` +
    `Either acknowledge it if the new literal is right: \`codeloop ${COMMAND_DEVIATION} --issue ${issueToken} ${FLAG_ACK} ${first} ${FLAG_REASON} "<why the new literal is right>"\`, ` +
    `or file the deviation now if it surfaced during review (filing is legal at ${STAGE_IMPLEMENT}, ${STAGE_QUALITY_GATE}, ${STAGE_REVIEW} and ${STAGE_COMMIT}), ` +
    `or route back to ${STAGE_IMPLEMENT} with \`codeloop ${COMMAND_TRANSITION} ${STAGE_IMPLEMENT} --issue ${issueToken}\`, file it there, and re-run the gate. ` +
    `\`codeloop ${COMMAND_TRANSITION} ${STAGE_PLAN} --issue ${issueToken}\` revises the plan and clears the records.`
  );
}


/** The implementer's filing note, addressed to the orchestrator. */
export function formatPlanDeviationChannelNote(issue?: number | string | null): string {
  const issueToken =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? '<n>'
      : String(issue);
  return (
    `Orchestrator: when the implementer emits a ${PLAN_DEVIATION_MARKER} block, file it with ` +
    `\`codeloop ${COMMAND_DEVIATION} --issue ${issueToken} ${FLAG_DEVIATION_FILE} <path>\` (or pipe it into ` +
    `\`codeloop ${COMMAND_DEVIATION} --issue ${issueToken} ${FLAG_DEVIATION_STDIN}\`) before advancing. ` +
    `\`codeloop ${COMMAND_TRANSITION} ${STAGE_REVIEW} --issue ${issueToken}\` refuses while a deviation is unacknowledged. ` +
    ` The accepted shape is:\n${PLAN_DEVIATION_EXAMPLE}`
  );
}
