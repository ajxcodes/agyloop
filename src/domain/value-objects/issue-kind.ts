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
 *  3. Only when no label matches, a title keyword still selects a bug. The
 *     historical delimited markers (`[bug]`, `fix:`, `rca/`) keep working, and
 *     a keyword at the start of any word also matches — so the plan's IK-4
 *     table recognises undelimited phrases such as `crash on login` and
 *     `fixing the loop`.
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
}

export interface IssueKindResult {
  readonly kind: IssueKind;
  readonly source: IssueKindSource;
}

/** Exact bug labels. NOT substring matching: `not-a-bug` is not a bug label. */
export const BUG_LABELS: readonly string[] = Object.freeze(['bug', 'defect']);

/** `type: bug`, `type:bug`, `kind/bug`, `kind: defect` … */
export const BUG_LABEL_PREFIX_PATTERN = /^(?:type|kind)\s*[:/]\s*(?:bug|defect)$/;

/**
 * Title keywords. They match the historical delimited markers (`[bug]`,
 * `fix:`, `rca/`) and any word that starts with the keyword — the IK-4 table
 * (issue #379) requires `crash on login` and `fixing the loop` to be bugs.
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

/** True when one normalised label identifies a bug. */
function isBugLabel(label: unknown): boolean {
  const normalised = String(label ?? '')
    .trim()
    .toLowerCase();
  return BUG_LABELS.includes(normalised) || BUG_LABEL_PREFIX_PATTERN.test(normalised);
}

/**
 * Detect the issue kind from its labels and title.
 *
 * Total function: no arguments, `null` labels, a non-string title and very
 * long input never throw. The returned object is frozen.
 */
export function detectIssueKind(input: IssueKindInput = {}): IssueKindResult {
  const labels = Array.isArray(input.labels) ? input.labels : [];

  for (const label of labels) {
    if (isBugLabel(label)) {
      return Object.freeze({ kind: 'bug', source: 'label' } as const);
    }
  }

  const titleLower = String(input.title ?? '').toLowerCase();
  // `(?:^|[^a-z0-9])` keeps the match on a word boundary at the START only:
  // `debug` does not contain the word `bug`, but `buggy` and `fixing` do start
  // with a keyword. This also subsumes the historical `[bug]`, `fix:` and
  // `rca/` markers, because their delimiter is a non-alphanumeric character.
  const titleMatch = BUG_TITLE_KEYWORDS.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}`).test(titleLower);
  });

  if (titleMatch) {
    return Object.freeze({ kind: 'bug', source: 'title' } as const);
  }

  return Object.freeze({ kind: 'feature', source: 'none' } as const);
}
