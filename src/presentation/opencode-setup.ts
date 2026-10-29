/**
 * agyloop - OpenCode Setup & Integration Installer
 *
 * Installs the CodeLoop skill asset into the directory OpenCode actually scans and
 * auto-registers the `/codeloop` slash command in the active OpenCode config.
 *
 * Issue #218 AC1-AC3:
 *  - AC1 slash command auto-registration (JSONC-safe parse -> merge -> atomic write)
 *  - AC2 dangling symlink safety (`lstatSync`, never `existsSync`, before linking)
 *  - AC3 worktree path canonicalization (never bake an ephemeral path into a global link)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import {
  DEFAULT_WORKTREES_DIR,
  OPENCODE_APP_DIR_NAME,
  OPENCODE_COMMAND_ASSET_RELATIVE_PATH,
  OPENCODE_COMMAND_DESCRIPTION,
  OPENCODE_COMMAND_NAME,
  OPENCODE_COMMAND_TEMPLATE,
  OPENCODE_CONFIG_BACKUP_SUFFIX,
  OPENCODE_CONFIG_CREATE_FILENAME,
  OPENCODE_CONFIG_DIR_NAME,
  OPENCODE_CONFIG_FILENAMES,
  OPENCODE_LEGACY_DIR_NAME,
  OPENCODE_LEGACY_SKILL_FILENAME,
  OPENCODE_SKILL_ASSET_RELATIVE_PATH,
  OPENCODE_SKILL_FILENAME,
  OPENCODE_SKILL_NAME,
  OPENCODE_SYMLINK_FALLBACK_CODES
} from '../domain/constants';

/** How the workspace root was resolved away from an ephemeral `.worktrees/<id>` checkout. */
export type OpenCodeCanonicalizationMethod =
  | 'module'
  | 'git-worktree-root'
  | 'worktree-path-walk'
  | 'none';

export interface OpenCodeInstallOptions {
  /** `false` installs into a project-local `.opencode/skills` tree. Defaults to global. */
  readonly global?: boolean;
  /** Explicit skills directory override (tests). Bypasses the config-dir derivation. */
  readonly targetDir?: string;
  /** Opt-in: purge the whole `<skillsDir>/codeloop` directory (and stale siblings). */
  readonly force?: boolean;
  /** Workspace root that owns `integrations/opencode/`. Defaults to the module's repo root. */
  readonly baseDir?: string;
  /** TEST SEAM - defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** TEST SEAM - defaults to `<homeDir>/.config/opencode`. */
  readonly configDir?: string;
  /** Set `false` to install the skill without touching any OpenCode config. Defaults to `true`. */
  readonly registerCommand?: boolean;
  /**
   * Simulate (#339 item 4): resolve both target paths read-only and write
   * NOTHING. The refusal gate used to claim this command "does not modify
   * state" — it writes the skill asset and the `/codeloop` command entry.
   */
  readonly dryRun?: boolean;
}

export interface OpenCodeCommandPayload {
  readonly description: string;
  readonly template: string;
}

export interface OpenCodeCommandRegistrationResult {
  /** `true` only when this call wrote the entry. */
  readonly registered: boolean;
  /** `true` when a `command.codeloop` entry already existed and was left byte-for-byte alone. */
  readonly alreadyPresent: boolean;
  /** Config that was inspected (or would be created), `null` when registration was skipped. */
  readonly configPath: string | null;
  /** Human-readable degradation reason; `null` on success/idempotent no-op. */
  readonly warning: string | null;
}

export interface OpenCodeInstallResult {
  readonly success: boolean;
  readonly installedPath: string;
  readonly sourcePath: string;
  readonly isSymlink: boolean;
  readonly skillsDir: string;
  /** Workspace root actually used as the symlink source (after AC3 canonicalization). */
  readonly canonicalBaseDir: string;
  readonly canonicalizationMethod: OpenCodeCanonicalizationMethod;
  readonly commandRegistered: boolean;
  readonly configPath: string | null;
  /** Non-null when the install could not be performed exactly as intended. */
  readonly degradedReason: string | null;
  readonly warnings: readonly string[];
}

interface CanonicalBaseDir {
  readonly baseDir: string;
  readonly method: OpenCodeCanonicalizationMethod;
}

// ---------------------------------------------------------------------------
// Path canonicalization (AC3)
// ---------------------------------------------------------------------------

/** `realpathSync` with a deterministic fallback for paths that do not exist. */
function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isInsideWorktreesDir(targetPath: string): boolean {
  return targetPath.split(path.sep).includes(DEFAULT_WORKTREES_DIR);
}

/**
 * The main worktree root of the repository owning `from`, or `null` when `from` is not
 * inside a git repository (or git is unavailable). The first `worktree ...` record of
 * `git worktree list --porcelain` is always the primary checkout.
 */
function resolvePrimaryRepoRoot(from: string): string | null {
  try {
    const out = child_process.execSync('git worktree list --porcelain', {
      cwd: from,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const firstLine = (out.trim().split('\n')[0] || '').trim();
    const match = firstLine.match(/^worktree\s+(.+)$/);
    if (match && match[1]) {
      return safeRealpath(match[1].trim());
    }
  } catch {
    // Not a git repository, or git is not installed.
  }
  return null;
}

/** Walk `<root>/.worktrees/<id>[/...]` up to `<root>` without invoking git. */
function walkOutOfWorktreesDir(targetPath: string): string | null {
  const parts = targetPath.split(path.sep);
  const idx = parts.lastIndexOf(DEFAULT_WORKTREES_DIR);
  if (idx < 0) return null;
  const root = parts.slice(0, idx).join(path.sep);
  return safeRealpath(root || path.sep);
}

/**
 * Resolution order: module realpath -> `git worktree list` main root -> plain path walk.
 * `method: 'none'` means the location could not be proven permanent, so callers MUST
 * copy instead of symlinking.
 */
function resolveCanonicalBaseDir(rawBaseDir: string): CanonicalBaseDir {
  const real = safeRealpath(rawBaseDir);
  if (!isInsideWorktreesDir(real)) {
    return { baseDir: real, method: 'module' };
  }

  const gitRoot = resolvePrimaryRepoRoot(real);
  if (gitRoot && !isInsideWorktreesDir(gitRoot)) {
    return { baseDir: gitRoot, method: 'git-worktree-root' };
  }

  const walked = walkOutOfWorktreesDir(real);
  if (walked && !isInsideWorktreesDir(walked)) {
    return { baseDir: walked, method: 'worktree-path-walk' };
  }

  return { baseDir: real, method: 'none' };
}

// ---------------------------------------------------------------------------
// Filesystem helpers (AC2)
// ---------------------------------------------------------------------------

/**
 * AC2: `lstatSync`, never `existsSync`. `existsSync` follows symlinks and therefore
 * returns `false` for a dangling link, which is precisely the residue that made the
 * old installer silently write *through* the link into a torn-down worktree.
 *
 * Mirrors `git-worktree-manager.ts:769-777` / `:813-824`.
 */
function removeExistingEntry(targetPath: string): boolean {
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isDirectory()) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  }
  fs.unlinkSync(targetPath);
  return true;
}

/** tmp-file + `renameSync`, the proven idiom from `file-project-scaffolder.ts:204-212`. */
function writeFileAtomic(target: string, body: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temp file may never have been created.
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// JSONC helpers (hand-rolled: the repository has zero runtime dependencies)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Blank out line and block comment bodies while preserving every other character (and
 * therefore the total length), so nothing else needs remapping. String literals are
 * respected, so a URL such as `"https://example.com"` is never mistaken for a comment.
 */
function stripJsonComments(raw: string): string {
  const out = raw.split('');
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
      } else {
        out[i] = ' ';
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && raw[i + 1] === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i++;
        inBlockComment = false;
      } else if (ch !== '\n' && ch !== '\r') {
        out[i] = ' ';
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '/' && raw[i + 1] === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i++;
      inLineComment = true;
      continue;
    }

    if (ch === '/' && raw[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i++;
      inBlockComment = true;
    }
  }

  return out.join('');
}

/** Drop `,` that immediately precedes a closing `}` / `]` (JSONC trailing commas). */
function stripTrailingCommas(commentFreeJson: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < commentFreeJson.length; i++) {
    const ch = commentFreeJson[i];

    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out.push(ch);
      continue;
    }

    if (ch === ',') {
      let lookahead = i + 1;
      while (lookahead < commentFreeJson.length && /\s/.test(commentFreeJson[lookahead])) {
        lookahead++;
      }
      const next = commentFreeJson[lookahead];
      if (next === '}' || next === ']') continue;
    }

    out.push(ch);
  }

  return out.join('');
}

function parseJsonc(raw: string): unknown {
  // A UTF-8 BOM (Windows editors write one routinely) makes `JSON.parse` throw on a
  // file that is perfectly valid, and the resulting warning points the user at a
  // nonexistent syntax error. Strip it before the JSONC pass; it is not JSON.
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(stripTrailingCommas(stripJsonComments(withoutBom)));
}

// ---------------------------------------------------------------------------
// Command registration (AC1)
// ---------------------------------------------------------------------------

const DEFAULT_COMMAND_PAYLOAD: OpenCodeCommandPayload = Object.freeze({
  description: OPENCODE_COMMAND_DESCRIPTION,
  template: OPENCODE_COMMAND_TEMPLATE
});

/**
 * Prompt text lives in `integrations/opencode/codeloop-command.json` so the installer
 * carries no hardcoded user-facing copy. The compiled constants are a safety net for a
 * stripped/missing asset rather than the primary source.
 */
function loadCommandPayload(baseDir: string): OpenCodeCommandPayload {
  const assetPath = path.join(baseDir, OPENCODE_COMMAND_ASSET_RELATIVE_PATH);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(assetPath, 'utf8'));
    if (isPlainObject(parsed)) {
      const description = parsed.description;
      const template = parsed.template;
      if (typeof description === 'string' && description.trim() &&
          typeof template === 'string' && template.trim()) {
        return { description, template };
      }
    }
  } catch {
    // Asset missing or unreadable - fall through to the compiled defaults.
  }
  return DEFAULT_COMMAND_PAYLOAD;
}

/**
 * Register `command.codeloop` in the active OpenCode config (AC1).
 *
 * Guarantees, in order of precedence:
 *  1. An unparseable config is NEVER rewritten - the call reports a warning instead.
 *  2. An existing `command.codeloop` entry is left byte-for-byte alone (idempotent).
 *  3. Rewrites go through tmp-file + `renameSync`, and a `.codeloop.bak` snapshot of the
 *     previous bytes is taken first, so the lossy re-serialization (comments) is recoverable.
 */
export function ensureOpenCodeCommandRegistration(
  configDir: string,
  payload: OpenCodeCommandPayload = DEFAULT_COMMAND_PAYLOAD
): OpenCodeCommandRegistrationResult {
  const existing = OPENCODE_CONFIG_FILENAMES
    .map((name) => path.join(configDir, name))
    .find((candidate) => fs.existsSync(candidate));
  const configPath = existing ?? path.join(configDir, OPENCODE_CONFIG_CREATE_FILENAME);

  const entry: Record<string, unknown> = {
    description: payload.description,
    template: payload.template
  };

  if (!fs.existsSync(configPath)) {
    const fresh: Record<string, unknown> = { command: { [OPENCODE_COMMAND_NAME]: entry } };
    fs.mkdirSync(configDir, { recursive: true });
    writeFileAtomic(configPath, `${JSON.stringify(fresh, null, 2)}\n`);
    return { registered: true, alreadyPresent: false, configPath, warning: null };
  }

  const raw = fs.readFileSync(configPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      registered: false,
      alreadyPresent: false,
      configPath,
      warning:
        `Could not parse ${configPath} (${reason}); the /${OPENCODE_COMMAND_NAME} command was not ` +
        'registered and the file was left untouched. Add it by hand: ' +
        `"command": { "${OPENCODE_COMMAND_NAME}": { "description": "${payload.description}" } }`
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      registered: false,
      alreadyPresent: false,
      configPath,
      warning: `${configPath} does not contain a JSON object; the /${OPENCODE_COMMAND_NAME} command was not registered and the file was left untouched.`
    };
  }

  const rawCommand: unknown = parsed.command;
  if (rawCommand !== undefined && rawCommand !== null && !isPlainObject(rawCommand)) {
    return {
      registered: false,
      alreadyPresent: false,
      configPath,
      warning: `${configPath} has a non-object "command" value; the /${OPENCODE_COMMAND_NAME} command was not registered and the file was left untouched.`
    };
  }

  const command: Record<string, unknown> = isPlainObject(rawCommand) ? { ...rawCommand } : {};
  if (Object.prototype.hasOwnProperty.call(command, OPENCODE_COMMAND_NAME)) {
    // Idempotent: existing user-owned entry wins, byte-for-byte.
    return { registered: false, alreadyPresent: true, configPath, warning: null };
  }

  command[OPENCODE_COMMAND_NAME] = entry;
  parsed.command = command;

  // Snapshot before the lossy re-serialization (comments/trailing commas are dropped).
  if (raw.trim().length > 0) {
    fs.writeFileSync(`${configPath}${OPENCODE_CONFIG_BACKUP_SUFFIX}`, raw, 'utf8');
  }
  writeFileAtomic(configPath, `${JSON.stringify(parsed, null, 2)}\n`);

  return { registered: true, alreadyPresent: false, configPath, warning: null };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Best-effort removal of the pre-#218 residue `<home>/.opencode/skills/codeloop.md`,
 * including the dangling symlink it produced once its worktree was torn down.
 */
function removeLegacyFlatSkill(homeDir: string, warnings: string[]): void {
  const legacyPath = path.join(
    homeDir,
    OPENCODE_LEGACY_DIR_NAME,
    'skills',
    OPENCODE_LEGACY_SKILL_FILENAME
  );
  try {
    if (removeExistingEntry(legacyPath)) {
      warnings.push(`Removed legacy residue ${legacyPath} (never scanned by OpenCode).`);
    }
  } catch (err) {
    warnings.push(
      `Could not remove legacy residue ${legacyPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function installOpenCodeIntegration(
  options: OpenCodeInstallOptions = {}
): OpenCodeInstallResult {
  const warnings: string[] = [];
  let degradedReason: string | null = null;

  const rawBaseDir = options.baseDir || path.resolve(__dirname, '..', '..');
  const canonical = resolveCanonicalBaseDir(rawBaseDir);

  // The canonical root wins when it carries the asset; otherwise fall back to the raw
  // module directory before failing with the original "asset not found" diagnostic.
  let baseDir = canonical.baseDir;
  let method = canonical.method;
  let sourcePath = path.join(baseDir, OPENCODE_SKILL_ASSET_RELATIVE_PATH);
  if (!fs.existsSync(sourcePath) && baseDir !== path.resolve(rawBaseDir)) {
    // The canonical root has no asset: the only usable source is the raw (possibly
    // ephemeral) module directory, so the install must degrade to a copy.
    baseDir = path.resolve(rawBaseDir);
    method = 'none';
    sourcePath = path.join(baseDir, OPENCODE_SKILL_ASSET_RELATIVE_PATH);
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`OpenCode integration asset not found at source path: ${sourcePath}`);
  }

  const homeDir = options.homeDir || os.homedir();
  const isGlobal = options.global !== false;
  const configDir = options.configDir
    || (isGlobal
      ? path.join(homeDir, OPENCODE_CONFIG_DIR_NAME, OPENCODE_APP_DIR_NAME)
      // Project-level override: OpenCode also reads `<project>/.opencode`.
      : path.join(process.cwd(), OPENCODE_LEGACY_DIR_NAME));

  const skillsDir = options.targetDir
    || (isGlobal
      ? path.join(configDir, 'skills')
      : path.join(process.cwd(), OPENCODE_LEGACY_DIR_NAME, 'skills'));

  const skillDir = path.join(skillsDir, OPENCODE_SKILL_NAME);
  const installedPath = path.join(skillDir, OPENCODE_SKILL_FILENAME);

  // #339 (item 4): the dry run stops HERE — every write below (`rmSync`,
  // `mkdirSync`, the symlink/copy, the legacy-residue cleanup and the command
  // registration) is skipped. Both target paths are resolved with the SAME
  // helpers the real install uses, so the preview cannot lie about where the
  // files would land. `ensureOpenCodeCommandRegistration`'s existing-config
  // discovery is read-only, so it is mirrored inline.
  if (options.dryRun) {
    const configPath =
      OPENCODE_CONFIG_FILENAMES.map((name) => path.join(configDir, name)).find((candidate) =>
        fs.existsSync(candidate)
      ) ?? path.join(configDir, OPENCODE_CONFIG_CREATE_FILENAME);
    // Same expression the real install uses to decide symlink vs copy (#AC3).
    const wouldSymlink = !(method === 'none' || isInsideWorktreesDir(path.resolve(baseDir)));
    return {
      success: true,
      installedPath,
      sourcePath,
      // A prediction of what the real run would create; nothing was created.
      isSymlink: wouldSymlink,
      skillsDir,
      canonicalBaseDir: baseDir,
      canonicalizationMethod: method,
      commandRegistered: false,
      configPath,
      degradedReason: null,
      warnings: [
        `[dry-run] Nothing was written. The real install would ${wouldSymlink ? 'symlink' : 'copy'} the skill asset and register the /${OPENCODE_COMMAND_NAME} command.`
      ]
    };
  }

  // `force` finally means something: purge the whole skill directory, stale siblings included.
  if (options.force) {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
  fs.mkdirSync(skillDir, { recursive: true });

  // AC2: lstat first so a DANGLING symlink is detected and removed, never written through.
  removeExistingEntry(installedPath);

  // AC3: never bake an ephemeral `.worktrees/<id>` path into a global symlink.
  const ephemeralSource = method === 'none' || isInsideWorktreesDir(path.resolve(baseDir));

  let isSymlink = false;
  if (ephemeralSource) {
    degradedReason =
      `Install source resolves inside ${DEFAULT_WORKTREES_DIR} (ephemeral worktree) and could not ` +
      'be canonicalized to the primary repository root; copied the asset instead of symlinking it.';
    warnings.push(degradedReason);
    fs.copyFileSync(sourcePath, installedPath);
  } else {
    try {
      fs.symlinkSync(sourcePath, installedPath);
      isSymlink = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (!code || !(OPENCODE_SYMLINK_FALLBACK_CODES as readonly string[]).includes(code)) {
        throw new Error(`OpenCode integration install failed at ${installedPath}: ${message}`, { cause: err });
      }
      degradedReason = `Symlink creation failed (${code}): ${message}; installed a copy instead.`;
      warnings.push(degradedReason);
      // Safe now: removeExistingEntry() already ran, so this cannot write THROUGH a stale link.
      fs.copyFileSync(sourcePath, installedPath);
    }
  }

  if (isGlobal && !options.targetDir) {
    removeLegacyFlatSkill(homeDir, warnings);
  }

  let commandRegistered = false;
  let configPath: string | null = null;
  if (options.registerCommand !== false) {
    const registration = ensureOpenCodeCommandRegistration(configDir, loadCommandPayload(baseDir));
    commandRegistered = registration.registered;
    configPath = registration.configPath;
    if (registration.warning) {
      warnings.push(registration.warning);
      if (!degradedReason) degradedReason = registration.warning;
    }
  }

  return {
    success: true,
    installedPath,
    sourcePath,
    isSymlink,
    skillsDir,
    canonicalBaseDir: baseDir,
    canonicalizationMethod: method,
    commandRegistered,
    configPath,
    degradedReason,
    warnings
  };
}
