/**
 * agyloop - Issue Kind Value Object (Domain Layer)
 *
 * The single definition of "is this issue a bug or a feature?" (issue #379).
 *
 * Why this module exists: the plan entry stage has to be chosen from the issue
 * kind BEFORE any artifact is scaffolded. Before #379 the question was answered
 * inline in `StartPlanningUseCase` and, with a slightly different rule, again in
 * `FilePlanGenerator.detectPlanType`. The two copies drifted, and the entry
 * point never consulted either when it decided whether DISCOVERY should run.
 *
 * Rules (normative):
 *  1. Labels are normalised with `trim().toLowerCase()`.
 *  2. A label is a bug label only when it EQUALS `bug`/`defect` or matches the
 *     `type: bug` / `kind/bug` prefix form. This is deliberately exact: a
 *     substring rule classified `not-a-bug` and `fixed-in:2.0` as bugs.
 *  3. A bug label wins outright, whatever the title says.
 *  4. Otherwise a title still selects a bug only when it carries an actual
 *     MARKER (#382, D4):
 *       DELIMITED  `[bug]`, `fix:`, `rca/` … — the historical pre-#379
 *                  `FilePlanGenerator.detectPlanType` predicate, verbatim; or
 *       STRONG_LEAD a bug-only imperative at position 0 (`crash on login`,
 *                  `fixing the loop`).
 *     Ordinary English (`Improve error handling`, `Add a bug reporting
 *     dashboard`, `Reduce regression test flakiness`) is NOT a marker. #379
 *     widened the title rule to any word-start keyword; that widening discarded
 *     the label lookup the same issue added, so it is narrowed here.
 *  5. When labels were read and none was a bug, the kind is `feature`/`label`
 *     unless the title carries a marker (marker-over-label precedence, IK-5).
 *
 * Purity note: this module has NO imports at all. It never throws, never reads
 * I/O, and freezes both its tables and the object it returns.
 */

/** The two kinds that select a plan entry stage (issue #379). */
export type IssueKind = 'bug' | 'feature';

/** Why the kind was chosen, recorded so the inference is auditable. */
export type IssueKindSource = 'label' | 'title' | 'none';

export interface IssueKindInput {
  readonly labels?: readonly string[] | null;
  readonly title?: string | null;
  /**
   * True only when an issue lookup was ATTEMPTED and failed (#382). An empty
   * label set and an unreadable label set must not be indistinguishable: the
   * former is a fact, the latter is an unknown.
   */
  readonly labelsUnavailable?: boolean;
}

export interface IssueKindResult {
  readonly kind: IssueKind;
  readonly source: IssueKindSource;
  /** Present only when true, so existing deepEqual pins keep their shape. */
  readonly labelsUnavailable?: true;
}

/** Exact bug labels. NOT substring matching: `not-a-bug` is not a bug label. */
export const BUG_LABELS: readonly string[] = Object.freeze(['bug', 'defect']);

/** `type: bug`, `type:bug`, `kind/bug`, `kind: defect` … */
export const BUG_LABEL_PREFIX_PATTERN = /^(?:type|kind)\s*[:/]\s*(?:bug|defect)$/;

/**
 * Title keywords for the HISTORICAL DELIMITED markers (`[bug]`, `fix:`,
 * `rca/`). The list is byte-identical to the pre-#379 `detectPlanType` table
 * and is NOT a free-floating word matcher: `error` here only matches as
 * `[error]`, `error:` or `error/` (#382, D4).
 */
export const BUG_TITLE_KEYWORDS: readonly string[] = Object.freeze([
  'bug',
  'defect',
  'fix',
  'rca',
  'root-cause',
  'regression',
  'crash',
  'error'
]);

/**
 * The only undelimited addition (#382, D4): a bug-only imperative ANCHORED at
 * index 0. This keeps `crash on login` and `fixing the loop` green while
 * `Error budget dashboard for SLOs` and `Improve error handling` stay features —
 * `error` is deliberately absent from the undelimited list.
 */
const STRONG_LEAD_BUG = /^\s*(?:crash(?:es|ed|ing)?|fix(?:es|ed|ing)?|regression|regressed)\b/;

/** True when one normalised label identifies a bug. */
function isBugLabel(label: unknown): boolean {
  const normalised = String(label ?? '')
    .trim()
    .toLowerCase();
  return BUG_LABELS.includes(normalised) || BUG_LABEL_PREFIX_PATTERN.test(normalised);
}

/**
 * The pre-#379 delimiter predicate, kept VERBATIM (substring-based, quirks
 * included: `prefix:` still matches `fix:`). It is the reference point the
 * two-direction mutation check compares against — do not "improve" it here.
 */
function matchesDelimitedMarker(titleLower: string, keyword: string): boolean {
  return (
    titleLower.includes(`[${keyword}]`) ||
    titleLower.includes(`${keyword}:`) ||
    titleLower.includes(`${keyword}/`)
  );
}

/** True when the title carries an actual bug marker (delimited or strong lead). */
export function hasBugTitleMarker(title?: string | null): boolean {
  const titleLower = String(title ?? '').toLowerCase();
  return (
    BUG_TITLE_KEYWORDS.some((keyword) => matchesDelimitedMarker(titleLower, keyword)) ||
    STRONG_LEAD_BUG.test(titleLower)
  );
}

/**
 * Detect the issue kind from its labels and title.
 *
 * Total function: no arguments, `null` labels, a non-string title and very
 * long input never throw. The returned object is frozen.
 */
export function detectIssueKind(input: IssueKindInput = {}): IssueKindResult {
  const labels = Array.isArray(input.labels) ? input.labels : [];
  const unavailable = input.labelsUnavailable === true;
  const withFlag = (base: IssueKindResult): IssueKindResult =>
    Object.freeze(unavailable ? { ...base, labelsUnavailable: true as const } : base);

  for (const label of labels) {
    if (isBugLabel(label)) return withFlag({ kind: 'bug', source: 'label' });
  }

  // Marker-over-label precedence (IK-5) is LIMITED to marker-shaped titles: an
  // ordinary English word in the title no longer overrides a non-bug label.
  if (hasBugTitleMarker(input.title)) return withFlag({ kind: 'bug', source: 'title' });
  if (labels.length > 0) return withFlag({ kind: 'feature', source: 'label' });
  return withFlag({ kind: 'feature', source: 'none' });
}
