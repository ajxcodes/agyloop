/**
 * agyloop - Plan Document Kind Discriminator (Domain Layer)
 *
 * Distinguishes a DISCOVERY (RCA) document from an IMPLEMENTATION (technical
 * specification) document by its TITLE LINE only.
 *
 * Why the title line and not the headings: a real implementation plan may
 * legitimately carry a "Root Cause Analysis" SECTION (this very issue's plan
 * does), so scanning for `Root Cause Analysis` would misclassify a valid spec.
 * The scaffold writes exactly one discriminator — `# [Discovery] - <title>` —
 * so the first non-empty line is the reliable signal (issue #299).
 *
 * Purity note: this module has NO imports at all.
 */

/** The title line every discovery-scaffold artifact starts with. */
const DISCOVERY_TITLE_PATTERN = /^#\s*\[Discovery\]\s*-/i;

/**
 * True when the markdown document is a DISCOVERY (RCA) artifact.
 *
 * @param markdown - The document text.
 * @returns False for empty input and for every document whose first
 *          non-empty line is not a `# [Discovery] - …` title.
 */
export function isDiscoveryPlanDocument(markdown: string): boolean {
  if (!markdown || typeof markdown !== 'string') {
    return false;
  }
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0) {
      continue;
    }
    return DISCOVERY_TITLE_PATTERN.test(line);
  }
  return false;
}
