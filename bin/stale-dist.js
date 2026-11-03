'use strict';

/**
 * Shared stale-build guard for the codeloop/agyloop launchers (issue #466).
 *
 * `dist/` is git-ignored, so `git pull` refreshes `src/` but not the build. The
 * release-path commands (`sync`, `release`, `commit`) must not run pre-pull logic:
 * they REFUSE before `dist/` is required. Read-only commands keep the warning.
 *
 * This module must never import `dist/`: it is the thing that decides whether
 * `dist/` is safe to load.
 */
const fs = require('fs');
const path = require('path');

const NOTICE_STALE_DIST =
  "Notice: src/ contains modifications newer than dist/. Run 'npm run build' to apply updates.";

/** Commands whose body performs git/gh work: a stale build must not run them. */
const RELEASE_PATH_COMMANDS = Object.freeze(['sync', 'release', 'commit']);

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

function detectStaleDist(baseDir) {
  try {
    const srcDir = path.join(baseDir, 'src');
    const distCliPath = path.join(baseDir, 'dist', 'presentation', 'cli.js');
    if (!fs.existsSync(srcDir) || !fs.existsSync(distCliPath)) {
      return { stale: false, newestSrcMtime: 0, distMtime: null };
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
    return {
      stale: newestSrcMtime > distStat.mtimeMs,
      newestSrcMtime,
      distMtime: distStat.mtimeMs
    };
  } catch (_err) {
    // Stat/read errors are not proof of staleness: keep today's graceful ignore.
    return { stale: false, newestSrcMtime: 0, distMtime: null };
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

function formatStaleDistRefusal(command) {
  return (
    "✗ Refusing to run '" + command + "': src/ contains changes newer than dist/, so the " +
    'compiled CLI is stale and would run pre-change logic.\n' +
    "  Run 'npm run build' first, then re-run 'codeloop " + command + "'."
  );
}

/**
 * Pure decision. `options.isMain === true` is required: an in-process caller
 * (tests, embedders requiring the launcher for its exports) must never exit.
 */
function evaluateStaleDist(argv, baseDir, options) {
  const staleness = detectStaleDist(baseDir);
  const command = commandFromArgv(argv);
  const releasePath = isReleasePathCommand(command);
  const sourceCheckout = isSourceCheckout(baseDir);
  const helpOrVersion = wantsHelpOrVersion(argv);
  const refuse =
    Boolean(options && options.isMain) &&
    staleness.stale &&
    releasePath &&
    sourceCheckout &&
    !helpOrVersion;
  return Object.assign({}, staleness, {
    command,
    releasePath,
    sourceCheckout,
    helpOrVersion,
    refuse,
    message: refuse ? formatStaleDistRefusal(command) : null
  });
}

module.exports = {
  NOTICE_STALE_DIST,
  RELEASE_PATH_COMMANDS,
  VALUE_FLAGS,
  STDIN_VALUE_FLAGS,
  detectStaleDist,
  checkStaleDist,
  commandFromArgv,
  wantsHelpOrVersion,
  isSourceCheckout,
  isReleasePathCommand,
  formatStaleDistRefusal,
  evaluateStaleDist
};
