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
 * `sliceBalancedObject` is a deliberate local copy of the slicer in
 * `gate-result-report.ts`, and inherits its single-quote limitation: the span
 * is quote-aware for `"` only, so a single-quoted JS string containing a brace
 * ends it early. Single-quoted strings INSIDE the object are converted by
 * `jsObjectLiteralToJson`; the limitation is the slice, and the fixtures this
 * module judges put a double-quoted object after the marker.
 */

import {
  GATE_REPORT_JSON_MARKER,
  GATE_REPORT_MARKER_PRODUCER,
  REGEX_GATE_REPORT_MARKER_REFUSAL
} from '../constants';
import { GateResultReport } from './gate-result-report';

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
 * Extracts the first balanced `{ … }` object starting at or after `from`.
 *
 * A local copy of the slicer in `gate-result-report.ts` so the span is known;
 * the original is not exported or changed. Quote-aware for `"` only, exactly
 * like the original: a single-quoted JS string containing a brace ends the span
 * early (see the module header).
 */
function sliceBalancedObject(
  raw: string,
  from: number
): { readonly text: string; readonly start: number; readonly end: number } | null {
  const start = raw.indexOf('{', from);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { text: raw.slice(start, index + 1), start, end: index + 1 };
      }
    }
  }
  return null;
}

function removeTrailingComma(out: string[]): void {
  let index = out.length - 1;
  while (index >= 0 && /\s/.test(out[index])) index -= 1;
  if (index >= 0 && out[index] === ',') {
    out.splice(index, 1);
  }
}

/** Decodes the content of a single-quoted JS string into its characters. */
function decodeSingleQuoted(raw: string): string | null {
  let decoded = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== '\\') {
      decoded += char;
      continue;
    }
    index += 1;
    if (index >= raw.length) return null;
    const escaped = raw[index];
    switch (escaped) {
      case 'n':
        decoded += '\n';
        break;
      case 't':
        decoded += '\t';
        break;
      case 'r':
        decoded += '\r';
        break;
      case 'b':
        decoded += '\b';
        break;
      case 'f':
        decoded += '\f';
        break;
      case 'v':
        decoded += '\v';
        break;
      case '0':
        decoded += '\0';
        break;
      case 'u': {
        const hex = raw.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      case 'x': {
        const hex = raw.slice(index + 1, index + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      default:
        // JS treats an unknown escape as the escaped character itself.
        decoded += escaped;
        break;
    }
  }
  return decoded;
}

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const NUMBER_TOKEN = /^-?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/;

/**
 * Converts the JS object-literal shape a `node -e '…JSON.stringify({ … })'`
 * fixture writes into JSON.
 *
 * Returns `null` for anything it cannot convert without guessing: template
 * literals, spread, comments, shorthand properties, and identifiers in value
 * position.
 */
export function jsObjectLiteralToJson(literal: string): string | null {
  const out: string[] = [];
  const stack: Array<{ readonly type: '{' | '['; expectKey: boolean }> = [];
  let index = 0;

  while (index < literal.length) {
    const char = literal[index];

    if (/\s/.test(char)) {
      out.push(char);
      index += 1;
      continue;
    }

    if (char === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < literal.length) {
        const current = literal[end];
        if (escaped) {
          escaped = false;
        } else if (current === '\\') {
          escaped = true;
        } else if (current === '"') {
          break;
        }
        end += 1;
      }
      if (end >= literal.length) return null;
      out.push(literal.slice(index, end + 1));
      index = end + 1;
      continue;
    }

    if (char === "'") {
      let end = index + 1;
      let escaped = false;
      while (end < literal.length) {
        const current = literal[end];
        if (escaped) {
          escaped = false;
        } else if (current === '\\') {
          escaped = true;
        } else if (current === "'") {
          break;
        }
        end += 1;
      }
      if (end >= literal.length) return null;
      const decoded = decodeSingleQuoted(literal.slice(index + 1, end));
      if (decoded === null) return null;
      out.push(JSON.stringify(decoded));
      index = end + 1;
      continue;
    }

    if (char === '`') return null;

    if (char === '/' && (literal[index + 1] === '/' || literal[index + 1] === '*')) {
      return null;
    }

    if (char === '.' && literal.startsWith('...', index)) return null;

    if (char === '{') {
      stack.push({ type: '{', expectKey: true });
      out.push(char);
      index += 1;
      continue;
    }

    if (char === '[') {
      stack.push({ type: '[', expectKey: false });
      out.push(char);
      index += 1;
      continue;
    }

    if (char === '}') {
      if (stack.length === 0 || stack[stack.length - 1].type !== '{') return null;
      removeTrailingComma(out);
      stack.pop();
      out.push(char);
      index += 1;
      continue;
    }

    if (char === ']') {
      if (stack.length === 0 || stack[stack.length - 1].type !== '[') return null;
      removeTrailingComma(out);
      stack.pop();
      out.push(char);
      index += 1;
      continue;
    }

    if (char === ',') {
      out.push(char);
      const top = stack[stack.length - 1];
      if (top && top.type === '{') top.expectKey = true;
      index += 1;
      continue;
    }

    if (char === ':') {
      out.push(char);
      const top = stack[stack.length - 1];
      if (top && top.type === '{') top.expectKey = false;
      index += 1;
      continue;
    }

    if (IDENTIFIER_START.test(char)) {
      let end = index + 1;
      while (end < literal.length && IDENTIFIER_PART.test(literal[end])) end += 1;
      const word = literal.slice(index, end);
      const top = stack[stack.length - 1];
      const atKeyPosition = top !== undefined && top.type === '{' && top.expectKey;

      if (atKeyPosition) {
        let lookahead = end;
        while (lookahead < literal.length && /\s/.test(literal[lookahead])) lookahead += 1;
        // A shorthand property has no `:`; never guess its meaning.
        if (literal[lookahead] !== ':') return null;
        out.push(JSON.stringify(word));
      } else if (word === 'true' || word === 'false' || word === 'null') {
        out.push(word);
      } else {
        return null;
      }
      index = end;
      continue;
    }

    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(literal[index + 1] ?? ''))) {
      const match = NUMBER_TOKEN.exec(literal.slice(index));
      if (!match) return null;
      const token = match[0];
      if (/^-?0[xX]/.test(token)) {
        out.push(String(Number(token)));
      } else {
        out.push(token);
      }
      index += token.length;
      continue;
    }

    return null;
  }

  if (stack.length !== 0) return null;
  return out.join('');
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
