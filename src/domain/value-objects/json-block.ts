/**
 * agyloop - Shared JSON block scanner (issue #432)
 *
 * The balanced-object slicer and the single-quote-tolerant JS-object fallback
 * were private copies in `gate-result-report.ts` and `gate-report-fixture.ts`.
 * The `PLAN_DEVIATION:` channel needs the SAME scanner, so it lives here once.
 *
 * Behaviour is unchanged from the two originals: the span is quote-aware for
 * `"` only (a single-quoted JS string containing a brace ends the slice early,
 * and `jsObjectLiteralToJson` converts the single-quoted strings INSIDE the
 * object). Pure domain: no I/O, no external imports.
 */

export interface SlicedJsonObject {
  readonly text: string;
  /** 0-based offset of the opening `{`. */
  readonly start: number;
  /** 0-based offset just past the closing `}`. */
  readonly end: number;
}

/**
 * Extracts the first balanced `{ … }` object starting at or after `from`.
 *
 * String literals are skipped so a brace inside a command string cannot
 * terminate the object early. Returns `null` when no balanced object exists.
 */
export function sliceBalancedObject(raw: string, from: number): SlicedJsonObject | null {
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
