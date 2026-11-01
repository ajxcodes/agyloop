/**
 * agyloop - AC evidence against the delivered change set (issue #432, AC5)
 *
 * The reviewer's verdict gains an `AC_EVIDENCE:` block naming, per criterion,
 * the paths that prove it. This module parses the block and classifies the
 * cited evidence against the delivered change set — the diff that actually
 * ships. An AC whose only evidence lives in a gitignored tree or outside the
 * worktree is UNVERIFIABLE, never `met`.
 *
 * Pure domain: no I/O. The measured change set is supplied by the caller.
 */

import {
  AC_EVIDENCE_MARKER,
  AC_EVIDENCE_STATUS_MET,
  AC_EVIDENCE_STATUS_OUT_OF_SCOPE,
  AC_EVIDENCE_STATUS_UNVERIFIABLE,
  type AcEvidenceStatus
} from '../constants';
import { isInCommitExcludedTree, isOutsideWorkspace } from './plan-evidence-paths';

export interface AcEvidenceEntry {
  /** The criterion label as written, e.g. `AC1`. */
  readonly ac: string;
  readonly status: AcEvidenceStatus;
  /** Every backticked path cited for this criterion, in order. */
  readonly paths: readonly string[];
  /** Any trailing prose after the status/paths. */
  readonly note: string;
}

export interface AcEvidenceReport {
  /** False for a legacy verdict with no `AC_EVIDENCE:` block. */
  readonly reported: boolean;
  readonly entries: readonly AcEvidenceEntry[];
}

export interface DeliveredChangeSetLike {
  readonly measured: boolean;
  readonly paths: readonly string[];
}

export interface AcEvidenceClassification {
  readonly ac: string;
  readonly status: AcEvidenceStatus;
  /** The paths that could not be verified (empty for a verified/out-of-scope AC). */
  readonly unverifiablePaths: readonly string[];
}

const NO_EVIDENCE_PATH = '(no path named)';

function parseStatus(token: string): AcEvidenceStatus | null {
  if (token === AC_EVIDENCE_STATUS_MET) return AC_EVIDENCE_STATUS_MET;
  if (token === AC_EVIDENCE_STATUS_UNVERIFIABLE) return AC_EVIDENCE_STATUS_UNVERIFIABLE;
  if (token === AC_EVIDENCE_STATUS_OUT_OF_SCOPE) return AC_EVIDENCE_STATUS_OUT_OF_SCOPE;
  return null;
}

function backticked(value: string): string[] {
  const found: string[] = [];
  const pattern = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    found.push(match[1].trim());
  }
  return found;
}

/**
 * Parses the reviewer's `AC_EVIDENCE:` block.
 *
 * Absent block = `reported: false`, so legacy verdicts keep working. A line
 * that does not name a recognised status is skipped rather than guessed.
 */
export function parseAcEvidence(verdictText: string | null | undefined): AcEvidenceReport {
  if (!verdictText || typeof verdictText !== 'string') {
    return Object.freeze({ reported: false, entries: Object.freeze([]) });
  }

  const lines = verdictText.split('\n');
  const markerIndex = lines.findIndex((line) => line.trim() === AC_EVIDENCE_MARKER);
  if (markerIndex === -1) {
    return Object.freeze({ reported: false, entries: Object.freeze([]) });
  }

  const entries: AcEvidenceEntry[] = [];
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    // The block ends at the next top-level marker (`REVIEW_STATUS:`, `#…`, …).
    if (!line.startsWith('-') && !line.startsWith('*')) break;

    const item = line.replace(/^[-*+]\s+/, '');
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*([A-Za-z-]+)(.*)$/.exec(item);
    if (!match) continue;
    const status = parseStatus(match[2].toLowerCase());
    if (!status) continue;

    // The grammar is `AC1: met — \`path\``, so the evidence paths live AFTER
    // the em dash. Take every backticked span on the line, then keep whatever
    // prose remains as the note.
    const rest = match[3];
    const note = rest
      .replace(/`[^`]+`/g, ' ')
      .replace(/^[\s—:–-]+/, '')
      .replace(/[\s—:–-]+$/, '')
      .trim();
    entries.push(
      Object.freeze({
        ac: match[1].trim(),
        status,
        paths: Object.freeze(backticked(rest)),
        note
      })
    );
  }

  return Object.freeze({ reported: true, entries: Object.freeze(entries) });
}

function samePath(a: string, b: string): boolean {
  const clean = (value: string) => value.replace(/^\.\//, '').replace(/\\/g, '/').trim();
  return clean(a) === clean(b);
}

/**
 * Classifies one reported AC against the delivered change set.
 *
 * - `met` + every cited path is in the set and inside the worktree → verified;
 * - `met` + an excluded/outside/unchanged path → unverifiable, naming it;
 * - `unverifiable` → unverifiable, naming the declared path (or a placeholder);
 * - `out-of-scope` → recorded as out-of-scope, never met.
 *
 * Commit-excluded and outside-worktree paths are unverifiable LEXICALLY: no
 * change set can ever contain them. Only "tracked file not in this diff" needs
 * the measured set.
 */
export function classifyAcEvidence(
  entry: AcEvidenceEntry,
  changeSet: DeliveredChangeSetLike,
  reviewCwd: string
): AcEvidenceClassification {
  if (entry.status === AC_EVIDENCE_STATUS_OUT_OF_SCOPE) {
    return { ac: entry.ac, status: AC_EVIDENCE_STATUS_OUT_OF_SCOPE, unverifiablePaths: [] };
  }

  if (entry.status === AC_EVIDENCE_STATUS_UNVERIFIABLE) {
    return {
      ac: entry.ac,
      status: AC_EVIDENCE_STATUS_UNVERIFIABLE,
      unverifiablePaths:
        entry.paths.length > 0 ? Object.freeze([...entry.paths]) : Object.freeze([NO_EVIDENCE_PATH])
    };
  }

  const unverifiable: string[] = [];
  for (const path of entry.paths) {
    if (isInCommitExcludedTree(path)) {
      unverifiable.push(path);
      continue;
    }
    if (isOutsideWorkspace(path, reviewCwd)) {
      unverifiable.push(path);
      continue;
    }
    if (changeSet.measured) {
      const present = changeSet.paths.some((candidate) => samePath(candidate, path));
      if (!present) {
        unverifiable.push(path);
      }
    }
  }

  if (unverifiable.length > 0) {
    return {
      ac: entry.ac,
      status: AC_EVIDENCE_STATUS_UNVERIFIABLE,
      unverifiablePaths: Object.freeze(unverifiable)
    };
  }

  if (entry.paths.length === 0 && changeSet.measured) {
    // `met` with no evidence at all is not a certification.
    return {
      ac: entry.ac,
      status: AC_EVIDENCE_STATUS_UNVERIFIABLE,
      unverifiablePaths: Object.freeze([NO_EVIDENCE_PATH])
    };
  }

  return { ac: entry.ac, status: AC_EVIDENCE_STATUS_MET, unverifiablePaths: [] };
}

/**
 * The #433 backstop: every backticked path ANYWHERE in the verdict text that
 * is commit-excluded is unverifiable evidence, attributed to the AC it appears
 * under (or `verdict`).
 *
 * This is what catches a Tier-2 sentence that cites a gitignored file outside
 * the AC_EVIDENCE block.
 */
export function findExcludedEvidenceInText(
  verdictText: string | null | undefined
): ReadonlyArray<{ readonly ac: string; readonly path: string }> {
  if (!verdictText || typeof verdictText !== 'string') return Object.freeze([]);

  const found: Array<{ ac: string; path: string }> = [];
  const seen = new Set<string>();
  let currentAc = 'verdict';

  for (const line of verdictText.split('\n')) {
    const acMatch = /^\s*[-*+]\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*:/.exec(line);
    if (acMatch) {
      currentAc = acMatch[1];
    } else if (/^\s*(?:REVIEW_STATUS|REVIEW_SUMMARY|UNFULFILLED_AC|REMEDIATION_GUIDANCE):/.test(line)) {
      currentAc = 'verdict';
    }

    for (const path of backticked(line)) {
      if (!isInCommitExcludedTree(path)) continue;
      const key = `${currentAc}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ac: currentAc, path });
    }
  }

  return Object.freeze(found);
}
