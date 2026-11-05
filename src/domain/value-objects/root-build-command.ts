/**
 * agyloop - Root-build command detector (issue #402, Defect 2)
 *
 * The APPROVAL baseline guard used to execute every plan-authored command with
 * `cwd` set to the repository root. Every #383 claim started with
 * `npm run build`, so APPROVAL rebuilt the live root `dist/` five times while
 * the pipeline was running — the exact mutation the DISCOVERY directive
 * forbids, because the root build is the tool executing the gate that accepts
 * the plan.
 *
 * This is a PURE text detector: it names the matched construct so the guard can
 * refuse the claim BEFORE anything executes, and so the refusal can tell the
 * author which part of the command to rewrite.
 *
 * Conservative by design. It matches the build-like commands a baseline is
 * likely to carry:
 *
 *   - `npm run|test|compile|prepare` (`build:docs` and friends included);
 *   - `yarn`/`pnpm` `build|compile|test`;
 *   - a bare `tsc` unless it carries `--noEmit` or an absolute `--outDir`
 *     outside the workspace (a scratch out-dir is the documented workaround);
 *   - `make`, `cargo build`, `go build`, `vite build`, `next build`,
 *     `webpack`, `rollup -c`;
 *   - destructive root-build writes (`rm -rf dist`, `rm -rf build`).
 *
 * Residual, NAMED rather than silently claimed as covered: the detector cannot
 * see inside an arbitrary script, so a rebuild hidden behind
 * `node scripts/build.mjs` is out of scope for this fix. The executable script
 * that plan would ship is itself a workspace write, which the boundary and the
 * gate review still see. A shell wrapper such as `bash -c 'npm run build'` is
 * also a named residual: the wrapper's command word is `bash`, and this module
 * does not parse an arbitrary nested shell.
 *
 * Issue #436, AC5: detection runs at COMMAND POSITION per shell segment, so a
 * build command quoted inside an argument (`grep "npm run build" …`) is not a
 * build. Quoted spans are never scanned because only the command word and its
 * immediate operands are inspected.
 *
 * No imports, no I/O.
 */


import { truncate as truncateImpl } from "./markdown";

export interface RootBuildMatch {
  /** The construct that triggered the refusal, e.g. `npm run build`. */
  readonly label: string;
  /** The trimmed command that carried it. */
  readonly excerpt: string;
}

export interface DetectRootBuildOptions {
  /** Absolute workspace root, used to decide whether an `--outDir` escapes it. */
  readonly workspaceDir?: string;
}


/** `npm run build`, `npm test`, `npm run build:docs`, `npm run prepare`. */
const NPM_SCRIPT = /^(?:build(?::[\w-]+)?|compile|prepare|test)$/;

/** `yarn build`, `pnpm run build:docs`. */
const YARN_PNPM_SCRIPT = /^(?:build(?::[\w-]+)?|compile|test)$/;

/** `--outDir <value>` / `--outDir=<value>`. */
const TSC_OUT_DIR = /--outDir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/;

/** A leading environment assignment: `FOO=bar npm …`. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A leading redirection token: `>/dev/null`, `2>&1`, `&>log`. */
const REDIRECTION = /^(?:\d*(?:>>?|<)|&>)/;

/** Wrapper flags that consume the NEXT token as their value. */
const WRAPPER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--package',
  '-p',
  '--call',
  '-c',
  '--node-options',
  '--node-arg',
  '--unset',
  '-u',
  '--split-string',
  '-S'
]);

function normalise(command: string): string {
  return String(command ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits a command into pipeline segments on top-level `&&`, `||`, `;`, `|`
 * and newlines, respecting single quotes, double quotes and backslash escapes.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const next = command[index + 1];
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      flush();
      index += 1;
      continue;
    }
    if (char === '|' || char === ';' || char === '\n') {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

/** Tokens of one segment; surrounding quotes are stripped, quoted runs stay one token. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;
  let hasContent = false;

  const push = (): void => {
    if (hasContent || current.length > 0) words.push(current);
    current = '';
    hasContent = false;
  };

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (quote) {
      if (char === '\\' && quote === '"') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      hasContent = true;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
    hasContent = true;
  }
  push();
  return words;
}

/** The words starting at the command position of a segment. */
function commandWords(segment: string): string[] {
  const words = shellWords(segment);
  let index = 0;
  while (
    index < words.length &&
    (ENV_ASSIGNMENT.test(words[index]) || REDIRECTION.test(words[index]))
  ) {
    index += 1;
  }
  return words.slice(index);
}

/** Skips a wrapper's flags/assignments, returning the wrapped command's offset. */
function skipWrapperArguments(words: readonly string[], start: number, isEnv: boolean): number {
  let index = start;
  while (index < words.length) {
    const word = words[index];
    if (word === '--') return index + 1;
    if (isEnv && ENV_ASSIGNMENT.test(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) {
      index += WRAPPER_VALUE_FLAGS.has(word) ? 2 : 1;
      continue;
    }
    break;
  }
  return index;
}

/**
 * Unwraps command wrappers (`npx`, `npm exec`, `pnpm dlx`, `env`) so detection
 * sees the effective command word. `npx --yes tsc` and `npm exec tsc` name the
 * same root build as `tsc`; a wrapper must not hide it from the refusal.
 */
function unwrapCommand(words: readonly string[]): string[] {
  let index = 0;
  let guard = 0;
  while (index < words.length && guard < 20) {
    guard += 1;
    const word = words[index];
    if (word === 'npx' || word === 'env') {
      index = skipWrapperArguments(words, index + 1, word === 'env');
      continue;
    }
    if (word === 'npm' && words[index + 1] === 'exec') {
      index = skipWrapperArguments(words, index + 2, false);
      continue;
    }
    if (word === 'pnpm' && words[index + 1] === 'dlx') {
      index = skipWrapperArguments(words, index + 2, false);
      continue;
    }
    break;
  }
  return words.slice(index);
}

/** Command-position words with any wrapper removed. */
function effectiveCommandWords(segment: string): string[] {
  return unwrapCommand(commandWords(segment));
}

/** True when the words name a `tsc` invocation. */
function isTsc(words: readonly string[]): boolean {
  const first = words[0];
  if (!first) return false;
  if (first === 'tsc') return true;
  if (first.includes('node_modules/.bin/') && first.endsWith('/tsc')) return true;
  return first === 'npx' && words[1] === 'tsc';
}

/** An operand's normalised basename, e.g. `./build/` -> `build`. */
function basename(token: string): string {
  const normalised = token.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalised.slice(normalised.lastIndexOf('/') + 1);
}

/** The `rm -rf dist|build` label, if the segment is a destructive root write. */
function destructiveLabel(words: readonly string[]): string | null {
  const operand = words.slice(1).find((word) => !word.startsWith('-'));
  if (!operand) return null;
  const name = basename(operand);
  return name === 'dist' || name === 'build' ? `rm -rf ${name}` : null;
}

/** The build-like label of one segment, detected at command position. */
function detectSegment(segment: string): string | null {
  const words = effectiveCommandWords(segment);
  if (words.length === 0) return null;
  const [first, second, third] = words;

  switch (first) {
    case 'npm': {
      const script = second === 'run' ? third : second;
      if (script && NPM_SCRIPT.test(script)) {
        return `npm ${second === 'run' ? 'run ' : ''}${script}`;
      }
      return null;
    }
    case 'yarn':
    case 'pnpm': {
      const script = second === 'run' ? third : second;
      if (script && YARN_PNPM_SCRIPT.test(script)) {
        return `${first} ${second === 'run' ? 'run ' : ''}${script}`;
      }
      return null;
    }
    case 'cargo':
      return second === 'build' ? 'cargo build' : null;
    case 'go':
      return second === 'build' ? 'go build' : null;
    case 'vite':
      return second === 'build' ? 'vite build' : null;
    case 'next':
      return second === 'build' ? 'next build' : null;
    case 'make':
      return 'make';
    case 'webpack':
      return 'webpack';
    case 'rollup':
      return words.includes('-c') ? 'rollup -c' : null;
    case 'rm':
      return destructiveLabel(words);
    default:
      return null;
  }
}


/** True when `outDir` is absolute AND (with a known root) outside it. */
function isOutDirOutsideWorkspace(outDir: string, workspaceDir?: string): boolean {
  const value = outDir.trim();
  if (value.length === 0) return false;

  const isAbsolute =
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.startsWith('$HOME') ||
    value.startsWith('${HOME}') ||
    value.startsWith('%USERPROFILE%') ||
    /^[A-Za-z]:[\\/]/.test(value);
  if (!isAbsolute) return false;
  if (!workspaceDir) return true;

  const root = String(workspaceDir).replace(/\\/g, '/').replace(/\/+$/, '');
  const target = value.replace(/\\/g, '/');
  if (target === root) return false;
  return !target.startsWith(`${root}/`);
}

/** True when a segment is a `tsc` invocation that still emits in the workspace. */
function isRootBuildTsc(segment: string, workspaceDir?: string): boolean {
  if (!isTsc(effectiveCommandWords(segment))) return false;
  if (/\s--noEmit\b/.test(segment)) return false;

  const outDir = TSC_OUT_DIR.exec(segment);
  if (outDir) {
    const value = outDir[1] ?? outDir[2] ?? outDir[3] ?? '';
    if (isOutDirOutsideWorkspace(value, workspaceDir)) return false;
  }
  return true;
}

/**
 * Returns the build-like construct the command carries, or `null`.
 *
 * `tsc` is checked across every segment before the other package-manager forms
 * so the documented `--outDir` exemption applies to the invocation that carries
 * it. Detection runs at command position, so a quoted argument is never a
 * build (issue #436, AC5).
 */
export function detectRootBuildCommand(
  command: string,
  options: DetectRootBuildOptions = {}
): RootBuildMatch | null {
  const normalised = normalise(command);
  if (normalised.length === 0) return null;
  const segments = splitShellSegments(normalised);

  for (const segment of segments) {
    if (isRootBuildTsc(segment, options.workspaceDir)) {
      return { label: 'tsc', excerpt: truncateImpl(normalised, { trim: false }) };
    }
  }
  for (const segment of segments) {
    const label = detectSegment(segment);
    if (label) return { label, excerpt: truncateImpl(normalised, { trim: false }) };
  }
  return null;
}
