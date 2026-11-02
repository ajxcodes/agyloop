/**
 * agyloop - CritiqueProvenance Value Objects (Domain Layer)
 *
 * Issue #445: a Tier 1 critique report is evidence only when the tool can tell
 * WHICH change set produced it. The Tier 1 command publishes a
 * `<report>.provenance.json` sidecar naming the base ref and HEAD it read, and
 * `codeloop review` certifies the report only when the sidecar matches this
 * review's base and HEAD.
 *
 * Strict Hexagonal Boundary: zero I/O, zero external dependencies — parsing a
 * sidecar's raw text and comparing two values are pure operations.
 */

/** What the Tier 1 command recorded when it produced a report (issue #445). */
export interface CritiqueProvenance {
  readonly baseRef: string;
  readonly headCommit: string;
}

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Parses a provenance sidecar's raw JSON text.
 *
 * Anything that is not a JSON object carrying a non-empty `baseRef` AND a
 * full/short commit sha in `headCommit` is `null` — never a partial record, so a
 * truncated or hand-written sidecar can never bind a report by accident.
 */
export function parseCritiqueProvenance(raw: string | null | undefined): CritiqueProvenance | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object') return null;
    const baseRef = typeof payload.baseRef === 'string' ? payload.baseRef.trim() : '';
    const headCommit = typeof payload.headCommit === 'string' ? payload.headCommit.trim() : '';
    if (baseRef.length === 0 || !COMMIT_SHA.test(headCommit)) return null;
    return Object.freeze({ baseRef, headCommit });
  } catch {
    return null;
  }
}

/**
 * True only when the report's provenance names the base and HEAD this review
 * certifies (issue #445, AC2). An unmeasured HEAD can never bind.
 */
export function isCritiqueProvenanceBound(
  provenance: CritiqueProvenance | null | undefined,
  reviewedBaseRef: string,
  reviewedHeadCommit: string | null
): boolean {
  if (!provenance || !reviewedHeadCommit) return false;
  return (
    provenance.baseRef.trim() === reviewedBaseRef.trim() &&
    provenance.headCommit.toLowerCase() === reviewedHeadCommit.trim().toLowerCase()
  );
}
