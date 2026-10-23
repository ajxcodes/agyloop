/**
 * agyloop - Root-Invariant Value Object (Domain Layer)
 *
 * The ONE shared predicate guarding the Zero Direct Root Mutation invariant
 * (issue #247): a task's "worktree" path is never allowed to be — or to contain —
 * the repository's root workspace. Both the directive side (`codeloop next`)
 * and every destructive cleanup path (worktree adoption, worktree teardown)
 * must agree on this single predicate instead of holding divergent opinions.
 *
 * Purity note: this module has NO imports at all — no `node:path`, no `fs`, no
 * process access. The repository's architecture fitness test
 * (`tests/architecture/hexagonal-boundaries.test.ts`) forbids every external
 * import inside `src/domain` and every `path` import inside `src/application`,
 * so the resolve-normalization is implemented here as pure string computation.
 * The semantics mirror `path.resolve` / `path.relative` for the cases this
 * invariant cares about: absolute POSIX paths, relative fragments and their
 * `.` / `..` forms. A relative candidate is interpreted against the workspace
 * path it is compared with (the anchor `path.resolve` would take from the
 * process cwd), which keeps the comparison anchored on the workspace root
 * instead of on an ambient directory.
 */

export const ZERO_DIRECT_ROOT_MUTATION_MESSAGE =
  "Zero Direct Root Mutation invariant violated. Pipeline must execute code modifications inside an isolated worktree, but target resolved to root workspace '{rootDir}'.";

/**
 * A parsed, normalized filesystem path.
 *
 * - `prefix` is the root marker: '' (relative), '/', 'C:/' or '//server/share/'.
 * - `segments` are the path components with `.` / `..` already applied.
 * - `absolute` tells the two apart (a relative path has no root marker).
 */
interface CanonicalPath {
  readonly prefix: string;
  readonly segments: readonly string[];
  readonly absolute: boolean;
}

/**
 * Normalizes Windows-style separators to POSIX ones. A POSIX path that merely
 * contains a backslash keeps it (it is a legal filename character there).
 */
function toPosixSeparators(raw: string): string {
  if (raw.includes('\\') && (!raw.includes('/') || /^[A-Za-z]:/.test(raw))) {
    return raw.replace(/\\/g, '/');
  }
  return raw;
}

/** Splits the root marker ('/', 'C:/', '//server/share/') off a normalized path. */
function splitPrefix(raw: string): { prefix: string; rest: string; absolute: boolean } {
  if (raw.startsWith('//')) {
    const parts = raw.slice(2).split('/');
    const server = parts[0] ?? '';
    const share = parts[1] ?? '';
    return {
      prefix: `//${server}/${share}/`,
      rest: parts.slice(2).join('/'),
      absolute: true
    };
  }

  const drive = raw.match(/^([A-Za-z]:)(\/.*)?$/);
  if (drive) {
    return {
      prefix: `${drive[1]}/`,
      rest: (drive[2] ?? '').replace(/^\//, ''),
      absolute: true
    };
  }

  if (raw.startsWith('/')) {
    return { prefix: '/', rest: raw.slice(1), absolute: true };
  }

  return { prefix: '', rest: raw, absolute: false };
}

/**
 * Applies the `.` / `..` rules to the path components. An absolute path clamps
 * at its root ('/..' is '/'); a relative path keeps a leading '..'.
 */
function normalizeSegments(rest: string, absolute: boolean): string[] {
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else if (!absolute) {
        segments.push('..');
      }
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * Canonicalizes a path the way `path.resolve` would, anchored on `anchor` when
 * the path itself is relative.
 */
function canonicalize(rawPath: string, anchor?: CanonicalPath): CanonicalPath {
  const posix = toPosixSeparators(rawPath);
  const { prefix, rest, absolute } = splitPrefix(posix);

  if (absolute) {
    return { prefix, segments: normalizeSegments(rest, true), absolute: true };
  }

  if (anchor && anchor.absolute) {
    const merged = [...anchor.segments, ...rest.split('/')].join('/');
    return {
      prefix: anchor.prefix,
      segments: normalizeSegments(merged, true),
      absolute: true
    };
  }

  return { prefix: '', segments: normalizeSegments(rest, false), absolute: false };
}

/** True when both paths denote exactly the same location. */
function samePath(a: CanonicalPath, b: CanonicalPath): boolean {
  return (
    a.absolute === b.absolute &&
    a.prefix === b.prefix &&
    a.segments.length === b.segments.length &&
    a.segments.every((segment, index) => segment === b.segments[index])
  );
}

/**
 * The path segments leading from `from` to `to` ('..' steps upwards), the
 * counterpart of `path.relative`.
 */
function relativeSegments(from: CanonicalPath, to: CanonicalPath): string[] {
  let common = 0;
  while (
    common < from.segments.length &&
    common < to.segments.length &&
    from.segments[common] === to.segments[common]
  ) {
    common += 1;
  }
  const up = from.segments.length - common;
  const down = to.segments.slice(common);
  return [...Array.from({ length: up }, () => '..'), ...down];
}

/** True when `candidate` is a STRICT descendant of `root` (never the root itself). */
function isStrictDescendant(candidate: CanonicalPath, root: CanonicalPath): boolean {
  if (candidate.absolute !== root.absolute) return false;
  if (candidate.prefix !== root.prefix) return false;
  const relative = relativeSegments(root, candidate);
  return relative.length > 0 && relative[0] !== '..';
}

/**
 * True when `worktreePath` resolves to the same path as the workspace root.
 * Resolve-normalized: '.', relative fragments, redundant '..' segments and
 * trailing separators all compare equal to the root.
 */
export function isRootWorkspace(worktreePath: string, rootDir: string): boolean {
  if (!worktreePath || !rootDir) return false;
  const root = canonicalize(rootDir);
  const candidate = canonicalize(worktreePath, root);
  return samePath(candidate, root);
}

/**
 * True when `candidatePath` resolves to a STRICT descendant of `rootDir`.
 * False for the root itself, for ancestors (e.g. '..' of the root) and for
 * paths that merely share a prefix (resolve-normalized, never stem matching).
 */
export function isPathInsideRoot(candidatePath: string, rootDir: string): boolean {
  if (!candidatePath || !rootDir) return false;
  const root = canonicalize(rootDir);

  if (!root.absolute) {
    // A relative root can only relate to a relative candidate.
    return isStrictDescendant(canonicalize(candidatePath), root);
  }

  return isStrictDescendant(canonicalize(candidatePath, root), root);
}

/**
 * True when both arguments denote exactly the same location.
 *
 * A pure, resolve-normalized STRING comparison — no `fs`, so the application
 * layer (which may not import `path` or `fs`) can compare a checkpoint's
 * descriptor against the path it just removed (issue #282).
 *
 * Both sides are compared as absolute paths: a relative path is NEVER equal to
 * an absolute one, because the relative side has no anchor here. Callers must
 * pass resolved paths. An empty argument is never equal to anything, including
 * another empty argument — "no path" is not a location.
 */
export function isSamePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  return samePath(canonicalize(a), canonicalize(b));
}

/**
 * Throws the single-sourced invariant message when `worktreePath` resolves to
 * the root workspace. `context` mirrors the ValidationError wording prefix
 * (`Validation failed for field '<context>': ...`) so existing consumers of the
 * `codeloop next` error string keep seeing the same text verbatim.
 */
export function assertNotRootWorkspace(
  worktreePath: string,
  rootDir: string,
  context?: string
): void {
  if (!isRootWorkspace(worktreePath, rootDir)) return;

  const reason = ZERO_DIRECT_ROOT_MUTATION_MESSAGE.replace('{rootDir}', rootDir);
  const message = context
    ? `Validation failed for field '${context}': ${reason}`
    : reason;
  throw new Error(message);
}
