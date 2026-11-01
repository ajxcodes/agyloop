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

/** The `Test Register` section body, or null when the plan has none. */
function extractRegisterLines(planContent: string): ReadonlyArray<{ text: string; line: number }> | null {
  const lines = planContent.split('\n');
  let fence = false;
  let inRegister = false;
  let openLevel = 0;
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
        continue;
      }
      if (inRegister) collected.push({ text: line, line: index + 1 });
      continue;
    }

    if (inRegister) collected.push({ text: line, line: index + 1 });
  }

  return inRegister || collected.length > 0 ? collected : null;
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

const MARKER = /\*\*(Pins|New test|Asserts):\*\*\s*(.*)$/;
const MARKER_IDS: readonly string[] = Object.freeze([
  'Pins',
  'Pins:',
  'New test',
  'New test:',
  'Asserts',
  'Asserts:'
]);

function applyMarker(row: TestRegisterRow | null, line: string): TestRegisterRow | null {
  if (!row) return row;
  const match = MARKER.exec(line);
  if (!match) return row;
  const kind = match[1];
  const value = match[2].trim();
  if (kind === 'Pins') {
    return { ...row, pins: parseReference(value) ?? row.pins };
  }
  if (kind === 'New test') {
    return { ...row, newTest: parseReference(value) ?? row.newTest };
  }
  if (value.length > 0) {
    return { ...row, asserts: [...row.asserts, value] };
  }
  return row;
}

/** Every Test Register row, in plan order. An absent section returns `[]`. */
export function parseTestRegister(planContent: string | null | undefined): readonly TestRegisterRow[] {
  if (!planContent || typeof planContent !== 'string') return Object.freeze([]);
  const lines = extractRegisterLines(planContent);
  if (!lines) return Object.freeze([]);

  const rows: TestRegisterRow[] = [];
  let current: TestRegisterRow | null = null;
  let fence = false;

  for (const { text, line } of lines) {
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
      current = applyMarker(current, rowMatch[2]);
      continue;
    }

    if (current) {
      current = applyMarker(current, text);
    }
  }

  if (current) rows.push(current);
  return Object.freeze(rows);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts the block of `test('<title>', () => { … })` from a source file.
 *
 * Returns the block text and the 1-based line of the `test(` declaration, or
 * `null` when the title is absent.
 */
export function extractTestBlock(
  source: string,
  title: string
): { readonly text: string; readonly line: number } | null {
  const pattern = new RegExp(
    `(?:^|[^\\w.$])test\\(\\s*['"\`]${escapeRegExp(title)}['"\`]`
  );
  const match = pattern.exec(source);
  if (!match) return null;
  const start = match.index + match[0].indexOf('test(');
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
  const pattern = new RegExp(
    `(?:^|[^\\w.$])test\\(\\s*['"\`]${escapeRegExp(title)}['"\`]`
  );
  return pattern.test(source);
}
