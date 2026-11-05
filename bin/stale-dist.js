'use strict';

/**
 * Shared stale-build guard for the codeloop/agyloop launchers (issue #466).
 *
 * `dist/` is git-ignored, so `git pull` refreshes `src/` but not the build. The
 * write path — the release path (`sync`, `release`, `commit`, any
 * `--commit-after`) PLUS the other git/gh-writing command families (`abort`,
 * `triage <action>`, `worktree clean|remove|rm`, issue #497) — must not run
 * pre-pull logic: it REFUSES before `dist/` is required. Read-only commands
 * keep the warning.
 *
 * A missing `dist/presentation/cli.js` on a source checkout is `buildRequired`
 * (issue #474): nothing can load, so every non-help invocation refuses with the
 * `npm run build` diagnostic and `--help`/`--version` print `STATIC_USAGE`.
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
 * Other command FAMILIES whose body performs git/gh work yet are not on the
 * delivery path (issue #497). `triage` and `worktree` are only writing for some
 * sub-actions, so the sets below decide that — the family alone is not enough.
 */
const STALE_UNSAFE_WRITE_COMMANDS = Object.freeze(['abort', 'triage', 'worktree']);

/** `triage` actions that route the lifecycle and write to GitHub (issue #497). */
const TRIAGE_WRITE_ACTIONS = Object.freeze([
  'implement',
  'plan',
  'discovery',
  'completed',
  'dismiss'
]);

/**
 * `worktree` subcommands that remove or relocate worktrees (issue #497).
 * `list` and `prune` stay runnable: AC6 names `prune` explicitly, and both
 * remain read-only enough for a stale build to report what it sees.
 */
const WORKTREE_WRITE_SUBCOMMANDS = Object.freeze(['clean', 'remove', 'rm']);

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
    if (!fs.existsSync(srcDir)) {
      return {
        stale: false,
        buildRequired: false,
        method: 'absent',
        newestSrcMtime: 0,
        distMtime: null,
        srcHash: null,
        stampSrcHash: null
      };
    }
    if (!fs.existsSync(distCliPath)) {
      // Issue #474: a source checkout without a build cannot load anything.
      // This is a DISTINCT state from staleness: refusing it must say
      // "build it", not "your build is older than your source".
      return {
        stale: false,
        buildRequired: true,
        method: 'missing-dist',
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
          buildRequired: false,
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
      buildRequired: false,
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
      buildRequired: false,
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
 * The positional arguments `parseArguments` would see, without loading `dist/`.
 * Mirrors the positional grammar at src/presentation/cli.ts:1081-1099:
 * `-`-prefixed tokens are flags (skipping a known value, where a literal `-` is
 * a value only for the stdin flags), `--` ends options.
 */
function positionalsFromArgv(argv) {
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
  return positional;
}

/**
 * The command `parseArguments` would dispatch, without loading `dist/`.
 * Mirrors the positional grammar at src/presentation/cli.ts:1102-1113:
 * a leading `#?<digits>` token is an issue id, the next positional is the
 * command.
 */
function commandFromArgv(argv) {
  const positional = positionalsFromArgv(argv);
  if (positional.length === 0) {
    return null;
  }
  return REGEX_POSITIONAL_ISSUE_ID.test(positional[0])
    ? (positional[1] || null)
    : positional[0];
}

/**
 * The sub-action `parseArguments` would record, without loading `dist/`
 * (src/presentation/cli.ts:1118-1128): the lowercased `triage` action, the
 * lowercased `worktree` subcommand (`list` when omitted), or `null`.
 *
 * Issue #497: the family token alone cannot decide whether an invocation
 * writes — `triage` list mode and `worktree prune` must stay runnable.
 */
function subcommandFromArgv(argv) {
  const positional = positionalsFromArgv(argv);
  if (positional.length === 0) {
    return null;
  }
  const cmdIndex = REGEX_POSITIONAL_ISSUE_ID.test(positional[0]) ? 1 : 0;
  if (cmdIndex >= positional.length) {
    return null;
  }
  const command = positional[cmdIndex];
  const raw = positional[cmdIndex + 1];
  if (command === 'triage') {
    return raw === undefined ? null : raw.toLowerCase();
  }
  if (command === 'worktree') {
    return raw === undefined ? 'list' : raw.toLowerCase();
  }
  return null;
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
 * True when this FAMILY writes, at this sub-action (issue #497). The family
 * sets name the commands; the sub-action filter keeps `triage` list mode,
 * `triage --help`, `worktree list` and `worktree prune` runnable.
 */
function isUnsafeWriteInvocation(command, subcommand) {
  if (!STALE_UNSAFE_WRITE_COMMANDS.includes(command)) {
    return false;
  }
  if (command === 'triage') {
    return subcommand !== null && TRIAGE_WRITE_ACTIONS.includes(subcommand);
  }
  if (command === 'worktree') {
    return WORKTREE_WRITE_SUBCOMMANDS.includes(subcommand);
  }
  // `abort` always halts subagents, clears locks and quarantines worktrees.
  return true;
}

/**
 * The name the refusal prints. A refused sub-action names its action
 * (`triage dismiss`, `worktree clean`); a flag-only invocation names the flag
 * that made it release-path.
 */
function refusalSubject(command, commitAfter, subcommand) {
  if (subcommand && isUnsafeWriteInvocation(command, subcommand)) {
    return `${command} ${subcommand}`;
  }
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
 * Issue #474: nothing can load when `dist/presentation/cli.js` is missing, so
 * the diagnostic says exactly that and names the build command.
 */
function formatBuildRequiredRefusal(subject, rerun) {
  return (
    "✗ Refusing to run '" + subject + "': dist/presentation/cli.js is missing, so the " +
    'compiled CLI cannot be loaded.\n' +
    "  Run 'npm run build' first, then re-run 'codeloop " + (rerun || subject) + "'."
  );
}

/**
 * Issue #474 AC2: `--help`/`--version` must stay useful with no build at all.
 * This block must not require `dist/` — it is pure text.
 */
const STATIC_USAGE = [
  'Usage: codeloop <command> [options]',
  '',
  'The compiled CLI is not built yet: dist/presentation/cli.js is missing.',
  "  Run 'npm run build' first to enable every command.",
  '',
  'Commands: plan, implement, yolo, next, status, sync, release, commit,',
  '          triage, worktree, abort, resume, transition, reset',
  '',
  "Run 'npm run build' and then 'codeloop --help' for the full reference."
].join('\n');

/**
 * Pure decision. `options.isMain === true` is required: an in-process caller
 * (tests, embedders requiring the launcher for its exports) must never exit.
 */
function evaluateStaleDist(argv, baseDir, options) {
  const staleness = detectStaleDist(baseDir);
  const command = commandFromArgv(argv);
  const subcommand = subcommandFromArgv(argv);
  const commitAfter = hasCommitAfter(argv);
  const releasePath = isReleasePathInvocation(command, commitAfter);
  const unsafeWrite = isUnsafeWriteInvocation(command, subcommand);
  const writePath = releasePath || unsafeWrite;
  const sourceCheckout = isSourceCheckout(baseDir);
  const helpOrVersion = wantsHelpOrVersion(argv);
  // Issue #492 AC4: `.git` no longer gates the refusal. The build stamp keeps
  // extracted/installed copies usable; a genuinely stale tree is refused either
  // way.
  //
  // Issue #474: a missing build refuses EVERY command (nothing can load), while
  // help/version bypass the refusal and print STATIC_USAGE at the launcher.
  // Issue #497: `writePath` widens the stale refusal beyond the delivery path.
  const refuse =
    Boolean(options && options.isMain) &&
    !helpOrVersion &&
    (staleness.buildRequired === true || (staleness.stale && writePath));
  const subject = refusalSubject(command, commitAfter, subcommand) || 'codeloop';
  let message = null;
  if (refuse) {
    message = staleness.buildRequired
      ? formatBuildRequiredRefusal(subject, argv.join(' '))
      : formatStaleDistRefusal(subject, argv.join(' '));
  }
  return Object.assign({}, staleness, {
    command,
    subcommand,
    commitAfter,
    releasePath,
    unsafeWrite,
    writePath,
    sourceCheckout,
    helpOrVersion,
    refusalSubject: subject,
    refuse,
    message
  });
}

module.exports = {
  NOTICE_STALE_DIST,
  RELEASE_PATH_COMMANDS,
  STALE_UNSAFE_WRITE_COMMANDS,
  TRIAGE_WRITE_ACTIONS,
  WORKTREE_WRITE_SUBCOMMANDS,
  FLAG_COMMIT_AFTER,
  BUILD_STAMP_RELPATH,
  BUILD_STAMP_VERSION,
  VALUE_FLAGS,
  STDIN_VALUE_FLAGS,
  STATIC_USAGE,
  listSrcFiles,
  computeSrcHash,
  readBuildStamp,
  writeBuildStamp,
  detectStaleDist,
  checkStaleDist,
  positionalsFromArgv,
  commandFromArgv,
  subcommandFromArgv,
  hasCommitAfter,
  wantsHelpOrVersion,
  isSourceCheckout,
  isReleasePathCommand,
  isReleasePathInvocation,
  isUnsafeWriteInvocation,
  refusalSubject,
  formatStaleDistRefusal,
  formatBuildRequiredRefusal,
  evaluateStaleDist
};
