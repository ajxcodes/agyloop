/**
 * agyloop - Bounded Workspace & Subproject Discovery (issue #334)
 *
 * ONE discovery implementation shared by `FileBuildDetector` (which needs the
 * subproject gate commands) and `FileProjectScaffolder` (which needs the
 * `monorepo` / `subprojects` / marker verdict). Two walkers would eventually
 * disagree about the same repository.
 *
 * The traversal is deliberately bounded and cheap: at most two directory levels
 * below the workspace root, only under the standard monorepo containers and the
 * well-known project directories, plus the workspace globs a repository
 * declares about itself. `scanDirectory` is the only `readdir` here, it is never
 * recursive, and it never throws — a probe failure means "nothing found", never
 * a failed `codeloop init`.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  CMD_SCOPE_SEPARATOR,
  CMD_SCOPE_WITH_DIR,
  DOTNET_EXTENSIONS,
  GRADLE_MARKERS,
  MARKER_CARGO_TOML,
  MARKER_GO_MOD,
  MARKER_GO_WORK,
  MARKER_PACKAGE_JSON,
  MARKER_PNPM_WORKSPACE,
  MARKER_POM_XML,
  MARKER_SETTINGS_GRADLE,
  MARKER_SETTINGS_GRADLE_KTS,
  PLAYWRIGHT_CONFIG_MARKERS,
  PYTHON_MARKERS,
  SUBPROJECT_CONTAINER_DIRS,
  SUBPROJECT_IGNORED_DIRS,
  SUBPROJECT_MAX_COUNT,
  SUBPROJECT_MAX_DEPTH,
  SUBPROJECT_NAMED_DIRS
} from '../domain';

/** A bounded, repo-relative subproject candidate (#334). */
export interface DiscoveredSubproject {
  /** POSIX, repo-relative, no leading './' and no trailing slash, e.g. 'apps/web'. */
  readonly relDir: string;
  /** Absolute path of the candidate directory. */
  readonly dir: string;
  /** Files at that level only (never recursive). */
  readonly fileNames: ReadonlySet<string>;
}

/** Root-relative marker classification of ONE directory. */
export interface DirectoryMarkers {
  /** `package.json` present. */
  readonly node: boolean;
  /** `go.mod` present. */
  readonly go: boolean;
  /** `Cargo.toml` present. */
  readonly rust: boolean;
  /** `PYTHON_MARKERS` present in this directory. */
  readonly python: readonly string[];
  /** `GRADLE_MARKERS` present in this directory. */
  readonly gradle: readonly string[];
  /** `pom.xml` present. */
  readonly maven: boolean;
  /** Files ending in a .NET project/solution extension, sorted. */
  readonly dotnet: readonly string[];
  /** `PLAYWRIGHT_CONFIG_MARKERS` present in this directory. */
  readonly playwright: readonly string[];
}

const IGNORED_DIRS = new Set<string>(SUBPROJECT_IGNORED_DIRS);

/** Shell separators understood by the command-body comparison below. */
const SCRIPT_SEPARATOR_PATTERN = /&&|\|\||;|\|/;

/** Executable aliases: `./gradlew test` and `gradle test` are the same command. */
const EXECUTABLE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  './gradlew': 'gradle',
  './mvnw': 'mvn'
});

/**
 * Reads the file names at one directory level.
 *
 * Never recursive and never throws: an unreadable directory is an empty set.
 */
export function scanDirectory(dir: string): Set<string> {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  } catch {
    return new Set<string>();
  }
}

/** Classifies the marker files of one directory. */
export function classifyDirectory(fileNames: ReadonlySet<string>): DirectoryMarkers {
  const dotnet = Array.from(fileNames)
    .filter((name) => DOTNET_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .sort();

  return {
    node: fileNames.has(MARKER_PACKAGE_JSON),
    go: fileNames.has(MARKER_GO_MOD),
    rust: fileNames.has(MARKER_CARGO_TOML),
    python: PYTHON_MARKERS.filter((marker) => fileNames.has(marker)),
    gradle: GRADLE_MARKERS.filter((marker) => fileNames.has(marker)),
    maven: fileNames.has(MARKER_POM_XML),
    dotnet,
    playwright: PLAYWRIGHT_CONFIG_MARKERS.filter((marker) => fileNames.has(marker))
  };
}

/** True when this directory carries at least one ecosystem marker of its own. */
export function isProjectDirectory(markers: DirectoryMarkers): boolean {
  return (
    markers.node ||
    markers.go ||
    markers.rust ||
    markers.python.length > 0 ||
    markers.gradle.length > 0 ||
    markers.maven ||
    markers.dotnet.length > 0
  );
}

/** Joins a repo-relative directory and a command into a shell-safe scoped form. */
export function withWorkingDirectory(relDir: string, command: string): string {
  if (!relDir) return command;
  return `${CMD_SCOPE_WITH_DIR} ${relDir} ${CMD_SCOPE_SEPARATOR} ${command}`;
}

/**
 * The tokens of the LAST shell segment of a command, with `cd <dir>` dropped and
 * the executable canonicalised (`./gradlew` → `gradle`).
 *
 * `'cd apps/web && pnpm test'` → `['pnpm', 'test']`.
 */
export function canonicalCommandTokens(command: string): string[] {
  const segments = String(command || '').split(SCRIPT_SEPARATOR_PATTERN);
  const last = segments[segments.length - 1] || '';
  const tokens = last.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens[0] === CMD_SCOPE_WITH_DIR) {
    tokens.splice(0, 2);
  }
  if (tokens.length > 0) {
    tokens[0] = canonicalExecutable(tokens[0]);
  }
  return tokens;
}

/**
 * True when `command` is already run by one of the given package-script bodies.
 *
 * A wrapper such as `"test": "./gradlew test"` therefore subsumes a detected
 * `gradle test`, while `gradle check` — a different subcommand — is preserved.
 */
export function isCommandWrappedByScripts(
  command: string,
  scripts: readonly string[]
): boolean {
  const needle = canonicalCommandTokens(command);
  if (needle.length === 0) return false;

  for (const script of scripts) {
    for (const segment of String(script || '').split(SCRIPT_SEPARATOR_PATTERN)) {
      if (isContiguousSubsequence(needle, segmentTokens(segment))) return true;
    }
  }
  return false;
}

/**
 * Reads every workspace glob the repository declares about itself.
 *
 * Each source is read in its own `try/catch`: a malformed manifest contributes
 * no patterns instead of failing discovery.
 */
export function workspacePatterns(
  rootDir: string,
  rootFileNames: ReadonlySet<string>
): string[] {
  return [
    ...packageJsonWorkspacePatterns(rootDir, rootFileNames),
    ...pnpmWorkspacePatterns(rootDir, rootFileNames),
    ...gradleIncludePatterns(rootDir, rootFileNames),
    ...cargoMemberPatterns(rootDir, rootFileNames),
    ...goWorkPatterns(rootDir, rootFileNames)
  ];
}

/**
 * Expands one declared workspace glob into repo-relative directories.
 *
 * Literal segments are walked as-is; `*` and `**` segments expand to the sorted
 * child directories. Absolute patterns, `..`, ignored directories and anything
 * deeper than `SUBPROJECT_MAX_DEPTH` are refused.
 */
export function expandWorkspacePattern(rootDir: string, pattern: string): string[] {
  const normalized = normalizePattern(pattern);
  if (!normalized) return [];

  const segments = normalized.split('/');
  if (segments.length > SUBPROJECT_MAX_DEPTH) return [];

  let current: string[] = [''];
  for (const segment of segments) {
    if (segment === '*' || segment === '**') {
      const next: string[] = [];
      for (const relDir of current) {
        for (const child of listChildDirectories(path.join(rootDir, relDir))) {
          next.push(relDir === '' ? child : `${relDir}/${child}`);
        }
      }
      current = next;
    } else {
      current = current.map((relDir) => (relDir === '' ? segment : `${relDir}/${segment}`));
    }
    if (current.length === 0) return [];
  }

  return current.sort();
}

/**
 * Discovers subproject candidates, bounded and deterministic.
 *
 * Sources, in order: monorepo containers (depth 2), the well-known project
 * directories (depth 1, or their children when marker-less), then declared
 * workspace globs. Candidates without an ecosystem marker are dropped, the rest
 * are de-duplicated by `relDir`, sorted lexicographically and capped.
 */
export function discoverSubprojects(
  rootDir: string,
  rootFileNames: ReadonlySet<string>
): DiscoveredSubproject[] {
  try {
    const resolvedRoot = path.resolve(rootDir);
    const found = new Map<string, DiscoveredSubproject>();

    const consider = (relDir: string): void => {
      const normalized = normalizeRelDir(relDir);
      if (!normalized || found.has(normalized)) return;
      const dir = path.join(resolvedRoot, ...normalized.split('/'));
      const fileNames = scanDirectory(dir);
      if (!isProjectDirectory(classifyDirectory(fileNames))) return;
      found.set(normalized, { relDir: normalized, dir, fileNames });
    };

    for (const container of SUBPROJECT_CONTAINER_DIRS) {
      for (const child of listChildDirectories(path.join(resolvedRoot, container))) {
        consider(`${container}/${child}`);
      }
    }

    for (const named of SUBPROJECT_NAMED_DIRS) {
      const namedDir = path.join(resolvedRoot, named);
      if (isProjectDirectory(classifyDirectory(scanDirectory(namedDir)))) {
        consider(named);
        continue;
      }
      for (const child of listChildDirectories(namedDir)) {
        consider(`${named}/${child}`);
      }
    }

    let patterns: string[] = [];
    try {
      patterns = workspacePatterns(resolvedRoot, rootFileNames);
    } catch {
      patterns = [];
    }
    for (const pattern of patterns) {
      for (const relDir of expandWorkspacePattern(resolvedRoot, pattern)) {
        consider(relDir);
      }
    }

    return Array.from(found.values())
      .filter((candidate) => path.resolve(candidate.dir).startsWith(resolvedRoot + path.sep))
      .sort((a, b) => (a.relDir < b.relDir ? -1 : a.relDir > b.relDir ? 1 : 0))
      .slice(0, SUBPROJECT_MAX_COUNT);
  } catch {
    return [];
  }
}

/**
 * Sorted child directories of `dir`, skipping symlinks and ignored names.
 *
 * `Dirent.isDirectory()` is false for a symlink, so the walk can never cycle.
 */
function listChildDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Normalises a declared glob, or returns null when it must be refused. */
function normalizePattern(pattern: string): string | null {
  let value = String(pattern || '').trim();
  if (!value || value.startsWith('!')) return null;
  value = value.replace(/\\/g, '/');
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return null;
  value = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!value) return null;

  const segments = value.split('/');
  if (segments.length > SUBPROJECT_MAX_DEPTH) return null;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
    if (IGNORED_DIRS.has(segment)) return null;
  }
  return segments.join('/');
}

/** Normalises a discovered directory into `relDir` form, or returns null. */
function normalizeRelDir(relDir: string): string | null {
  const value = String(relDir || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!value) return null;

  const segments = value.split('/');
  if (segments.length === 0 || segments.length > SUBPROJECT_MAX_DEPTH) return null;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
    if (IGNORED_DIRS.has(segment)) return null;
  }
  return segments.join('/');
}

/** Tokens of one shell segment, executable canonicalised. */
function segmentTokens(segment: string): string[] {
  const tokens = String(segment || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    tokens[0] = canonicalExecutable(tokens[0]);
  }
  return tokens;
}

/** Canonicalises a wrapper executable to the tool it wraps. */
function canonicalExecutable(token: string): string {
  return EXECUTABLE_ALIASES[token] ?? token;
}

/** True when `needle` appears contiguously inside `haystack`. */
function isContiguousSubsequence(
  needle: readonly string[],
  haystack: readonly string[]
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (needle[offset] !== haystack[start + offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/** `package.json#workspaces` (array, or `{ packages: [...] }`). */
function packageJsonWorkspacePatterns(
  rootDir: string,
  rootFileNames: ReadonlySet<string>
): string[] {
  if (!rootFileNames.has(MARKER_PACKAGE_JSON)) return [];
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(rootDir, MARKER_PACKAGE_JSON), 'utf8')
    ) as { workspaces?: unknown };
    const workspaces = parsed?.workspaces;
    const list = Array.isArray(workspaces)
      ? workspaces
      : workspaces && typeof workspaces === 'object'
        ? (workspaces as { packages?: unknown }).packages
        : null;
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** `pnpm-workspace.yaml` `packages:` list (a line scanner, no YAML dependency). */
function pnpmWorkspacePatterns(
  rootDir: string,
  rootFileNames: ReadonlySet<string>
): string[] {
  if (!rootFileNames.has(MARKER_PNPM_WORKSPACE)) return [];
  try {
    const lines = fs
      .readFileSync(path.join(rootDir, MARKER_PNPM_WORKSPACE), 'utf8')
      .split(/\r?\n/);
    const patterns: string[] = [];
    let inPackages = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('packages:')) {
        inPackages = true;
        const inline = trimmed.slice('packages:'.length).trim();
        if (inline.startsWith('[')) {
          const body = inline.replace(/^\[/, '').replace(/\]$/, '');
          for (const item of body.split(',')) {
            const value = stripQuotes(item);
            if (value) patterns.push(value);
          }
          break;
        }
        continue;
      }
      if (!inPackages) continue;
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!trimmed.startsWith('-')) break;
      const value = stripQuotes(trimmed.slice(1));
      if (value) patterns.push(value);
    }

    return patterns;
  } catch {
    return [];
  }
}

/** `settings.gradle(.kts)` `include(":apps:web")` declarations. */
function gradleIncludePatterns(
  rootDir: string,
  rootFileNames: ReadonlySet<string>
): string[] {
  const files = [MARKER_SETTINGS_GRADLE, MARKER_SETTINGS_GRADLE_KTS].filter((name) =>
    rootFileNames.has(name)
  );
  if (files.length === 0) return [];

  const patterns: string[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
      for (const line of content.split(/\r?\n/)) {
        if (!/\binclude\b/.test(line)) continue;
        const quoted = line.match(/['"]([^'"]+)['"]/g) || [];
        for (const raw of quoted) {
          const value = raw
            .slice(1, -1)
            .trim()
            .replace(/^:/, '')
            .replace(/:/g, '/');
          if (value) patterns.push(value);
        }
      }
    } catch {
      // A malformed settings file contributes no patterns.
    }
  }
  return patterns;
}

/** `Cargo.toml` `[workspace] members = [ … ]` declarations. */
function cargoMemberPatterns(
  rootDir: string,
  rootFileNames: ReadonlySet<string>
): string[] {
  if (!rootFileNames.has(MARKER_CARGO_TOML)) return [];
  try {
    const content = fs.readFileSync(path.join(rootDir, MARKER_CARGO_TOML), 'utf8');
    const workspaceIndex = content.search(/^\s*\[workspace\]\s*$/m);
    if (workspaceIndex === -1) return [];
    const section = content.slice(workspaceIndex);
    const match = /members\s*=\s*\[([\s\S]*?)\]/.exec(section);
    if (!match) return [];
    return (match[1].match(/['"]([^'"]+)['"]/g) || [])
      .map((raw) => raw.slice(1, -1).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** `go.work` `use ./x` declarations, including the `use ( … )` block form. */
function goWorkPatterns(rootDir: string, rootFileNames: ReadonlySet<string>): string[] {
  if (!rootFileNames.has(MARKER_GO_WORK)) return [];
  try {
    const lines = fs.readFileSync(path.join(rootDir, MARKER_GO_WORK), 'utf8').split(/\r?\n/);
    const patterns: string[] = [];
    let inBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!inBlock) {
        const match = /^use\s+(.+)$/.exec(trimmed);
        if (!match) continue;
        const value = match[1].trim();
        if (value === '(') {
          inBlock = true;
          continue;
        }
        patterns.push(normalizeUsePath(value));
        continue;
      }
      if (trimmed === ')') {
        inBlock = false;
        continue;
      }
      if (!trimmed || trimmed.startsWith('//')) continue;
      patterns.push(normalizeUsePath(trimmed));
    }

    return patterns.filter(Boolean);
  } catch {
    return [];
  }
}

/** Strips quotes and the leading `./` from a `go.work` use path. */
function normalizeUsePath(value: string): string {
  return stripQuotes(value)
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** Strips a single layer of surrounding single/double quotes. */
function stripQuotes(value: string): string {
  const trimmed = String(value || '').trim();
  const quoted = /^['"](.*)['"]$/.exec(trimmed);
  return quoted ? quoted[1].trim() : trimmed;
}
