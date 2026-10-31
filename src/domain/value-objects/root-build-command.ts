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
 * gate review still see.
 *
 * No imports, no I/O.
 */

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

const MAX_EXCERPT_LENGTH = 160;

/** `npm run build`, `npm test`, `npm run build:docs`, `npm run prepare`. */
const NPM_BUILD = /\bnpm\s+(run\s+)?(build(?::[\w-]+)?|compile|prepare|test)\b/;

/** `yarn build`, `pnpm run build:docs`. */
const YARN_PNPM_BUILD = /\b(yarn|pnpm)\s+(run\s+)?(build(?::[\w-]+)?|compile|test)\b/;

/** A bare `tsc` binary invocation (not `tsconfig`, not a path segment). */
const TSC_COMMAND = /(^|[\s;&|()])(?:npx\s+)?(?:node_modules\/\.bin\/)?tsc(?=\s|$)/;

/** `--outDir <value>` / `--outDir=<value>`. */
const TSC_OUT_DIR = /--outDir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/;

const CARGO_BUILD = /\bcargo\s+build\b/;
const GO_BUILD = /\bgo\s+build\b/;
const VITE_BUILD = /\bvite\s+build\b/;
const NEXT_BUILD = /\bnext\s+build\b/;
const MAKE_COMMAND = /(^|[\s;&|()])make(?=\s|$)/;
const WEBPACK_COMMAND = /(^|[\s;&|()])webpack(?=\s|$)/;
const ROLLUP_CONFIG = /(^|[\s;&|()])rollup(?=[\s;&|()]|$)[^;&|]*\s-c(?=\s|$)/;
const DESTRUCTIVE_ROOT_BUILD = /\brm\s+(?:-[a-zA-Z]+\s+)*(?:\.\/)?(dist|build)\b/;

function normalise(command: string): string {
  return String(command ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string): string {
  return text.length > MAX_EXCERPT_LENGTH ? `${text.slice(0, MAX_EXCERPT_LENGTH)}…` : text;
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

function tscMatch(command: string, workspaceDir?: string): RootBuildMatch | null {
  if (!TSC_COMMAND.test(command)) return null;
  if (/\s--noEmit\b/.test(command)) return null;

  const outDir = TSC_OUT_DIR.exec(command);
  if (outDir) {
    const value = outDir[1] ?? outDir[2] ?? outDir[3] ?? '';
    if (isOutDirOutsideWorkspace(value, workspaceDir)) return null;
  }

  return { label: 'tsc', excerpt: truncate(command) };
}

function firstMatch(command: string): RootBuildMatch | null {
  const npm = NPM_BUILD.exec(command);
  if (npm) {
    const script = npm[2];
    return {
      label: `npm ${npm[1] ? 'run ' : ''}${script}`.replace(/\s+/g, ' ').trim(),
      excerpt: truncate(command)
    };
  }

  const packageManager = YARN_PNPM_BUILD.exec(command);
  if (packageManager) {
    return {
      label: `${packageManager[1]} ${packageManager[2] ? 'run ' : ''}${packageManager[3]}`,
      excerpt: truncate(command)
    };
  }

  const cargo = CARGO_BUILD.exec(command);
  if (cargo) return { label: 'cargo build', excerpt: truncate(command) };

  const go = GO_BUILD.exec(command);
  if (go) return { label: 'go build', excerpt: truncate(command) };

  const vite = VITE_BUILD.exec(command);
  if (vite) return { label: 'vite build', excerpt: truncate(command) };

  const next = NEXT_BUILD.exec(command);
  if (next) return { label: 'next build', excerpt: truncate(command) };

  if (MAKE_COMMAND.test(command)) return { label: 'make', excerpt: truncate(command) };
  if (WEBPACK_COMMAND.test(command)) return { label: 'webpack', excerpt: truncate(command) };
  if (ROLLUP_CONFIG.test(command)) return { label: 'rollup -c', excerpt: truncate(command) };

  const destructive = DESTRUCTIVE_ROOT_BUILD.exec(command);
  if (destructive) {
    return { label: `rm -rf ${destructive[1]}`, excerpt: truncate(command) };
  }

  return null;
}

/**
 * Returns the build-like construct the command carries, or `null`.
 *
 * `tsc` is checked before the other package-manager forms so the documented
 * `--outDir` exemption applies to the invocation that carries it.
 */
export function detectRootBuildCommand(
  command: string,
  options: DetectRootBuildOptions = {}
): RootBuildMatch | null {
  const normalised = normalise(command);
  if (normalised.length === 0) return null;

  return tscMatch(normalised, options.workspaceDir) ?? firstMatch(normalised);
}
