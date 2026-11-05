/**
 * codeloop - CritiqueProvenance Value Objects (Domain Layer)
 *
 * Issue #445: a Tier 1 critique report is evidence only when the tool can tell
 * WHICH change set produced it. The Tier 1 command publishes a
 * `<report>.provenance.json` sidecar naming the base ref and HEAD it read, and
 * `codeloop review` certifies the report only when the sidecar matches this
 * review's base and HEAD.
 *
 * Issue #452: base + HEAD alone are NOT sufficient. HEAD does not move during
 * REVIEW (the commit gate runs after the verdict), so an edit made after Tier 1
 * ran is invisible to a two-field sidecar and still certifies. The sidecar now
 * also carries the change-set digest — a worktree tree hash — and the review
 * compares it against the current tree.
 *
 * Strict Hexagonal Boundary: zero I/O, zero external dependencies — parsing a
 * sidecar's raw text and comparing values are pure operations.
 */

/** What the Tier 1 command recorded when it produced a report (issue #445). */
export interface CritiqueProvenance {
  readonly baseRef: string;
  readonly headCommit: string;
  /**
   * The worktree tree hash the report was produced against (issue #452).
   * `null` for a legacy two-field sidecar; such a report parses but can never
   * bind (`missing-digest`).
   */
  readonly changeSetDigest: string | null;
}

/** Why a supplied report could not be tied to the reviewed change set. */
export type CritiqueProvenanceMismatch =
  | 'no-sidecar'
  | 'base'
  | 'head'
  | 'missing-digest'
  | 'unmeasured-digest'
  | 'change-set';

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const TREE_SHA = /^[0-9a-f]{7,64}$/i;

/**
 * Parses a provenance sidecar's raw JSON text.
 *
 * Anything that is not a JSON object carrying a non-empty `baseRef` AND a
 * full/short commit sha in `headCommit` is `null` — never a partial record, so a
 * truncated or hand-written sidecar can never bind a report by accident.
 *
 * A valid base+HEAD with an absent or malformed `changeSetDigest` parses with
 * `changeSetDigest: null` (issue #452): the legacy sidecar is readable, but it
 * can never bind.
 */
export function parseCritiqueProvenance(raw: string | null | undefined): CritiqueProvenance | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object') return null;
    const baseRef = typeof payload.baseRef === 'string' ? payload.baseRef.trim() : '';
    const headCommit = typeof payload.headCommit === 'string' ? payload.headCommit.trim() : '';
    if (baseRef.length === 0 || !COMMIT_SHA.test(headCommit)) return null;
    const rawDigest = typeof payload.changeSetDigest === 'string' ? payload.changeSetDigest.trim() : '';
    const changeSetDigest = TREE_SHA.test(rawDigest) ? rawDigest.toLowerCase() : null;
    return Object.freeze({ baseRef, headCommit, changeSetDigest });
  } catch {
    return null;
  }
}

/**
 * The FIRST reason the report cannot certify this review, or `null` when it can
 * (issues #445, #452).
 *
 * Order is load-bearing: sidecar presence → base → HEAD (including "HEAD
 * unmeasurable") → digest present → current digest measurable → digest
 * equality. A missing sidecar is named as missing rather than folded into a
 * digest refusal.
 */
export function critiqueProvenanceMismatch(
  provenance: CritiqueProvenance | null | undefined,
  reviewedBaseRef: string,
  reviewedHeadCommit: string | null,
  reviewedChangeSetDigest: string | null
): CritiqueProvenanceMismatch | null {
  if (!provenance) return 'no-sidecar';
  if (provenance.baseRef.trim() !== reviewedBaseRef.trim()) return 'base';
  if (!reviewedHeadCommit) return 'head';
  if (provenance.headCommit.trim().toLowerCase() !== reviewedHeadCommit.trim().toLowerCase()) {
    return 'head';
  }
  if (!provenance.changeSetDigest) return 'missing-digest';
  if (!reviewedChangeSetDigest) return 'unmeasured-digest';
  if (
    provenance.changeSetDigest.trim().toLowerCase() !== reviewedChangeSetDigest.trim().toLowerCase()
  ) {
    return 'change-set';
  }
  return null;
}

/**
 * True only when the report's provenance names the base, HEAD and change-set
 * content this review certifies (issues #445, #452). An unmeasured HEAD or
 * digest can never bind.
 */
export function isCritiqueProvenanceBound(
  provenance: CritiqueProvenance | null | undefined,
  reviewedBaseRef: string,
  reviewedHeadCommit: string | null,
  reviewedChangeSetDigest: string | null
): boolean {
  return (
    critiqueProvenanceMismatch(
      provenance,
      reviewedBaseRef,
      reviewedHeadCommit,
      reviewedChangeSetDigest
    ) === null
  );
}
