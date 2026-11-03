/**
 * agyloop - Test Register contract (issue #432, AC3)
 *
 * The approved plan's Test Register pins each assertion to a real test or
 * declares a brand-new one. This module is the STATIC reader: it parses the
 * register, extracts the pinned test block, normalises assertions and finds a
 * contradiction between a row's literal and the test it pins.
 *
 * Deliberate limit (stated in the planner prompt): scenario equivalence is not
 * decidable statically. Only a literal the row and the pinned test both
 * declare — with the same subject and a different expected value — is a
 * contradiction. Pure domain: no I/O.
 */

import { HEADING_TEST_REGISTER, REGEX_MD_HEADING_NUMBERING } from '../constants';

export interface TestRegisterReference {
  readonly path: string;
  readonly title: string;
}

export interface TestRegisterRow {
  /** The bold id, e.g. `TR-1`. */
  readonly id: string;
  readonly pins: TestRegisterReference | null;
  readonly newTest: TestRegisterReference | null;
  /** Raw `Asserts:` literals, in plan order. */
  readonly asserts: readonly string[];
  /** 1-based plan line of the row bullet. */
  readonly line: number;
}

export interface NormalisedAssertion {
  readonly subject: string;
  readonly operator: '===';
  readonly expected: string;
}

export interface TestRegisterContradiction {
  readonly subject: string;
  readonly rowValue: string;
  readonly pinnedValue: string;
  /** 1-based line of the pinned assertion inside the pinned file. */
  readonly line: number;
}

/** A heading line: level and text (numbering stripped). */
interface HeadingLine {
  readonly level: number;
  readonly text: string;
}

function parseHeading(line: string): HeadingLine | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
  if (!match) return null;
  return {
    level: match[1].length,
    text: match[2].replace(REGEX_MD_HEADING_NUMBERING, '').trim()
  };
}

function isFence(line: string): boolean {
  return line.trim().startsWith('```');
}

/** A Test Register section: its heading line and every body line. */
interface RegisterSection {
  /** 1-based plan line of the `Test Register` heading. */
  readonly headingLine: number;
  readonly lines: ReadonlyArray<{ text: string; line: number }>;
}

/**
 * The `Test Register` section, or null when the plan has no heading.
 *
 * Presence and rows are separate facts (issue #436, AC1): a heading with an
 * empty body returns a section with `lines: []`, not null.
 */
function extractRegisterSection(planContent: string): RegisterSection | null {
  const lines = planContent.split('\n');
  let fence = false;
  let inRegister = false;
  let openLevel = 0;
  let headingLine: number | null = null;
  const collected: Array<{ text: string; line: number }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isFence(line)) {
      fence = !fence;
      if (inRegister) collected.push({ text: line, line: index + 1 });
      continue;
    }
    if (fence) {
      if (inRegister) collected.push({ text: line, line: index + 1 });
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      if (inRegister && heading.level <= openLevel) {
        inRegister = false;
      } else if (
        !inRegister &&
        heading.text.toLowerCase() === HEADING_TEST_REGISTER.toLowerCase()
      ) {
        inRegister = true;
        openLevel = heading.level;
        headingLine = index + 1;
        continue;
      }
      if (inRegister) collected.push({ text: line, line: index + 1 });
      continue;
    }

    if (inRegister) collected.push({ text: line, line: index + 1 });
  }

  if (headingLine === null) return null;
  return { headingLine, lines: collected };
}

/** Strips backticks/quotes a marker value may be wrapped in. */
function unwrap(value: string): string {
  let text = value.trim();
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function parseReference(value: string): TestRegisterReference | null {
  const separator = value.indexOf('::');
  if (separator === -1) return null;
  const path = unwrap(value.slice(0, separator));
  const title = unwrap(value.slice(separator + 2));
  if (path.length === 0 || title.length === 0) return null;
  return { path, title };
}

const MARKER_ANY = /\*\*(Pins|New test|Asserts):\*\*\s*/g;
const MARKER_IDS: readonly string[] = Object.freeze([
  'Pins',
  'Pins:',
  'New test',
  'New test:',
  'Asserts',
  'Asserts:'
]);

/**
 * Applies EVERY `**(Pins|New test|Asserts):**` marker in `text` to `row`.
 *
 * A table cell may carry more than one marker, and a bullet line may carry one
 * inline. Each value runs from the end of its marker to the start of the next.
 */
function applyMarkers(row: TestRegisterRow | null, text: string): TestRegisterRow | null {
  if (!row) return row;
  let next = row;
  MARKER_ANY.lastIndex = 0;
  const matches = [...text.matchAll(MARKER_ANY)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const kind = match[1];
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const value = text.slice(valueStart, valueEnd).trim();
    if (kind === 'Pins') {
      next = { ...next, pins: parseReference(value) ?? next.pins };
      continue;
    }
    if (kind === 'New test') {
      next = { ...next, newTest: parseReference(value) ?? next.newTest };
      continue;
    }
    if (value.length > 0) {
      next = { ...next, asserts: [...next.asserts, value] };
    }
  }
  return next;
}

/** Split a `| a | b |` row into trimmed cells, honouring `\|`. */
function splitTableCells(text: string): string[] {
  if (!text.trim().startsWith('|')) return [];
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of text.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  if (cells.length > 0 && cells[0].length === 0) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].length === 0) cells.pop();
  return cells;
}

/** A markdown table separator row: every cell is `---`, `:---` or `---:`. */
function isSeparatorRow(text: string): boolean {
  if (!text.trim().startsWith('|')) return false;
  const cells = splitTableCells(text);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Parse a table row whose first cell opens with a bold id; otherwise null. */
function parseTableRow(text: string, line: number): TestRegisterRow | null {
  const cells = splitTableCells(text);
  if (cells.length === 0) return null;
  const first = /^\s*\*\*([^*]+)\*\*\s*(.*)$/.exec(cells[0]);
  if (!first) return null;

  let row: TestRegisterRow = {
    id: first[1].trim(),
    pins: null,
    newTest: null,
    asserts: [],
    line
  };
  row = applyMarkers(row, first[2]) ?? row;
  for (let index = 1; index < cells.length; index += 1) {
    row = applyMarkers(row, cells[index]) ?? row;
  }
  return row;
}

/** The next non-blank line in the section, or null. */
function nextNonBlank(
  lines: ReadonlyArray<{ text: string; line: number }>,
  start: number
): string | null {
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].text.trim().length > 0) return lines[index].text;
  }
  return null;
}

function parseRows(
  lines: ReadonlyArray<{ text: string; line: number }>
): readonly TestRegisterRow[] {
  const rows: TestRegisterRow[] = [];
  let current: TestRegisterRow | null = null;
  let fence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const { text, line } = lines[index];
    if (isFence(text)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;

    const rowMatch = /^\s*-\s+\*\*([^*]+)\*\*\s*(.*)$/.exec(text);
    // A marker sub-bullet (`- **Pins:** …`) is NOT a new row: it belongs to the
    // row above it. Only a bullet whose bold id is not a marker opens a row.
    const isMarkerBullet =
      rowMatch !== null && MARKER_IDS.includes(rowMatch[1].trim());
    if (rowMatch && !isMarkerBullet) {
      if (current) rows.push(current);
      current = {
        id: rowMatch[1].trim(),
        pins: null,
        newTest: null,
        asserts: [],
        line
      };
      // A marker may sit on the row bullet itself.
      current = applyMarkers(current, rowMatch[2]);
      continue;
    }

    if (text.trim().startsWith('|')) {
      const following = nextNonBlank(lines, index + 1);
      if (isSeparatorRow(text)) continue;
      // The row immediately above a separator is the table header.
      if (following !== null && isSeparatorRow(following)) continue;
      const tableRow = parseTableRow(text, line);
      if (tableRow) {
        if (current) rows.push(current);
        current = tableRow;
        continue;
      }
    }

    if (current) {
      current = applyMarkers(current, text);
    }
  }

  if (current) rows.push(current);
  return Object.freeze(rows);
}

/**
 * The exact guidance comment `templates/implementation-plan.md` places under
 * its `### Test Register` heading.
 *
 * If the template's guidance changes, this placeholder stops matching and the
 * scaffold is treated as a real (empty) register: the carve-out is deliberately
 * narrow rather than "any HTML comment".
 */
const SCAFFOLD_REGISTER_PLACEHOLDER =
  "<!-- One row per pinned assertion: `- **TR-1** — **Pins:** `path` :: `test title`` (or `**New test:**`) plus a `**Asserts:**` literal. A `Pins:` row must restate the pinned literal exactly; APPROVAL refuses a contradicting row and names `file:line`. -->";

/**
 * True when the body is exactly the generated scaffold's guidance comment.
 *
 * The `codeloop yolo` fast path never dispatches the PLANNER, so refusing its
 * comment-only scaffold would make the documented fast path unable to reach
 * COMMIT. This mirrors the smoke protocol's placeholder-only rule; an empty
 * heading or any other comment-only body is still a present, unparsable
 * register and is refused (AC1).
 */
function isPlaceholderBody(
  lines: ReadonlyArray<{ text: string; line: number }>
): boolean {
  const nonBlank = lines.filter(({ text }) => text.trim().length > 0);
  return (
    nonBlank.length === 1 &&
    nonBlank[0].text.trim() === SCAFFOLD_REGISTER_PLACEHOLDER
  );
}

/** A Test Register section's presence, heading line and parsed rows. */
export interface TestRegisterSection {
  readonly present: boolean;
  readonly headingLine: number | null;
  readonly rows: readonly TestRegisterRow[];
}

/**
 * Reads the register with presence separated from rows (issue #436, AC1/AC2).
 *
 * A plan with no `Test Register` heading returns
 * `{ present: false, headingLine: null, rows: [] }` and is never refused.
 */
export function readTestRegister(
  planContent: string | null | undefined
): TestRegisterSection {
  if (!planContent || typeof planContent !== 'string') {
    return Object.freeze({ present: false, headingLine: null, rows: Object.freeze([]) });
  }
  const section = extractRegisterSection(planContent);
  if (!section) {
    return Object.freeze({ present: false, headingLine: null, rows: Object.freeze([]) });
  }
  const rows = parseRows(section.lines);
  if (rows.length === 0 && isPlaceholderBody(section.lines)) {
    return Object.freeze({ present: false, headingLine: null, rows: Object.freeze([]) });
  }
  return Object.freeze({ present: true, headingLine: section.headingLine, rows });
}

/** Every Test Register row, in plan order. An absent section returns `[]`. */
export function parseTestRegister(planContent: string | null | undefined): readonly TestRegisterRow[] {
  return readTestRegister(planContent).rows;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The project's test declaration grammar: `test(` or its `it(` alias, with the
 * usual modifiers (`it.only`, `test.skip`, …) (issue #436, AC4).
 */
const TEST_DECLARATION =
  '(?:test|it)(?:\\.(?:only|skip|concurrent|concurrently|todo|failing))?';

function declarationPattern(title: string): RegExp {
  return new RegExp(
    `(?:^|[^\\w.$])(${TEST_DECLARATION})\\(\\s*['"\`]${escapeRegExp(title)}['"\`]`
  );
}

/**
 * Extracts the block of `test('<title>', () => { … })` (or an `it(` alias) from
 * a source file.
 *
 * Returns the block text and the 1-based line of the declaration keyword, or
 * `null` when the title is absent.
 */
export function extractTestBlock(
  source: string,
  title: string
): { readonly text: string; readonly line: number } | null {
  const pattern = declarationPattern(title);
  const match = pattern.exec(source);
  if (!match) return null;
  const start = match.index + match[0].indexOf(match[1]);
  const line = source.slice(0, start).split('\n').length;

  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) return null;

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { text: source.slice(start, index + 1), line };
      }
    }
  }
  return null;
}

/** Splits an argument list on top-level commas (quotes and nesting aware). */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (const char of value) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Normalises a value literal: surrounding quotes stripped, whitespace collapsed. */
function normaliseValue(value: string): string {
  let text = value.trim().replace(/;$/, '').trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('`') && text.endsWith('`')))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text.replace(/\s+/g, ' ');
}

/** The body inside the first balanced call parens of `assert.<name>( … )`. */
function callArguments(text: string): string | null {
  const open = text.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  return null;
}

/**
 * Normalises an assertion to `(subject, ===, expected)`.
 *
 * Recognised shapes: `assert.strictEqual|equal|deepStrictEqual(a, b)`,
 * `assert.ok(a === b)` and a bare `a === b`. Returns `null` for anything else.
 */
export function normaliseAssertion(raw: string): NormalisedAssertion | null {
  let text = raw.trim().replace(/;$/, '').trim();
  while (text.startsWith('`') && text.endsWith('`') && text.length >= 2) {
    text = text.slice(1, -1).trim();
  }
  if (text.length === 0) return null;

  const equalityCall = /^assert\.(?:strictEqual|equal|deepStrictEqual)\s*\(/.exec(text);
  if (equalityCall) {
    const args = callArguments(text);
    if (args === null) return null;
    const parts = splitTopLevelCommas(args);
    if (parts.length !== 2) return null;
    return {
      subject: normaliseValue(parts[0]),
      operator: '===',
      expected: normaliseValue(parts[1])
    };
  }

  const okCall = /^assert\.ok\s*\(/.exec(text);
  if (okCall) {
    const args = callArguments(text);
    if (args === null) return null;
    return splitEquality(args);
  }

  return splitEquality(text);
}

function splitEquality(text: string): NormalisedAssertion | null {
  const parts = text.split('===');
  if (parts.length !== 2) return null;
  return {
    subject: normaliseValue(parts[0]),
    operator: '===',
    expected: normaliseValue(parts[1])
  };
}

/**
 * The first assertion in `source` that declares the SAME subject as one of
 * `rowAssertions` with a DIFFERENT expected value. `startLine` is the 1-based
 * line the source text begins on.
 */
export function findContradiction(
  rowAssertions: readonly string[],
  source: string,
  startLine = 1
): TestRegisterContradiction | null {
  const declared = rowAssertions
    .map((raw) => normaliseAssertion(raw))
    .filter((assertion): assertion is NormalisedAssertion => assertion !== null);
  if (declared.length === 0) return null;

  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const pinned = normaliseAssertion(lines[index].trim());
    if (!pinned) continue;
    for (const row of declared) {
      if (row.subject === pinned.subject && row.expected !== pinned.expected) {
        return {
          subject: row.subject,
          rowValue: row.expected,
          pinnedValue: pinned.expected,
          line: startLine + index
        };
      }
    }
  }
  return null;
}

/** True when `source` already declares a test with this exact title. */
export function findDuplicateNewTest(source: string, title: string): boolean {
  if (!source) return false;
  return declarationPattern(title).test(source);
}
