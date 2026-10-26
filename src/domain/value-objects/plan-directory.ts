/**
 * agyloop - Plan Directory Grammar (Domain Layer)
 *
 * The ONE slug/directory grammar shared by every producer of a plan directory
 * (issue #283): the scaffold (`scaffoldPlanDirectory`), the discovery dispatch
 * payload, and the resolver all derive the folder name from THIS module.
 *
 * Why this exists: the scaffold slugified the issue title with
 * `/[^a-z0-9]+/g` while the discovery subagent invented its own slug from the
 * same title (`base's` became `bases`, not `base-s`). Two directories were
 * created for ONE issue, the RCA gate read the empty one, and the operator had
 * to copy the report and delete a directory by hand.
 *
 * Purity note: this module has NO imports at all — no `node:path`, no `fs`, no
 * process access. The repository's architecture fitness test
 * (`tests/architecture/hexagonal-boundaries.test.ts`) forbids every external
 * import inside `src/domain`.
 */

/**
 * Lowercases and slugifies arbitrary text into the plan-directory component.
 *
 * This is the EXACT body of the historical `FilePlanGenerator.slugify`, moved
 * here so the two cannot diverge: that method now delegates to this function.
 *
 * @param text - The issue title (or any text to slugify).
 * @returns A lowercase, dash-separated slug; `''` for empty/non-string input.
 */
export function planSlug(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The canonical folder name for an issue's plan directory:
 * `<issue>-<slug>` (or `adhoc-<slug>` when no issue is known).
 *
 * @param issue - The issue number/string, or null/undefined for an ad-hoc run.
 * @param title - The issue title.
 */
export function planFolderName(
  issue: number | string | null | undefined,
  title: string
): string {
  const issuePart =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? 'adhoc'
      : String(issue);
  return `${issuePart}-${planSlug(title)}`;
}

/**
 * The directory-name prefix every candidate for `issue` starts with.
 *
 * @param issue - The issue number/string, or null/undefined for an ad-hoc run.
 */
export function planDirectoryPrefix(issue: number | string | null | undefined): string {
  const issuePart =
    issue === null || issue === undefined || String(issue).trim().length === 0
      ? 'adhoc'
      : String(issue);
  return `${issuePart}-`;
}
