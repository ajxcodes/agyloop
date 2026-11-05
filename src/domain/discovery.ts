/* eslint-disable @typescript-eslint/no-unused-vars */
import type { StageFinding } from './value-objects/workspace-mutation';
import { ROOT_BUILD_PROHIBITION_SENTENCE, withRecordedPauseHint } from './vocabulary';
import { REGEX_MD_POINTER_ONLY_VALUE } from './regexes';
import { NOTE_DISCOVERY_PARK_AWAITING_RCA, NOTE_DISCOVERY_PARK_KIND_MISMATCH } from './messages';
import { COMMAND_PLAN } from './cli-contract';


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


/**
 * The minimum cleaned character count of ONE content unit — a `##` section's
 * prose body, or a filled key bullet's value.
 *
 * Why 20: it separates a real statement from a stub. Measured over this
 * repository (issue #306 §2.5), the largest RESTATED value (a bullet that only
 * repeats its own heading, e.g. `- **Root Cause Analysis:** Root Cause Analysis`)
 * is 19 characters, and every key value in a genuine report is longer. The
 * pristine scaffold and a cosmetic `see above` skeleton score zero units either
 * way — and a long pointer (`see the … section above for details`) is excluded
 * by `REGEX_MD_POINTER_ONLY_VALUE`, not by length.
 */
export const DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS = 20;


/**
 * The minimum number of content units — substantive sections plus substantive
 * key values — a report must carry to release the DISCOVERY park.
 *
 * Why 3: the smallest genuine report in the calibration corpus (the #284 core,
 * 3,424 chars) has exactly 3 content-bearing units. Any higher value
 * re-introduces the false negative on the issue's own evidence; any lower one
 * admits a four-empty-heading scaffold.
 */
export const DISCOVERY_REPORT_MIN_CONTENT_UNITS = 3;


/**
 * The minimum total substantive characters across all content units.
 *
 * Why 150: the separation measured in issue #306 §2.5 is large — the largest
 * REJECTED document carries 41 content characters, the smallest ACCEPTED
 * fixture 193. 150 sits inside that gap with headroom on both sides.
 */
export const DISCOVERY_REPORT_MIN_CONTENT_CHARS = 150;


/**
 * How many `##`+ sections must carry substantive prose before the document
 * counts as heading-shaped evidence.
 *
 * Why 2: the prompt's Expected Output Structure names four topics, and a real
 * report fills the analysis. Requiring two keeps a report that lost one section
 * (or merged two) accepted, while a document with a single populated heading
 * and nothing else is still treated as a citation-free stub.
 */
export const DISCOVERY_REPORT_MIN_PROSE_SECTIONS = 2;


/**
 * How many names `DiscoveryReport.describeMissingEvidence` spells out per
 * category before collapsing the rest into `+N more`.
 *
 * Why 4: the pristine scaffold leaves ten template keys blank, and naming all
 * of them made the park longer than the operator's terminal while burying the
 * actionable tail of the message.
 */
export const DISCOVERY_REPORT_MAX_MISSING_NAMES = 4;


/**
 * The one contract the discovery prompt and the DISCOVERY predicate share
 * (issue #306, AC4).
 *
 * Numbers are INTERPOLATED from the thresholds above rather than restated, so
 * the prompt a subagent reads and the rule `DiscoveryReport.isPopulated`
 * applies cannot drift apart. `buildDiscoveryTaskPrompt` appends this verbatim.
 *
 * The text must publish EVERY rule the predicate applies — the document-length
 * floor and the blank-key cap included. Leaving them out made a report that
 * satisfied every published number still park (issue #306 review, AC4).
 */
export function formatDiscoveryReportContract(): string {
  return (
    'The DISCOVERY gate scores CONTENT, not markdown shape. Either complete the scaffold\'s\n' +
    '`- **Key:**` bullets, or write the sections as `##` headings with substantive prose.\n' +
    `Accepted when the report is at least ${DISCOVERY_REPORT_MIN_CHARS} characters long and carries at least\n` +
    `${DISCOVERY_REPORT_MIN_CONTENT_UNITS} content-bearing sections or key values (each with ${DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS}+ characters),\n` +
    `totalling at least ${DISCOVERY_REPORT_MIN_CONTENT_CHARS} substantive characters. Shape evidence is either\n` +
    `${DISCOVERY_REPORT_MIN_PROSE_SECTIONS}+ substantive \`##\` sections or ${DISCOVERY_REPORT_MIN_FILLED_KEYS}+ filled key values; a bullet-only report may\n` +
    `leave at most ${DISCOVERY_REPORT_MAX_UNFILLED_KEYS} template keys blank, while a report with ${DISCOVERY_REPORT_MIN_PROSE_SECTIONS}+ substantive prose\n` +
    'sections is not vetoed for retaining copied blank keys. Pointers ("see above", "n/a",\n' +
    'TODO) and headings restated as their own values are not content. An untouched template,\n' +
    'or headings with no prose under them, is parked — and the park lists the sections without\n' +
    'substantive prose and any blank keys.'
  );
}


/**
 * The measured gaps of a parked discovery report (issue #306, AC3).
 *
 * Pure data: `DiscoveryReport` supplies the measurements, this module owns the
 * user-facing wording, so the value object stays a predicate and the operator
 * message can change without touching the gate. Also keeps the predicate and
 * its diagnostic reading the same facts.
 */
export interface DiscoveryMissingEvidence {
  readonly markdownChars: number;
  readonly contentUnitCount: number;
  readonly contentCharCount: number;
  /** True when the report has an accepted shape (prose sections or bounded keys). */
  readonly hasShapeEvidence: boolean;
  readonly blankKeys: readonly string[];
  /** Headings whose body does not clear the substantive-prose floor. */
  readonly sectionsWithoutSubstantiveProse: readonly string[];
}


/**
 * Renders the measured gaps of a parked discovery report for the operator.
 *
 * One clause per FAILING condition only — a populated report never reaches this
 * formatter, and an unmeasured one produces `''` rather than a guessed message.
 * The wording lives here (beside `formatDiscoveryParkAwaitingRca`) so the domain
 * value object does not carry presentation strings.
 */
export function formatDiscoveryMissingEvidence(evidence: DiscoveryMissingEvidence): string {
  const clauses: string[] = [];

  if (evidence.markdownChars < DISCOVERY_REPORT_MIN_CHARS) {
    clauses.push(`${evidence.markdownChars} of ${DISCOVERY_REPORT_MIN_CHARS} characters in the report`);
  }

  if (evidence.contentUnitCount < DISCOVERY_REPORT_MIN_CONTENT_UNITS) {
    clauses.push(
      `${evidence.contentUnitCount} of ${DISCOVERY_REPORT_MIN_CONTENT_UNITS} content-bearing sections or key values`
    );
  }

  if (evidence.contentCharCount < DISCOVERY_REPORT_MIN_CONTENT_CHARS) {
    clauses.push(`${evidence.contentCharCount} of ${DISCOVERY_REPORT_MIN_CONTENT_CHARS} content characters`);
  }

  if (!evidence.hasShapeEvidence) {
    clauses.push(
      `no accepted shape: needs ${DISCOVERY_REPORT_MIN_PROSE_SECTIONS} substantive ## sections or ${DISCOVERY_REPORT_MIN_FILLED_KEYS} filled key values`
    );
  }

  if (evidence.blankKeys.length > DISCOVERY_REPORT_MAX_UNFILLED_KEYS) {
    clauses.push(
      `${evidence.blankKeys.length} blank template keys (max ${DISCOVERY_REPORT_MAX_UNFILLED_KEYS}): ${summariseEvidenceNames(evidence.blankKeys)}`
    );
  }

  if (evidence.sectionsWithoutSubstantiveProse.length > 0) {
    clauses.push(
      `sections without substantive prose: ${summariseEvidenceNames(evidence.sectionsWithoutSubstantiveProse, '"')}`
    );
  }

  return clauses.join('; ');
}
function summariseEvidenceNames(names: readonly string[], quote = ''): string {
  const shown = names
    .slice(0, DISCOVERY_REPORT_MAX_MISSING_NAMES)
    .map((name) => `${quote}${name}${quote}`);
  const extra = names.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}


/**
 * Joins at most `DISCOVERY_REPORT_MAX_MISSING_NAMES` names, then `+N more`.
 *
 * A pristine scaffold blanks ten keys; naming all of them buried the
 * actionable tail of the park message.
 */

// ---- DISCOVERY scoped-write boundary (issue #389) -------------------------
//
// The dispatch prompt used to state a container-only guardrail as a MANDATE and
// a scoped write as prose, and nothing read either. A host-run harness cannot
// satisfy "container-only" while also satisfying "reproduce the issue
// empirically", and a rebuild of the repository-root `dist/` is gitignored, so
// `git status` could not see it. These constants own the one source of truth:
// a MUTATION boundary (reads are free, writes stay in the plan directory), an
// explicit container recipe for a subagent that chooses containment, and the
// finding wording the orchestrator reads back.

/** The image the discovery recipe names, so a subagent never invents one. */
export const DISCOVERY_CONTAINER_IMAGE = 'docker.io/library/node:24-bookworm-slim';


/** The template heading a discovery report must actually carry (AC1c). */
export const DISCOVERY_REPRODUCTION_HEADING = '## 3. Reproduction Steps & Verification Protocol';


/** The one key inside that heading the directive names. */
export const DISCOVERY_REPRODUCTION_KEY = '- **Local Reproduction Command:**';


/**
 * Renders the DISCOVERY mutation boundary (issue #402, D3).
 *
 * ONE renderer for both DISCOVERY branches: host reads are free, every write
 * stays inside the plan directory, and the root build is never rebuilt —
 * because the root build is the tool executing the pipeline.
 */
export function formatDiscoveryMutationBoundary(planDir: string): string {
  return (
    `You may read anything and run read-only host commands, but every WRITE must land inside \`${planDir}\`. ` +
    `Never create, edit or delete a file outside it. ${ROOT_BUILD_PROHIBITION_SENTENCE}`
  );
}


/**
 * Directives 2 and 3 for the container-available DISCOVERY branch (issue #389).
 *
 * The boundary is the invariant; containment is an OFFER with a runnable
 * command, because the evidence contract ("reproduce the issue empirically")
 * legitimately needs a build. `runtime` is interpolated so the recipe names the
 * runtime the detector actually found.
 */
export function formatDiscoveryExecutionContract(params: {
  readonly runtime: string;
  readonly planDir: string;
}): string {
  const runtime = params.runtime;
  const planDir = params.planDir;
  const inspect =
    `${runtime} run --rm --network=none -v "$PWD":/repo:ro -w /repo ` +
    `${DISCOVERY_CONTAINER_IMAGE} bash -lc '<read-only command>'`;
  const build =
    `${runtime} run --rm -v "$PWD":/repo:ro -w /tmp ` +
    `${DISCOVERY_CONTAINER_IMAGE} bash -lc 'cp -a /repo /tmp/w && cd /tmp/w && npm ci && npm run build'`;
  return (
    `2. **Mutation Boundary**: ${formatDiscoveryMutationBoundary(planDir)}\n` +
    `3. **Container-Preferred Empirical Verification**: Empirical reproduction often needs a build; run it in a container when the runtime is reachable. Use ${runtime}:\n` +
    `   - Inspect (read-only mount): \`${inspect}\`\n` +
    `   - Build (copy out of the read-only mount): \`${build}\`\n` +
    `   If the runtime is unreachable when you run it, fall back to host reads plus static RCA and record why in the report.`
  );
}


/**
 * Directives 2 and 3 for the container-unavailable DISCOVERY branch (#295/#389).
 *
 * The #295 fallback sentence stays VERBATIM (it is asserted in two suites), and
 * the mutation boundary follows it so a host without a container runtime is
 * still told that every write stays in the plan directory and the root build is
 * never rebuilt (issue #402, Defect 3).
 */
export function formatDiscoveryFallbackContract(params: {
  readonly planDir: string;
}): string {
  return (
    `2. **Empirical Verification Fallback**: Container runtime/daemon is unavailable. Skip empirical smoke execution and fall back cleanly to static RCA code tracing. Log an informative warning regarding container unavailability.\n` +
    `3. **Mutation Boundary**: ${formatDiscoveryMutationBoundary(params.planDir)}`
  );
}


/**
 * Renders measured boundary findings for a directive's description/summary.
 *
 * The installed-CLI consequence is appended only when a ROOT BUILD changed:
 * that is the failure mode the guardrail exists to prevent (#389), and saying
 * it on an unrelated `artifacts/` change would be noise.
 */
export function formatDiscoveryBoundaryFindings(findings: readonly StageFinding[]): string {
  if (findings.length === 0) {
    return '';
  }
  const listed = findings.map((finding) => `${finding.path} (${finding.detail})`).join('; ');
  const rootBuildChanged = findings.some(
    (finding) =>
      finding.path === 'dist/' ||
      finding.path === 'build/' ||
      finding.path === 'dist' ||
      finding.path === 'build'
  );
  const consequence = rootBuildChanged
    ? ' The root build is what the installed `codeloop` executes; a rebuild mid-run changes the pipeline\'s own tool.'
    : '';
  return `Discovery boundary findings: ${listed}.${consequence}`;
}


/** Renders the remediation wording of the tracked-write human gate (#389, AC3b). */
export function formatDiscoveryBoundaryGate(findings: readonly StageFinding[]): string {
  const listed = findings.map((finding) => `${finding.path} (${finding.detail})`).join('; ');
  return (
    `A DISCOVERY stage wrote outside its plan directory: ${listed}. ` +
    'Discovery may read anything but may only write inside its plan directory; ' +
    'a new tracked write can corrupt every downstream gate, so the run is paused. ' +
    'Revert the change (or move it into the plan directory), then run `codeloop next` again.'
  );
}


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


/**
 * Appends the missing evidence and the checked paths to the DISCOVERY park
 * message (issues #283, #306).
 *
 * Kept as a formatter rather than a second constant so the base note stays the
 * exact fallback when nothing is known (a dry run, a checkpoint with no
 * directory) — and so a parked operator is told WHICH file was read and WHAT
 * the predicate found missing, instead of being told a populated report is "an
 * unpopulated scaffold".
 *
 * With no arguments it returns `NOTE_DISCOVERY_PARK_AWAITING_RCA` unchanged.
 *
 * `pausedAtGate` (issue #315, AC-9) is the checkpoint's recorded pause, if any:
 * the resume hint is appended only when a pause really exists, because a park
 * with `pausedAtGate: null` cannot be resumed and `next --json` reports
 * `pause: null` there.
 *
 * `kindRejection` (#339, item 3): when present the BASE NOTE is the kind
 * headline naming the first line the gate found, not the generic "does not yet
 * contain RCA evidence" — a title-rejected report has fine content, so the
 * content claim would be false. The missing-evidence breakdown is still appended
 * when a content gap was ALSO measured (a mixed rejection), so the two reasons
 * stay distinguishable and neither is hidden.
 */
export function formatDiscoveryParkAwaitingRca(
  checkedPaths?: string | null,
  missingEvidence?: string | null,
  evaluatedPath?: string | null,
  pausedAtGate?: string | null,
  kindRejection?: { readonly path: string; readonly firstLine: string } | null
): string {
  const baseNote = kindRejection
    ? NOTE_DISCOVERY_PARK_KIND_MISMATCH.replace('{firstLine}', kindRejection.firstLine)
    : NOTE_DISCOVERY_PARK_AWAITING_RCA;
  const parts: string[] = [withRecordedPauseHint(baseNote, pausedAtGate)];

  const missing = (missingEvidence ?? '').trim();
  if (missing.length > 0) {
    const where = (evaluatedPath ?? '').trim();
    parts.push(
      where.length > 0 ? `Missing evidence in ${where}: ${missing}.` : `Missing evidence: ${missing}.`
    );
  }

  const checked = (checkedPaths ?? '').trim();
  if (checked.length > 0) {
    parts.push(`Checked: ${checked}.`);
  }

  return parts.join(' ');
}
