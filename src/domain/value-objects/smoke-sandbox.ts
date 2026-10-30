/**
 * agyloop - Lexical path algebra for the `sandbox-path` rule (issue #364)
 *
 * The static rule must judge a created path against the directory the command
 * actually runs in — a `cd` into the sandbox makes a RELATIVE `mkdir` legal,
 * and a `..`-escaped path that resolves outside the sandbox is illegal even
 * when its text starts with the sandbox prefix. `SmokeProtocol` is I/O-free
 * (and must stay so), so the pure helpers live here.
 *
 * These helpers mirror `FileStateRepository.isSmokeSandboxPath`: both are
 * LEXICAL (`path.resolve` on the runtime side, segment folding here) and both
 * require the path to be inside `${root}/` with a first relative segment that
 * starts with `smoke-`. Symlinks are deliberately NOT resolved — the static
 * rule performs no I/O — so a symlinked alias that changes the path's SHAPE is
 * a known, documented divergence.
 *
 * No I/O, no external imports.
 */

import {
  SMOKE_SANDBOX_DIR_PREFIX,
  SMOKE_SANDBOX_HOME_ANCHOR,
  SMOKE_SANDBOX_ROOT_DISPLAY
} from '../constants';

/** A `$HOME`/`${HOME}`/`~` anchor at the start of a path. */
const HOME_ANCHOR_PATTERN = /^(?:\$\{HOME\}|\$HOME|~)(?=\/|$)/;

/**
 * True when `path` is anchored — absolute (`/…`) or `$HOME`/`~`-rooted — so it
 * does not depend on the current working directory.
 */
export function isAnchoredPath(path: string): boolean {
  return String(path ?? '').trim().startsWith('/') || HOME_ANCHOR_PATTERN.test(String(path ?? '').trim());
}

/**
 * Collapses `.`/`..` segments textually.
 *
 * Keeps a leading `$HOME`/`${HOME}`/`~` (normalised to `$HOME`) or `/` anchor
 * and NEVER walks above it: `..` at the anchor is a no-op, exactly like
 * `path.resolve('/…', '..')` staying at `/`.
 *
 * @param path - The path text (quotes already stripped by the caller).
 */
export function normaliseLexicalPath(path: string): string {
  const text = String(path ?? '').trim();
  if (text.length === 0) return '';

  let anchor = '';
  let rest = text;
  const homeMatch = HOME_ANCHOR_PATTERN.exec(text);
  if (homeMatch) {
    anchor = SMOKE_SANDBOX_HOME_ANCHOR;
    rest = text.slice(homeMatch[0].length);
  } else if (text.startsWith('/')) {
    anchor = '/';
    rest = text.slice(1);
  }

  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (anchor === '') return segments.join('/');
  if (anchor === '/') return `/${segments.join('/')}`;
  return segments.length === 0 ? anchor : `${anchor}/${segments.join('/')}`;
}

/**
 * Resolves `path` against `cwd` when it is relative.
 *
 * @param cwd - The tracked working directory, or `null` when unknown.
 * @param path - The path as written (variables already resolved).
 * @returns The normalised absolute path; `null` when `path` is relative and
 *          `cwd` is unknown — a relative path the rule cannot anchor is never
 *          guessed.
 */
export function resolvePathAgainstCwd(cwd: string | null, path: string): string | null {
  const text = String(path ?? '').trim();
  if (text.length === 0) return null;
  if (isAnchoredPath(text)) return normaliseLexicalPath(text);
  if (cwd === null || cwd === undefined || String(cwd).trim().length === 0) return null;
  return normaliseLexicalPath(`${cwd}/${text}`);
}

/**
 * The static mirror of `FileStateRepository.isSmokeSandboxPath`: `absolutePath`
 * is strictly inside `${root}/` and its first relative segment starts with
 * `smoke-`. The root itself is never a sandbox.
 *
 * The `~` / `${HOME}` spellings normalise to `$HOME` before comparison, so all
 * three documented anchor forms are recognised.
 *
 * @param absolutePath - The resolved candidate path.
 * @param root - The sandbox root (defaults to `$HOME/.cache/agyloop`).
 */
export function isWithinSmokeSandbox(
  absolutePath: string,
  root: string = SMOKE_SANDBOX_ROOT_DISPLAY
): boolean {
  const normalisedRoot = normaliseLexicalPath(root);
  const normalisedPath = normaliseLexicalPath(absolutePath);
  if (normalisedRoot.length === 0) return false;

  const prefix = normalisedRoot.endsWith('/') ? normalisedRoot : `${normalisedRoot}/`;
  if (!normalisedPath.startsWith(prefix)) return false;

  const relative = normalisedPath.slice(prefix.length);
  const firstSegment = relative.split('/')[0] ?? '';
  return firstSegment.startsWith(SMOKE_SANDBOX_DIR_PREFIX);
}
