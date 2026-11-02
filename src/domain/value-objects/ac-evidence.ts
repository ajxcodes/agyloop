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
import { isInCommitExcludedTree, isOutsideWorkspace, stripLineSuffix } from './plan-evidence-paths';

export interface AcEvidenceEntry {
  /** The criterion label as written, e.g. `AC1`. */
  readonly ac: string;
  readonly status: AcEvidenceStatus;
  /** Every backticked path cited for this criterion, in order. */
  readonly paths: readonly string[];
  /** Any trailing prose after the status/paths. */
  readonly note: string;
}

/** One line of a REPORTED block that could not be parsed (issue #435, D4). */
export interface AcEvidenceParseIssue {
  /** 1-based line number in the verdict text. */
  readonly line: number;
  /** The offending line, trimmed. */
  readonly text: string;
  readonly reason: string;
}

export interface AcEvidenceReport {
  /** False for a legacy verdict with no `AC_EVIDENCE:` block. */
  readonly reported: boolean;
  readonly entries: readonly AcEvidenceEntry[];
  /**
   * Every block line that did not parse (issue #435, D4). OMITTED when there is
   * nothing to report, so a clean parse keeps the pre-#435 shape exactly.
   */
  readonly issues?: readonly AcEvidenceParseIssue[];
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

/** The one item grammar the block accepts (issue #435, D4). */
const ITEM_PATTERN =
  /^[-*+]\s+([A-Za-z0-9][A-Za-z0-9._-]*)\s*:\s*([A-Za-z][A-Za-z-]*)(.*)$/;

const ITEM_GRAMMAR_REASON =
  'the item does not match the block grammar "- <AC id>: met|unverifiable|out-of-scope — `<path>`"';

const MARKER_STANDALONE_REASON =
  'the marker line must stand alone; put each evidence item on its own "- <AC id>: <status> — `<path>`" line';

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
 * Absent block = `reported: false`, so legacy verdicts keep working. A REPORTED
 * block that yields nothing parseable is no longer silent: every offending line
 * is recorded as an issue (issue #435, D4), so "present but unreadable" can
 * never collapse into "nothing to verify".
 */
export function parseAcEvidence(verdictText: string | null | undefined): AcEvidenceReport {
  if (!verdictText || typeof verdictText !== 'string') {
    return Object.freeze({ reported: false, entries: Object.freeze([]) });
  }

  const lines = verdictText.split('\n');
  const markerIndex = lines.findIndex((line) => line.trim().startsWith(AC_EVIDENCE_MARKER));
  if (markerIndex === -1) {
    return Object.freeze({ reported: false, entries: Object.freeze([]) });
  }

  const issues: AcEvidenceParseIssue[] = [];
  const markerLine = lines[markerIndex].trim();
  if (markerLine !== AC_EVIDENCE_MARKER) {
    // `AC_EVIDENCE: - AC1: …` used to be invisible: the marker never matched.
    issues.push({
      line: markerIndex + 1,
      text: markerLine,
      reason: MARKER_STANDALONE_REASON
    });
  }

  const entries: AcEvidenceEntry[] = [];
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) continue;
    // The block ends at the next top-level marker (`REVIEW_STATUS:`, `#…`, …).
    if (!line.startsWith('-') && !line.startsWith('*') && !line.startsWith('+')) break;

    const match = ITEM_PATTERN.exec(line);
    if (!match) {
      issues.push({ line: index + 1, text: line, reason: ITEM_GRAMMAR_REASON });
      continue;
    }
    const status = parseStatus(match[2].toLowerCase());
    if (!status) {
      issues.push({
        line: index + 1,
        text: line,
        reason: `"${match[2]}" is not a recognised status (expected met, unverifiable or out-of-scope)`
      });
      continue;
    }

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

  return Object.freeze({
    reported: true,
    entries: Object.freeze(entries),
    ...(issues.length > 0 ? { issues: Object.freeze(issues) } : {})
  });
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
    // Issue #435 (D3): a `path:line` / `path:start-end` citation is the form
    // every other surface teaches, so the suffix is stripped for comparison
    // only — a refusal still quotes the citation as the reviewer wrote it.
    const normalised = stripLineSuffix(path);
    if (isInCommitExcludedTree(normalised)) {
      unverifiable.push(path);
      continue;
    }
    if (isOutsideWorkspace(normalised, reviewCwd)) {
      unverifiable.push(path);
      continue;
    }
    if (changeSet.measured) {
      const present = changeSet.paths.some((candidate) => samePath(candidate, normalised));
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
      // Issue #435 (D3): the sweep must see through a `:162` citation suffix,
      // but the finding still names the path as written.
      if (!isInCommitExcludedTree(stripLineSuffix(path))) continue;
      const key = `${currentAc}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ac: currentAc, path });
    }
  }

  return Object.freeze(found);
}
