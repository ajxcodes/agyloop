'use strict';

/**
 * Shared stale-build guard for the codeloop/agyloop launchers (issue #466).
 *
 * `dist/` is git-ignored, so `git pull` refreshes `src/` but not the build. The
 * release path — the commands `sync`, `release`, `commit` PLUS any invocation
 * carrying `--commit-after` — must not run pre-pull logic: it REFUSES before
 * `dist/` is required. Read-only commands keep the warning.
 *
 * Staleness is stamp-first: `npm run build` writes `dist/build-stamp.json`, a
 * SHA-256 of the source tree, and the launcher compares it with the current
 * content. A `dist/` built before the stamp existed falls back to the original
 * mtime rule.
 *
 * This module must never import `dist/`: it is the thing that decides whether
 * `dist/` is safe to load.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NOTICE_STALE_DIST =
  "Notice: src/ contains modifications newer than dist/. Run 'npm run build' to apply updates.";

/** Commands whose body performs git/gh work: a stale build must not run them. */
const RELEASE_PATH_COMMANDS = Object.freeze(['sync', 'release', 'commit']);

/**
 * `--commit-after` is a FLAG, not a command (src/presentation/cli.ts:810-811).
 * It makes ANY invocation release-path: it reaches COMMIT and, because the flag
 * implies `createPr` (:4513, :4788), drafts, commits, pushes and opens the
 * delivery PR. `yolo` alone is deliberately NOT a member: without the flag it
 * pauses at the COMMIT gate and never drafts (src/application/run-lifecycle.ts:1731).
 */
const FLAG_COMMIT_AFTER = '--commit-after';

/** `codeloop release --help` must stay a read-only success. */
const HELP_OR_VERSION_FLAGS = Object.freeze(['--help', '-h', '--version', '-v']);

/**
 * Flags `parseArguments` consumes a VALUE for (src/presentation/cli.ts:846-1079).
 * If this set drifts, `codeloop --workspace /tmp sync` classifies `/tmp` as the
 * command and silently skips the refusal. Update BOTH sides together;
 * tests/stale-dist-refusal.test.ts pins parity against the real parser.
 */
const VALUE_FLAGS = new Set([
  '--reason', '--retry-after', '--base-branch', '--message', '-m', '--message-file',
  '--plan-path', '--plan-dir', '--refute', '--verdict-file', '--review-output',
  '--critique-report', '--report-file', '--deviation-file', '--ack', '--issue',
  '--title', '--type', '--config', '--model', '--workspace', '--workspace-dir'
]);

/**
 * The ONLY `VALUE_FLAGS` entries whose value may be the literal `-` (stdin).
 * Mirrors `parseArguments`: `--critique-report` (src/presentation/cli.ts:960-969),
 * `--report-file` (:973-980) and `--deviation-file` (:988-995) accept `-`;
 * every other value flag rejects it, so the parser pushes `-` as a positional
 * that becomes the command (issue #471).
 */
const STDIN_VALUE_FLAGS = new Set(['--critique-report', '--report-file', '--deviation-file']);

/** Mirrors REGEX_POSITIONAL_ISSUE_ID (src/domain/constants.ts:2374). */
const REGEX_POSITIONAL_ISSUE_ID = /^#?(\d+)$/;

/** The build-time content digest `npm run build` writes inside `dist/`. */
const BUILD_STAMP_RELPATH = 'dist/build-stamp.json';
const BUILD_STAMP_VERSION = 1;
const REGEX_SHA256 = /^[a-f0-9]{64}$/;

/** Every TypeScript file under `src/`, in a stable path order. */
function listSrcFiles(srcDir) {
  const files = [];
  (function scanDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && fullPath.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  })(srcDir);
  return files.sort();
}

/**
 * SHA-256 over the SAME TypeScript set the mtime scan reads: relative path,
 * a NUL separator and the file bytes, in sorted order. Content-addressed, so a
 * preserved-timestamp unpack cannot hide a stale build (issue #492 AC4).
 * Returns `null` when `src/` does not exist.
 */
function computeSrcHash(baseDir) {
  const srcDir = path.join(baseDir, 'src');
  if (!fs.existsSync(srcDir)) {
    return null;
  }
  const hash = crypto.createHash('sha256');
  for (const file of listSrcFiles(srcDir)) {
    hash.update(path.relative(srcDir, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** The parsed stamp, or `null` when absent/malformed/unsupported. */
function readBuildStamp(baseDir) {
  try {
    const stampPath = path.join(baseDir, BUILD_STAMP_RELPATH);
    if (!fs.existsSync(stampPath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (
      !parsed ||
      parsed.version !== BUILD_STAMP_VERSION ||
      typeof parsed.srcHash !== 'string' ||
      !REGEX_SHA256.test(parsed.srcHash)
    ) {
      return null;
    }
    return { version: parsed.version, srcHash: parsed.srcHash };
  } catch (_err) {
    // An unreadable stamp is not proof of freshness: fall back to mtimes.
    return null;
  }
}

/**
 * Write `dist/build-stamp.json` from the current `src/`
 * (bin/write-build-stamp.js, wired as the `postbuild` script).
 */
function writeBuildStamp(baseDir) {
  const srcHash = computeSrcHash(baseDir);
  if (!srcHash) {
    throw new Error('cannot hash src/: the directory is missing');
  }
  const stampPath = path.join(baseDir, BUILD_STAMP_RELPATH);
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(
    stampPath,
    JSON.stringify({ version: BUILD_STAMP_VERSION, srcHash }, null, 2) + '\n'
  );
  return srcHash;
}

function detectStaleDist(baseDir) {
  try {
    const srcDir = path.join(baseDir, 'src');
    const distCliPath = path.join(baseDir, 'dist', 'presentation', 'cli.js');
    if (!fs.existsSync(srcDir) || !fs.existsSync(distCliPath)) {
      return {
        stale: false,
        method: 'absent',
        newestSrcMtime: 0,
        distMtime: null,
        srcHash: null,
        stampSrcHash: null
      };
    }
    const distStat = fs.statSync(distCliPath);
    let newestSrcMtime = 0;
    (function scanDir(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && fullPath.endsWith('.ts')) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > newestSrcMtime) {
            newestSrcMtime = stat.mtimeMs;
          }
        }
      }
    })(srcDir);

    // Issue #492: the stamp is the authority when it exists. It is immune to
    // mtime skew in both directions (extraction order, preserved timestamps).
    const stamp = readBuildStamp(baseDir);
    if (stamp) {
      const srcHash = computeSrcHash(baseDir);
      if (srcHash) {
        return {
          stale: srcHash !== stamp.srcHash,
          method: 'stamp',
          newestSrcMtime,
          distMtime: distStat.mtimeMs,
          srcHash,
          stampSrcHash: stamp.srcHash
        };
      }
    }

    return {
      stale: newestSrcMtime > distStat.mtimeMs,
      method: 'mtime',
      newestSrcMtime,
      distMtime: distStat.mtimeMs,
      srcHash: null,
      stampSrcHash: null
    };
  } catch (_err) {
    // Stat/read errors are not proof of staleness: keep today's graceful ignore.
    return {
      stale: false,
      method: 'error',
      newestSrcMtime: 0,
      distMtime: null,
      srcHash: null,
      stampSrcHash: null
    };
  }
}

/** The warn-only contract the read-only path keeps (issue #466 AC3). */
function checkStaleDist(baseDir) {
  const result = detectStaleDist(baseDir);
  if (result.stale) {
    console.warn(NOTICE_STALE_DIST);
  }
  return result;
}

/**
 * True when `parseArguments` would set `options.commitAfter` (cli.ts:810-811).
 * `--commit-after` is a boolean flag, so no value branch can consume it: every
 * value flag rejects a `-`-prefixed value except the three stdin flags, and
 * those accept only the literal `-`. `--` ends options (cli.ts:1081-1086), so a
 * token after it is a positional, not this flag (issue #492 AC3).
 */
function hasCommitAfter(argv) {
  for (const arg of argv) {
    if (arg === '--') {
      return false;
    }
    if (arg === FLAG_COMMIT_AFTER) {
      return true;
    }
  }
  return false;
}

/**
 * True when `parseArguments` consumes `next` as the VALUE of `flag`.
 * A literal `-` is a value ONLY for the stdin flags (issue #471); every other
 * value flag rejects it, so `-` stays positional.
 */
function consumesValue(flag, next) {
  if (!VALUE_FLAGS.has(flag) || next === undefined) {
    return false;
  }
  return next === '-' ? STDIN_VALUE_FLAGS.has(flag) : !next.startsWith('-');
}

/**
 * The command `parseArguments` would dispatch, without loading `dist/`.
 * Mirrors the positional grammar at src/presentation/cli.ts:1096-1132:
 * `-`-prefixed tokens are flags (skipping a known value, where a literal `-` is
 * a value only for the stdin flags), `--` ends options, a leading `#?<digits>`
 * token is an issue id, the next positional is the command.
 */
function commandFromArgv(argv) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (consumesValue(arg, argv[i + 1])) {
        i++;
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    return null;
  }
  return REGEX_POSITIONAL_ISSUE_ID.test(positional[0])
    ? (positional[1] || null)
    : positional[0];
}

/**
 * Mirrors the parser's end-of-options rule: `--` stops flag scanning, so
 * `codeloop sync -- --help` passes `--help` to `sync` as a positional and is
 * NOT a help request (issue #471).
 */
function wantsHelpOrVersion(argv) {
  for (const arg of argv) {
    if (arg === '--') {
      return false;
    }
    if (HELP_OR_VERSION_FLAGS.includes(arg)) {
      return true;
    }
  }
  return false;
}

/** A git worktree has `.git` as a FILE; a clone has it as a DIRECTORY. Both count. */
function isSourceCheckout(baseDir) {
  return fs.existsSync(path.join(baseDir, '.git'));
}

function isReleasePathCommand(command) {
  return RELEASE_PATH_COMMANDS.includes(command);
}

/**
 * The release path is a git/gh command OR the `--commit-after` flag, whatever
 * the command (issue #492 AC1).
 */
function isReleasePathInvocation(command, commitAfter) {
  return isReleasePathCommand(command) || commitAfter;
}

/**
 * The name the refusal prints. A flag-only invocation has no command, so it
 * names the flag that made it release-path.
 */
function refusalSubject(command, commitAfter) {
  return command || (commitAfter ? FLAG_COMMIT_AFTER : null);
}

function formatStaleDistRefusal(subject, rerun) {
  return (
    "✗ Refusing to run '" + subject + "': src/ contains changes newer than dist/, so the " +
    'compiled CLI is stale and would run pre-change logic.\n' +
    "  Run 'npm run build' first, then re-run 'codeloop " + (rerun || subject) + "'."
  );
}

/**
 * Pure decision. `options.isMain === true` is required: an in-process caller
 * (tests, embedders requiring the launcher for its exports) must never exit.
 */
function evaluateStaleDist(argv, baseDir, options) {
  const staleness = detectStaleDist(baseDir);
  const command = commandFromArgv(argv);
  const commitAfter = hasCommitAfter(argv);
  const releasePath = isReleasePathInvocation(command, commitAfter);
  const sourceCheckout = isSourceCheckout(baseDir);
  const helpOrVersion = wantsHelpOrVersion(argv);
  // Issue #492 AC4: `.git` no longer gates the refusal. The build stamp keeps
  // extracted/installed copies usable; a genuinely stale tree is refused either
  // way.
  const refuse =
    Boolean(options && options.isMain) &&
    staleness.stale &&
    releasePath &&
    !helpOrVersion;
  const subject = refusalSubject(command, commitAfter);
  return Object.assign({}, staleness, {
    command,
    commitAfter,
    releasePath,
    sourceCheckout,
    helpOrVersion,
    refusalSubject: subject,
    refuse,
    message: refuse ? formatStaleDistRefusal(subject, argv.join(' ')) : null
  });
}

module.exports = {
  NOTICE_STALE_DIST,
  RELEASE_PATH_COMMANDS,
  FLAG_COMMIT_AFTER,
  BUILD_STAMP_RELPATH,
  BUILD_STAMP_VERSION,
  VALUE_FLAGS,
  STDIN_VALUE_FLAGS,
  listSrcFiles,
  computeSrcHash,
  readBuildStamp,
  writeBuildStamp,
  detectStaleDist,
  checkStaleDist,
  commandFromArgv,
  hasCommitAfter,
  wantsHelpOrVersion,
  isSourceCheckout,
  isReleasePathCommand,
  isReleasePathInvocation,
  refusalSubject,
  formatStaleDistRefusal,
  evaluateStaleDist
};
