/**
 * agyloop - AC evidence against the delivered change set (issue #432, AC5)
 *
 * The reviewer's verdict gains an `AC_EVIDENCE:` block naming, per criterion,
 * the paths that prove it. This module parses the block and classifies the
 * cited evidence against the delivered change set — the diff that actually
 * ships. An AC whose only evidence lives in a gitignored tree or outside the
 * worktree is UNVERIFIABLE, never `met`.
 *
 * Only paths offered INSIDE an `AC_EVIDENCE:` entry are evidence (issue #449).
 * Verdict prose is never swept: a report path the reviewer is required to name
 * is not a claim that an acceptance criterion is met.
 *
 * A backticked span is evidence only when it is path-shaped; a literal,
 * identifier, flag or command in backticks stays in the entry's note (issue
 * #464).
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
  /** Every backticked PATH-SHAPED citation for this criterion, in order. */
  readonly paths: readonly string[];
  /** Trailing prose after the status, including backticked literals that are not paths. */
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

/** Extensions that make a lone token path-shaped without a directory separator. */
const PATH_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'json', 'jsonc', 'json5', 'md', 'mdx', 'markdown',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'fsx',
  'php', 'pl', 'pm', 'lua', 'r', 'jl', 'ex', 'exs', 'erl', 'hrl',
  'clj', 'cljs', 'dart', 'groovy', 'gradle',
  'sql', 'graphql', 'gql', 'proto', 'thrift',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'xml', 'xsl', 'svg', 'txt', 'csv', 'tsv', 'log', 'lock', 'patch', 'diff'
]);

/** Extensionless files that are still paths when cited alone. */
const PATH_BASENAMES: ReadonlySet<string> = new Set([
  'Makefile', 'Dockerfile', 'Containerfile', 'Procfile', 'LICENSE', 'LICENCE',
  'NOTICE', 'Rakefile', 'Gemfile', 'Vagrantfile', 'Brewfile', 'GNUmakefile',
  '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.env',
  '.editorconfig', '.eslintrc', '.prettierrc'
]);

/** Characters that never appear in a repository-relative path citation.
 *  `[` is left unescaped inside the class on purpose: `eslint`'s
 *  `no-useless-escape` refuses `\[` here, and JS accepts it unescaped. */
const NON_PATH_CHARS = /[\s"'`$*?<>|(){}[\],;]/;

/**
 * True when a backticked span is a PATH CANDIDATE (issue #464).
 *
 * Only a path-shaped span is evidence: it has a directory separator, a known
 * source/config extension, or is a known extensionless file; it carries no
 * whitespace, quotes, expansion/glob characters, brackets or shell
 * punctuation; it does not start with `-`; and its only colon is a `:line` /
 * `:start-end` citation suffix (#435).
 */
function isPathShapedEvidence(span: string): boolean {
  const value = stripLineSuffix(String(span ?? '').trim());
  if (value.length === 0) return false;
  if (value.startsWith('-')) return false;
  if (NON_PATH_CHARS.test(value)) return false;
  if (value.includes(':')) return false;
  if (value.includes('/')) return true;
  if (PATH_BASENAMES.has(value)) return true;
  const dot = value.lastIndexOf('.');
  return dot > 0 && PATH_EXTENSIONS.has(value.slice(dot + 1).toLowerCase());
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
    // the em dash. Only a PATH-SHAPED span is evidence (issue #464); a literal,
    // identifier, flag or command in backticks stays in the note as prose.
    const rest = match[3];
    const paths: string[] = [];
    const noteSource = rest.replace(/`([^`]+)`/g, (whole: string, inner: string) => {
      const citation = inner.trim();
      if (!isPathShapedEvidence(citation)) return whole;
      paths.push(citation);
      return ' ';
    });
    const note = noteSource
      .replace(/\s+/g, ' ')
      .replace(/^[\s—:–,-]+/, '')
      .replace(/[\s—:–,-]+$/, '')
      .trim();
    entries.push(
      Object.freeze({
        ac: match[1].trim(),
        status,
        paths: Object.freeze(paths),
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
