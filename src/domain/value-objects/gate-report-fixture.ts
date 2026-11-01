/**
 * agyloop - Gate-report fixture parser (issue #413)
 *
 * Pure, static readers for the `GATE_REPORT_JSON:` fixtures a smoke check
 * seeds, so `SmokeProtocol.fromPlan` can mirror the runtime contracts that
 * decide whether the check's own assertions are reachable:
 *
 * - `normaliseGateTests` rewrites a `testsStatus` whose declared total
 *   disagrees with the unique test total (`gate-report-fixture-contradiction`).
 * - `IssueNumber.inferFromPath` requires `.worktrees/<n>/`, so a
 *   `.worktrees/<n>-suffix` directory never arms the mismatch guard
 *   (`worktree-fixture-unmatched`).
 * - `GateResultReport.parseBlock` requires the `GATE_REPORT_JSON:` marker
 *   (`gate-report-marker-missing`).
 *
 * This module is a textual mirror of those contracts, never a re-derivation:
 * the fixture is parsed into a real `GateResultReport` and the real
 * `normaliseGateTests` decides contradiction. No I/O, no external imports.
 *
 * Comment rule: this module treats both `#` and `//` as comment prefixes, while
 * `SmokeProtocol`'s own `isCommentLine` knows only `#`. Plans routinely document
 * shell and JS snippets with `//`, and these readers decide whether an
 * ASSERTION is real, so the stricter list lives here rather than widening every
 * pre-existing smoke rule (which were written against `#` alone).
 *
 * `sliceBalancedObject` and `jsObjectLiteralToJson` are shared with
 * `gate-result-report.ts` in `json-block.ts` (issue #432). The slice inherits
 * the documented single-quote limitation: the span is quote-aware for `"`
 * only, so a single-quoted JS string containing a brace ends it early.
 */

import {
  GATE_REPORT_JSON_MARKER,
  GATE_REPORT_MARKER_PRODUCER,
  REGEX_GATE_REPORT_MARKER_REFUSAL
} from '../constants';
import { GateResultReport } from './gate-result-report';
import { jsObjectLiteralToJson, sliceBalancedObject } from './json-block';

/** Re-exported so every existing importer of this module keeps working. */
export { jsObjectLiteralToJson };

export interface GateReportFixtureSpan {
  readonly start: number;
  readonly end: number;
}

export interface ParsedGateReportFixture {
  readonly report: GateResultReport;
  /** 0-based offset of the `GATE_REPORT_JSON:` marker within the body. */
  readonly markerOffset: number;
  /** 0-based offsets of the balanced object literal. */
  readonly span: GateReportFixtureSpan;
}

const COMMENT_PREFIXES: readonly string[] = ['#', '//'];

/**
 * The same comment/blank-line rule `SmokeProtocol` uses, extended with `//`
 * so a plan that documents a marker or a fixture in a comment cannot satisfy
 * a rule with prose alone.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 || COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  );
}

/** True when `offset` sits on a comment line of `body`. */
function isCommentOffset(body: string, offset: number): boolean {
  const lineStart = body.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = body.indexOf('\n', offset);
  return isCommentLine(body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd));
}

/** 0-based line offset of a character offset within `body`. */
export function lineOffsetOf(body: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < offset && index < body.length; index++) {
    if (body[index] === '\n') line += 1;
  }
  return line;
}

/**
 * Finds every `GATE_REPORT_JSON:` fixture in a check body and parses the
 * balanced object that follows it. Unparseable or invalid fixtures are
 * skipped: a deliberately malformed fixture is a legitimate refusal test.
 */
export function parseGateReportFixtures(body: string): ParsedGateReportFixture[] {
  const fixtures: ParsedGateReportFixture[] = [];
  let searchFrom = 0;

  while (searchFrom < body.length) {
    const markerOffset = body.indexOf(GATE_REPORT_JSON_MARKER, searchFrom);
    if (markerOffset === -1) break;
    if (isCommentOffset(body, markerOffset)) {
      searchFrom = markerOffset + GATE_REPORT_JSON_MARKER.length;
      continue;
    }
    const sliced = sliceBalancedObject(body, markerOffset + GATE_REPORT_JSON_MARKER.length);
    if (sliced === null) {
      searchFrom = markerOffset + GATE_REPORT_JSON_MARKER.length;
      continue;
    }
    searchFrom = sliced.end;

    let decoded: unknown;
    try {
      decoded = JSON.parse(sliced.text);
    } catch {
      const normalised = jsObjectLiteralToJson(sliced.text);
      if (normalised === null) continue;
      try {
        decoded = JSON.parse(normalised);
      } catch {
        continue;
      }
    }

    let report: GateResultReport;
    try {
      report = GateResultReport.fromJSON(decoded);
    } catch {
      continue;
    }

    fixtures.push({
      report,
      markerOffset,
      span: { start: sliced.start, end: sliced.end }
    });
  }

  return fixtures;
}

/**
 * Replaces every character of the given spans with a space (newlines kept), so
 * an assertion search cannot match the fixture that declares the value.
 */
export function blankFixtureSpans(
  body: string,
  spans: readonly GateReportFixtureSpan[]
): string {
  // `split('')` yields UTF-16 code units, matching the string offsets the
  // parser records; `[...body]` would index by code point and shift the span
  // after an astral character.
  const chars = body.split('');
  for (const span of spans) {
    for (let index = span.start; index < span.end && index < chars.length; index++) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

/**
 * True when the body carries a literal `GATE_REPORT_JSON:` marker on a
 * non-comment line. A plan that documents the marker in prose must not satisfy
 * the rule the marker exists to arm.
 */
export function hasGateReportMarker(body: string): boolean {
  return body
    .split('\n')
    .some((line) => !isCommentLine(line) && line.includes(GATE_REPORT_JSON_MARKER));
}

/** The two halves of the message `validateWorktreeIssueMatch` prints. */
const WORKTREE_MISMATCH_TEXT = 'from inside worktree';
const WORKTREE_MISMATCH_GUARD_TEXT = 'Cannot save state for issue';

/**
 * True when the body asserts the worktree-mismatch message on a non-comment
 * line (issue #413 D2).
 *
 * Comment-aware for symmetry with `hasGateReportMarker`: a plan that documents
 * the guard beside a legitimate `.worktrees/<n>-suffix` orphan fixture must not
 * arm Rule B, or the lint refuses a valid plan.
 */
export function assertsWorktreeMismatch(body: string): boolean {
  return body
    .split('\n')
    .some(
      (line) =>
        !isCommentLine(line) &&
        (line.includes(WORKTREE_MISMATCH_TEXT) || line.includes(WORKTREE_MISMATCH_GUARD_TEXT))
    );
}

/**
 * True when the body builds its report through the tool's marker producer
 * (`formatGateReportExample`) on a non-comment line (issue #413 Rule C).
 *
 * The producer is the tool's own single source of a `GATE_REPORT_JSON:`
 * marker; a comment naming it must not satisfy the marker requirement.
 */
export function producesGateReportMarker(body: string): boolean {
  return body
    .split('\n')
    .some((line) => !isCommentLine(line) && line.includes(GATE_REPORT_MARKER_PRODUCER));
}

/**
 * True when the body asserts `parseBlock`'s missing-marker refusal on a
 * non-comment line (issue #413 Rule C).
 *
 * Such a check is a deliberate refusal test and is exempt from Rule C. Prose
 * naming the refusal is not: an explanatory `#`/`//` line must not disarm the
 * rule for a markerless fixture.
 */
export function assertsGateReportMarkerRefusal(body: string): boolean {
  return body
    .split('\n')
    .some((line) => !isCommentLine(line) && REGEX_GATE_REPORT_MARKER_REFUSAL.test(line));
}

/**
 * Every non-comment `.worktrees/<n>-suffix` literal in the body.
 *
 * Mirrors `IssueNumber.inferFromPath`'s `\.worktrees[/\\](\d+)(?:[/\\]|$)`:
 * a hyphen after the digits can never match, so the guard never fires.
 */
export function findUnmatchableWorktreeLiterals(
  body: string
): ReadonlyArray<{ readonly literal: string; readonly lineOffset: number }> {
  const pattern = /\.worktrees[/\\]\d+-[A-Za-z0-9._-]*/;
  const found: Array<{ literal: string; lineOffset: number }> = [];
  body.split('\n').forEach((line, lineOffset) => {
    if (isCommentLine(line)) return;
    const match = pattern.exec(line);
    if (match) {
      found.push({ literal: match[0], lineOffset });
    }
  });
  return found;
}

/** True when `text` ends in an unescaped backslash (a shell line continuation). */
function endsWithLineContinuation(text: string): boolean {
  const trimmed = text.replace(/\s+$/, '');
  let backslashes = 0;
  for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === '\\'; index--) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Joins physical lines ending in `\` into one logical line.
 *
 * A `gate-report` invocation is routinely split across a continuation
 * (`gate-report \` / `  --report-file …`), the shape both the #412 and #415
 * plans use; matching each physical line in isolation misses it.
 */
function logicalLines(body: string): ReadonlyArray<{
  readonly text: string;
  readonly lineOffset: number;
}> {
  const lines = body.split('\n');
  const logical: Array<{ text: string; lineOffset: number }> = [];
  let index = 0;

  while (index < lines.length) {
    const lineOffset = index;
    let text = lines[index];
    index += 1;
    if (!isCommentLine(text)) {
      while (endsWithLineContinuation(text) && index < lines.length) {
        text = `${text.replace(/\\\s*$/, '')} ${lines[index]}`;
        index += 1;
      }
    }
    logical.push({ text, lineOffset });
  }

  return logical;
}

/**
 * Non-comment logical lines that invoke `gate-report` as a command token with a
 * `--report-file` argument. Mirrors `GateResultReport.parseBlock`'s marker
 * requirement (issue #413 D3). Backslash continuations are joined first, so a
 * multi-line invocation is attributed to the line it starts on.
 */
export function gateReportReportFileLines(body: string): readonly number[] {
  const invocation = /(?:^|[\s;&|(])gate-report(?=\s|$)/;
  const reportFile = /--report-file(?:=|\s)/;
  const lines: number[] = [];
  for (const line of logicalLines(body)) {
    if (isCommentLine(line.text)) continue;
    if (!invocation.test(line.text) || !reportFile.test(line.text)) continue;
    lines.push(line.lineOffset);
  }
  return lines;
}
