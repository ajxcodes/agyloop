/**
 * agyloop - Plan Content Predicate (Domain Layer)
 *
 * ONE definition of "does this plan document carry anything an implementer
 * could execute?" — used by the YOLO implementation park (issue #259) so the
 * park never points an implementer directive at an EMPTY plan.
 *
 * Why this exists: `codeloop yolo` never dispatches the PLANNER either, so
 * the fast-path's plan is the tool's own blank scaffold
 * (`templates/implementation-plan.md`, every heading empty). Dispatching an
 * implementer with that document would hand it nothing to execute — a false
 * instruction. The park must therefore recognise the blank scaffold and tell
 * the operator what to do instead.
 *
 * Purity note: this module has NO imports at all — no `node:path`, no `fs`,
 * no process access. The repository's architecture fitness test
 * (`tests/architecture/hexagonal-boundaries.test.ts`) forbids every external
 * import inside `src/domain`.
 *
 * THE RULE (exactly as specified by the plan):
 * A line is a BODY line unless it is one of:
 *   1. empty / whitespace-only;
 *   2. a Markdown heading (`^\s*#{1,6}\s`);
 *   3. a horizontal rule (`^\s*([-*_])\1{2,}\s*$`);
 *   4. a header-metadata line — `^\s*\*\*(Issue|Date|Author|Status|Title):\*\*`;
 *   5. a task checkbox whose text is empty —
 *      `^\s*[-*]\s*\[[ xX]\]\s*(\*\*(Step\s+\d+):\*\*)?\s*$`;
 *   6. a labelled bullet whose value is empty —
 *      `^\s*[-*]\s*\*\*(.+?):\*\*\s*$`;
 *   7. a whole-line HTML comment (`^\s*<!--.*-->\s*$`) — the implementation
 *      template carries the baseline label contract as a comment, which is a
 *      structural hint, never executable content (issue #402).
 * The plan is SUBSTANTIVE iff at least one body line exists.
 *
 * Why the rule is fail-safe: "everything else is a body line" means a plan
 * written in ANY shape this classifier does not recognise — prose, tables,
 * plain bullets, numbered lists — is automatically substantive. A false
 * REFUSAL (parking a run that had a real plan) is therefore impossible for a
 * plan that carries content. The one shape the predicate can mistake for an
 * empty plan is a document consisting of nothing but headings and separators,
 * and such a document carries no executable content either.
 */

/** A Markdown heading: `#` … `######` followed by whitespace. */
const HEADING_PATTERN = /^\s*#{1,6}\s/;

/** A horizontal rule: `---`, `***`, `___` (three or more of the same char). */
const HORIZONTAL_RULE_PATTERN = /^\s*([-*_])\1{2,}\s*$/;

/** A header-metadata line: `**Issue:**`, `**Date:**`, `**Author:**`, … */
const HEADER_METADATA_PATTERN = /^\s*\*\*(Issue|Date|Author|Status|Title):\*\*/;

/**
 * A task checkbox whose text is empty. The `**Step N:**` marker alone carries
 * no content, so `- [ ] **Step 1:**` is not a body line — but
 * `- [ ] **Step 1:** Edit src/foo.ts` is.
 */
const EMPTY_CHECKBOX_PATTERN = /^\s*[-*]\s*\[[ xX]\]\s*(\*\*(Step\s+\d+):\*\*)?\s*$/;

/**
 * A labelled bullet whose value is empty: the label is present, the value is
 * not (`- **Feature Overview:**`). A labelled bullet WITH a value
 * (`- **Feature Overview:** Do the thing`) is a body line.
 */
const EMPTY_LABELLED_BULLET_PATTERN = /^\s*[-*]\s*\*\*(.+?):\*\*\s*$/;

/**
 * A whole-line HTML comment: a structural hint, not executable content. The
 * implementation template carries the baseline label contract this way so it
 * never arms the YOLO park (issue #402).
 */
const HTML_COMMENT_LINE_PATTERN = /^\s*<!--.*-->\s*$/;

/**
 * True when the line carries content an implementer could execute.
 *
 * @param line - A single line of the plan document.
 */
function isBodyLine(line: string): boolean {
  if (!line.trim()) {
    return false;
  }
  if (HEADING_PATTERN.test(line)) {
    return false;
  }
  if (HORIZONTAL_RULE_PATTERN.test(line)) {
    return false;
  }
  if (HEADER_METADATA_PATTERN.test(line)) {
    return false;
  }
  if (EMPTY_CHECKBOX_PATTERN.test(line)) {
    return false;
  }
  if (EMPTY_LABELLED_BULLET_PATTERN.test(line)) {
    return false;
  }
  if (HTML_COMMENT_LINE_PATTERN.test(line)) {
    return false;
  }
  return true;
}

/**
 * True when the plan document carries content an implementer could execute.
 *
 * @param planContent - The plan document (the tool's scaffold or a written plan).
 * @returns False for an empty document and for the tool's blank scaffold; true
 *          for any document that carries at least one body line.
 */
export function isPlanContentSubstantive(planContent: string): boolean {
  if (!planContent || typeof planContent !== 'string') {
    return false;
  }

  for (const rawLine of planContent.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (isBodyLine(line)) {
      return true;
    }
  }

  return false;
}
