/**
 * agyloop - SmokeProtocol Value Object (issue #298)
 *
 * Pure extractor / linter / runner-script builder for a plan's
 * `Manual Smoke Test Protocol`.
 *
 * The protocol is FROZEN at dispatch: the checks extracted here are the ones
 * the gate is told to execute, and a failure is attributed to a check label
 * and a plan line — never "go read the plan and run it".
 *
 * Static rules: quoted-json-comparison, bare-module-path, empty-check,
 * no-executable-check (issue #298), sandbox-path (issue #359 — a check that
 * invokes the CLI must create its directory sandbox where the state guard
 * recognises it) and missing-parent-directory (issue #388 — a check that WRITES
 * a path must create that path's parent first, or it dies before product code).
 *
 * No I/O, no external imports.
 */

import {
  HEADING_MANUAL_SMOKE_TEST_PROTOCOL,
  SMOKE_CHECK_MARKER_PREFIX,
  SMOKE_CHECK_MARKER_SUFFIX,
  SMOKE_RULE_BARE_MODULE_PATH,
  SMOKE_RULE_EMPTY_CHECK,
  SMOKE_RULE_MISSING_PARENT_DIRECTORY,
  SMOKE_RULE_NO_EXECUTABLE_CHECK,
  SMOKE_RULE_QUOTED_JSON_COMPARISON,
  SMOKE_RULE_SANDBOX_PATH,
  SMOKE_SANDBOX_RECOMMENDED_PATH
} from '../constants';
import { isSmokeSectionHeading } from './smoke-heading';
import {
  isAnchoredPath,
  isWithinSmokeSandbox,
  normaliseLexicalPath,
  resolvePathAgainstCwd
} from './smoke-sandbox';

export interface SmokeCheck {
  /** 1-based position within the protocol. */
  readonly index: number;
  readonly label: string;
  /** The fenced body exactly as written. */
  readonly body: string;
  /** 1-based plan line of the opening fence. */
  readonly planLine: number;
}

export interface SmokeFinding {
  readonly rule: string;
  /** 0 when the finding is about the section as a whole. */
  readonly checkIndex: number;
  readonly label: string;
  /** 1-based plan line of the offending text. */
  readonly line: number;
  readonly excerpt: string;
}

export interface SmokeFailure {
  readonly checkIndex: number;
  readonly label: string;
  readonly planLine: number;
  /** The first `FAIL` line of the output, when one was printed. */
  readonly failLine: string | null;
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const HEADING_NUMBER_PREFIX = /^\d+[.)]\s*/;
const FENCE_PREFIX = '```';
const NUMBERED_LABEL = /^\s*\d+[.)]\s+(.*)$/;
const BOLD_LABEL = /^\s*\*\*([^*]+)\*\*\s*:?\s*$/;
/**
 * A scaffold placeholder: a bullet whose entire content is a bold label, e.g.
 * `- **Check 1:**`. The generated plan template emits exactly this shape under
 * `### Manual Smoke Test Protocol` for the documented `codeloop yolo` fast
 * path, which never dispatches the PLANNER. Such a section declares NO
 * protocol, so it must read as NOT DECLARED rather than as a broken protocol.
 */
const PLACEHOLDER_BULLET = /^\s*[-*]\s+\*\*[^*]+\*\*\s*:?\s*$/;
const COMMENT_PREFIX = '#';
const MAX_EXCERPT_LENGTH = 160;

const SHELL_FENCE_LANGUAGES: ReadonlySet<string> = new Set(['', 'bash', 'sh', 'shell', 'console']);

const REQUIRE_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const FROM_PATTERN = /\bfrom\s+['"]([^'"]+)['"]/g;
const RELATIVE_MODULE_EXTENSIONS = /\.(?:js|json|mjs|cjs)$/;
const QUOTED_COMPARISON = /\[\s*"?\$\(.*\)"?\s*={1,2}\s*"[^"]*"\s*\]/;
/**
 * The commands that emit JSON-QUOTED text (issue #327, Defect 1).
 *
 * The old rule was block-scoped: `body.includes('JSON.stringify')` armed the
 * comparison check for EVERY line in the fence, so a fixture-seeding
 * `node -e '…JSON.stringify…'` rejected an unrelated
 * `[ "$(git rev-parse HEAD)" = "$BEFORE" ]`. Attribution is now per command:
 * a comparison is flagged only when the command it compares is one of these.
 *
 * `jq -r` is deliberately NOT a marker — raw output is unquoted text.
 */
const JSON_QUOTING_MARKERS: readonly RegExp[] = Object.freeze([
  /JSON\.stringify/,
  /\bjson\.dumps\b/,
  /\bjson_encode\b/,
  /\bConvertTo-Json\b/i,
  /\bjq\b[^\n]*?(?:^|\s)(?:-c|--compact-output)(?=\s|$)/
]);
const FUNCTION_OPEN = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/;
const FAIL_WORD = /\bFAIL\b/;

const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib'
]);

interface Heading {
  readonly level: number;
  readonly title: string;
}

function detectHeading(line: string): Heading | null {
  const match = HEADING_PATTERN.exec(line.trim());
  if (!match) return null;
  return { level: match[1].length, title: match[2].replace(/#+\s*$/, '').trim() };
}

function stripNumbering(title: string): string {
  return title.replace(HEADING_NUMBER_PREFIX, '').trim();
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith(COMMENT_PREFIX);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_EXCERPT_LENGTH
    ? `${trimmed.slice(0, MAX_EXCERPT_LENGTH)}…`
    : trimmed;
}

function isRelativeOrBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return true;
  }
  return NODE_BUILTINS.has(specifier);
}

function bareModuleSpecifier(line: string): string | null {
  for (const pattern of [REQUIRE_PATTERN, FROM_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const specifier = match[1];
      if (!RELATIVE_MODULE_EXTENSIONS.test(specifier)) continue;
      if (isRelativeOrBuiltinSpecifier(specifier)) continue;
      return specifier;
    }
  }
  return null;
}

export class SmokeProtocol {
  public readonly found: boolean;
  public readonly headingLine: number;
  public readonly checks: readonly SmokeCheck[];
  public readonly findings: readonly SmokeFinding[];

  private constructor(
    found: boolean,
    headingLine: number,
    checks: readonly SmokeCheck[],
    findings: readonly SmokeFinding[]
  ) {
    this.found = found;
    this.headingLine = headingLine;
    this.checks = Object.freeze([...checks]);
    this.findings = Object.freeze([...findings]);
  }

  /** True when the protocol exists and no static rule rejects it. */
  public get executable(): boolean {
    return this.findings.length === 0;
  }

  /** True when a section was declared but contains zero runnable check. */
  public get declared(): boolean {
    return this.found;
  }

  public static empty(): SmokeProtocol {
    return new SmokeProtocol(false, 0, [], []);
  }

  public static fromPlan(markdown: string): SmokeProtocol {
    const lines = (markdown ?? '').split('\n');
    const checks: SmokeCheck[] = [];
    const findings: SmokeFinding[] = [];

    let headingLine = 0;
    let sectionLevel = 0;
    let inSection = false;
    let label = '';
    let fenceLanguage: string | null = null;
    let fenceStartLine = 0;
    let fenceLabel = '';
    let fenceBody: string[] = [];
    // A section only declares a protocol when it carries prose or a fence. The
    // generated scaffold holds nothing but `- **Check 1:**`, which is a
    // placeholder, not a broken protocol — see PLACEHOLDER_BULLET.
    let sawFence = false;
    let sawContent = false;

    const finishFence = (): void => {
      if (fenceLanguage === null) return;
      if (!SHELL_FENCE_LANGUAGES.has(fenceLanguage)) {
        fenceLanguage = null;
        fenceBody = [];
        return;
      }

      const index = checks.length + 1;
      const checkLabel = fenceLabel || `Check ${index}`;
      const body = fenceBody.join('\n');
      checks.push({ index, label: checkLabel, body, planLine: fenceStartLine });
      collectFindings(index, checkLabel, fenceStartLine, fenceBody, findings);

      fenceLanguage = null;
      fenceBody = [];
    };

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const trimmed = line.trim();

      if (fenceLanguage !== null) {
        if (trimmed.startsWith(FENCE_PREFIX)) {
          finishFence();
        } else {
          fenceBody.push(line);
        }
        continue;
      }

      const heading = detectHeading(line);

      if (!inSection) {
        if (heading && isSmokeSectionHeading(heading)) {
          inSection = true;
          headingLine = index + 1;
          sectionLevel = heading.level;
        }
        continue;
      }

      if (heading) {
        if (heading.level <= sectionLevel) break;
        label = stripNumbering(heading.title);
        continue;
      }

      if (trimmed.startsWith(FENCE_PREFIX)) {
        sawFence = true;
        fenceLanguage = trimmed.slice(FENCE_PREFIX.length).trim().toLowerCase();
        fenceStartLine = index + 1;
        fenceLabel = label;
        fenceBody = [];
        continue;
      }

      const numbered = NUMBERED_LABEL.exec(line);
      if (numbered) {
        label = stripNumbering(numbered[1]);
        if (numbered[1].trim().length > 0) sawContent = true;
        continue;
      }
      const bold = BOLD_LABEL.exec(line);
      if (bold) {
        label = bold[1].trim();
        continue;
      }

      if (!isCommentLine(line) && !PLACEHOLDER_BULLET.test(line)) {
        sawContent = true;
      }
    }

    // A section that never closed its last fence still describes a check.
    finishFence();

    // Issue #388: a write whose parent no earlier statement creates dies before
    // any product code runs. Accumulated across checks in protocol order.
    collectMissingParentFindings(checks, findings);

    // `no-executable-check` is reserved for a section that DECLARES a protocol
    // (prose or a fence) but offers nothing runnable. A placeholder-only
    // section — the generated scaffold — is NOT DECLARED: failing it would make
    // the documented `codeloop yolo` fast path (which never dispatches the
    // PLANNER) unable to reach COMMIT.
    if (inSection && checks.length === 0 && (sawFence || sawContent)) {
      findings.push({
        rule: SMOKE_RULE_NO_EXECUTABLE_CHECK,
        checkIndex: 0,
        label: HEADING_MANUAL_SMOKE_TEST_PROTOCOL,
        line: headingLine,
        excerpt: HEADING_MANUAL_SMOKE_TEST_PROTOCOL
      });
    }

    const declared = inSection && (checks.length > 0 || sawFence || sawContent);
    return new SmokeProtocol(declared, headingLine, checks, findings);
  }

  /**
   * Builds the single script the gate executes. `set -e` only: a protocol may
   * legitimately read an optional variable, so `-u` is deliberately absent.
   */
  public toScript(): string | null {
    if (!this.found || this.checks.length === 0) return null;

    const lines: string[] = ['set -e'];
    for (const check of this.checks) {
      lines.push(
        `printf '%s\\n' '${SMOKE_CHECK_MARKER_PREFIX}${check.index}${SMOKE_CHECK_MARKER_SUFFIX}'`
      );
      lines.push(check.body);
      lines.push('');
    }
    return `${lines.join('\n')}\n`;
  }

  /** Attributes a non-zero exit to the last check whose marker was printed. */
  public attributeFailure(combinedOutput: string | null): SmokeFailure | null {
    if (!combinedOutput) return null;

    const markerPattern = new RegExp(
      `${SMOKE_CHECK_MARKER_PREFIX}(\\d+)${SMOKE_CHECK_MARKER_SUFFIX}`,
      'g'
    );
    let lastIndex: number | null = null;
    let match: RegExpExecArray | null;
    while ((match = markerPattern.exec(combinedOutput)) !== null) {
      lastIndex = Number(match[1]);
    }
    if (lastIndex === null) return null;

    const check = this.checks.find((candidate) => candidate.index === lastIndex);
    if (!check) return null;

    const failLine =
      combinedOutput
        .split('\n')
        .map((line) => line.trim())
        .find((line) => FAIL_WORD.test(line)) ?? null;

    return {
      checkIndex: check.index,
      label: check.label,
      planLine: check.planLine,
      failLine
    };
  }
}

/** True when the text routes its output through JSON quoting (issue #327). */
function hasJsonMarker(text: string): boolean {
  return JSON_QUOTING_MARKERS.some((marker) => marker.test(text));
}

/**
 * Extracts the balanced body of every `$( … )` group on a line (issue #327).
 *
 * Single-quoted spans are skipped, so a shell snippet that merely EMBEDS a
 * `$(…)` inside `node -e '…'` is not mistaken for a substitution. Nested
 * substitutions (`$(state "$(cat id)")`) yield both bodies. Returns `[]` when
 * the line's parentheses are unbalanced.
 */
function commandSubstitutions(line: string): string[] {
  const bodies: string[] = [];
  let inSingleQuote = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (char === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (inSingleQuote) continue;
    if (char !== '$' || line[index + 1] !== '(') continue;

    let depth = 1;
    let cursor = index + 2;
    let nestedSingleQuote = false;
    for (; cursor < line.length; cursor++) {
      const inner = line[cursor];
      if (inner === "'") {
        nestedSingleQuote = !nestedSingleQuote;
        continue;
      }
      if (nestedSingleQuote) continue;
      if (inner === '(') {
        depth++;
      } else if (inner === ')') {
        depth--;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) return [];

    bodies.push(line.slice(index + 2, cursor));
    index = cursor;
  }

  // Nested substitutions live inside the bodies just collected.
  return [...bodies, ...bodies.flatMap((body) => commandSubstitutions(body))];
}

/**
 * The shell functions defined in a check whose BODY routes output through JSON
 * quoting (issue #327). Computed once per check, so a comparison that calls one
 * of them is still attributed to the JSON-producing command.
 */
function jsonQuotingFunctions(bodyLines: readonly string[]): Set<string> {
  const functions = new Set<string>();
  let openFunction: string | null = null;

  for (const line of bodyLines) {
    if (openFunction === null) {
      const match = FUNCTION_OPEN.exec(line);
      if (!match) continue;
      openFunction = match[1];
    }

    if (hasJsonMarker(line)) {
      functions.add(openFunction);
    }

    // A line ending in `}` closes the function, covering both the one-line and
    // the multi-line definition shape.
    if (line.trim().endsWith('}')) {
      openFunction = null;
    }
  }

  return functions;
}

/**
 * True only when THIS comparison compares JSON-QUOTED output (issue #327,
 * Defect 1) — not merely because the fence contains a JSON marker somewhere.
 */
function isQuotedJsonComparison(line: string, jsonFunctions: ReadonlySet<string>): boolean {
  if (!QUOTED_COMPARISON.test(line)) return false;
  if (hasJsonMarker(line)) return true;

  for (const body of commandSubstitutions(line)) {
    if (hasJsonMarker(body)) return true;
    const command = body.trim().split(/\s+/)[0] ?? '';
    if (jsonFunctions.has(command.replace(/[;"']/g, ''))) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Issue #359: the `sandbox-path` rule — a check that invokes the CLI must
// create its directory sandbox under `$HOME/.cache/agyloop/smoke-*`, the only
// root the state guard recognises. A purely textual mirror of the guard's
// semantics; no filesystem probing (SmokeProtocol stays I/O-free).
//
// Issue #364: the rule tracks `cd` per check at STATEMENT granularity (see
// `cwdByStatement`), so a RELATIVE
// `mkdir`/`mktemp` under a sandbox `cd` is recognised, while a `..`-escaped
// path that resolves outside the sandbox is refused. The token heuristic is
// retained only for paths no `cd` can anchor.
// ---------------------------------------------------------------------------

/**
 * A codeloop CLI invocation, anchored at the command token: bare
 * (`codeloop transition`), `node <…>/bin/codeloop.js …`, `npx codeloop …`, the
 * deprecated `agyloop` launcher, each optionally prefixed `env [-u AGY_SUBAGENT] …`.
 *
 * Quote-precedence (issue #359, I4) is NOT a property of this pattern: for
 * `"node bin/codeloop.js transition …"` inside a `node -e '…'` fixture-seeding
 * script no match exists (quote characters are absent from the boundary class),
 * but for `"env -u AGY_SUBAGENT node bin/codeloop.js …"` the regex re-anchors at
 * the inner `node` token and the boundary class never sees the quote. Whether a
 * match is a real invocation is therefore decided by POSITION in
 * `invokesCodeloopCli` — see `isProseAt`/`chainStart` (issue #362, F2.2).
 */
const CLI_INVOCATION_PATTERN =
  /(?:^|[\s;&|(=])(?:env\s+(?:(?:-\S+|[\w=]+)\s+)*|npx\s+)?(?:node\s+\S*bin\/(?:codeloop|agyloop)\.js|(?:codeloop|agyloop)(?![\w-]))/;

/** A `g`-flagged copy, so `exec` can iterate every candidate on a line. */
const CLI_INVOCATION_SCAN = new RegExp(CLI_INVOCATION_PATTERN.source, 'g');

/**
 * The `env`/`npx` prefix immediately before a command token, whether or not the
 * prefix is preceded by a quote (issue #362, F2.2). The capture group is the
 * prefix itself, so the caller can recover the exact chain-start offset.
 */
const ENV_CHAIN_TAIL = /(?:^|[\s;&|(='"])((?:env|npx)\s+(?:(?:-\S+|[\w=]+)\s+)*)$/;

/**
 * The temp roots the guard refuses: `/tmp`, `/var/tmp`, `/dev/shm`, `$TMPDIR`.
 * (The guard's recognised ROOT lives in `smoke-sandbox.ts` since #364 — the old
 * textual prefix list here could not see `cd` or `..`.)
 */
const TEMP_ROOT_PATTERN = /(?:^|\/)(?:tmp|var\/tmp|dev\/shm)(?:\/|$)|\$\{?TMPDIR\}?/;
const SMOKE_TOKEN = 'smoke';
const MKTEMP_TOKEN = /\bmktemp\b/;
/**
 * The `mktemp` DIRECTORY mode: `-d`, clustered (`-dt`), parenthesised
 * (`$(mktemp -d)`), or `--tmpdir[=DIR]`. A bare `mktemp` creates a FILE and is
 * never a sandbox (issue #359, I3.2).
 */
const MKTEMP_DIR_FLAG = /(?:^|[\s)])-[a-zA-Z]*d[a-zA-Z]*(?=[\s)'`"]|$)|--tmpdir(?:=\S*)?/;
/** An assignment whose value is path-shaped (issue #359, §2.3.3). */
const PATH_SHAPED_VALUE = /^(?:\/|~|\$HOME|\$\{HOME\}|\$TMPDIR|\$\{TMPDIR\})/;
const ASSIGNMENT_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
/** A statement whose entire text is `cd <target>` (issue #364). */
const CD_STATEMENT = /^cd(?:\s+(.*))?$/;
const QUOTE_CHARS = /["'`]/g;

/** One directory-sandbox creation found on a check-body line. */
interface SandboxCandidate {
  /** 0-based offset of the offending line within the fence body. */
  readonly offset: number;
  /** 0-based index of the STATEMENT on that line that performs the creation. */
  readonly statement: number;
  /** The created path as written (quotes stripped); the line itself for an implicit temp root. */
  readonly createdPath: string;
  /** True when `mktemp -d` names no root: the OS temp dir is implied (I3.3). */
  readonly implicitTemp: boolean;
}

function stripQuotes(text: string): string {
  return text.replace(QUOTE_CHARS, '');
}

/**
 * Removes backslash escapes of quote characters (issue #362, F2.1).
 *
 * A `node -e` fixture seeds plan TEXT as a JS string literal, so a correct
 * sandbox path arrives as `\"$HOME/.cache/agyloop/smoke-…\"`. `stripQuotes`
 * alone left the backslashes behind (`\$HOME/…`), which failed recognition and
 * flagged the plan that documents the rule. Escape-then-strip is the correct
 * order because `\"` in a shell-seeded string IS quote syntax.
 */
function unescapeQuotes(text: string): string {
  return text.replace(/\\(["'`])/g, '$1');
}

/** A path string as written → the path itself (unescaped, unquoted). */
function normalisePathText(text: string): string {
  return stripQuotes(unescapeQuotes(text));
}

function splitShellTokens(line: string): string[] {
  return line.trim().split(/\s+/).filter((token) => token.length > 0);
}

/** Index of the `)` matching the `(` at `openIndex`, or -1 when unbalanced. */
function matchClosingParen(line: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = openIndex; index < line.length; index++) {
    const char = line[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/**
 * True when `target` sits inside a quoted string on `line` — plan TEXT that the
 * shell never executes (issue #362, F2.2; #359 I4).
 *
 * Single quotes are inert. Inside double quotes a `$( … )` or backtick group
 * still EXECUTES, so those regions are not prose — which keeps
 * `OUT="$(codeloop next --json)"` an invocation while
 * `"env -u AGY_SUBAGENT node bin/codeloop.js …"` seeded as data is not.
 * Deleting quoted spans wholesale was rejected: it loses
 * `node "$ROOT/bin/codeloop.js"`, whose binary path is itself quoted.
 */
function isProseAt(line: string, target: number): boolean {
  let index = 0;

  while (index < line.length) {
    const char = line[index];

    if (char === '\\') {
      index += 2;
      continue;
    }

    if (char === "'") {
      const close = line.indexOf("'", index + 1);
      const end = close === -1 ? line.length : close;
      if (target > index && target < end) return true;
      index = end + 1;
      continue;
    }

    if (char === '"') {
      index++;
      while (index < line.length) {
        const inner = line[index];
        if (inner === '\\') {
          if (index === target) return true;
          index += 2;
          continue;
        }
        if (inner === '"') {
          index++;
          break;
        }
        if (inner === '$' && line[index + 1] === '(') {
          const close = matchClosingParen(line, index + 1);
          if (close === -1) return false;
          if (target > index + 1 && target < close) return false;
          index = close + 1;
          continue;
        }
        if (inner === '`') {
          const close = line.indexOf('`', index + 1);
          if (close === -1) return false;
          if (target > index && target < close) return false;
          index = close + 1;
          continue;
        }
        if (index === target) return true;
        index++;
      }
      continue;
    }

    if (char === '`') {
      const close = line.indexOf('`', index + 1);
      if (close === -1) return false;
      // A backtick group is a command substitution: it executes.
      if (target > index && target < close) return false;
      index = close + 1;
      continue;
    }

    if (index === target) return false;
    index++;
  }

  return false;
}

/**
 * The offset of the statement that the matched command token belongs to,
 * including any `env`/`npx` prefix the invocation pattern re-anchored past
 * (issue #362, F2.2). That is the position quote-precedence must be asked
 * about: `"env -u AGY_SUBAGENT node …"` starts inside the quoted span even
 * though the regex matched at the inner `node`.
 */
function chainStart(line: string, tokenStart: number): number {
  const prefix = line.slice(0, tokenStart);
  const match = ENV_CHAIN_TAIL.exec(prefix);
  if (!match) return tokenStart;
  return prefix.length - match[1].length;
}

/**
 * True when a non-comment line invokes the codeloop CLI as a command (I3.1).
 *
 * Every candidate match is classified by POSITION (issue #362, F2.2): an
 * `env`-prefixed chain seeded as quoted text is prose even though the pattern
 * anchored at its inner `node` token, while a real invocation — including
 * `OUT="$(codeloop next --json)"` — still counts.
 */
function invokesCodeloopCli(line: string): boolean {
  if (isCommentLine(line)) return false;

  CLI_INVOCATION_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLI_INVOCATION_SCAN.exec(line)) !== null) {
    // The pattern consumes one boundary character (unless it matched at `^`).
    const tokenStart = match.index + (match.index === 0 ? 0 : 1);
    if (!isProseAt(line, chainStart(line, tokenStart))) return true;
    if (match[0].length === 0) CLI_INVOCATION_SCAN.lastIndex++;
  }

  return false;
}

/** `mktemp -d …` creations: named `-p`/`--tmpdir` root, template, or bare (§2.3.3). */
function mktempCandidates(
  statement: string,
  offset: number,
  statementIndex: number
): SandboxCandidate[] {
  const tokens = splitShellTokens(statement);
  const start = tokens.findIndex((token) => MKTEMP_TOKEN.test(token));
  if (start === -1) return [];
  const command = tokens.slice(start).join(' ');
  if (!MKTEMP_DIR_FLAG.test(command)) return [];

  let root: string | null = null;
  const templates: string[] = [];
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-p') {
      const value = tokens[index + 1];
      if (value !== undefined) {
        root = normalisePathText(value);
        index++;
      }
      continue;
    }
    if (token === '--tmpdir') {
      root = '$TMPDIR';
      continue;
    }
    if (token.startsWith('--tmpdir=')) {
      root = normalisePathText(token.slice('--tmpdir='.length));
      continue;
    }
    if (token.startsWith('-') && token !== '-') continue;
    templates.push(normalisePathText(token));
  }

  if (root !== null) {
    if (templates.length === 0) {
      return [{ offset, statement: statementIndex, createdPath: root, implicitTemp: false }];
    }
    return templates.map((template) => ({
      offset,
      statement: statementIndex,
      // A relative template lands under the named root; an absolute one is
      // itself the created path.
      createdPath: template.startsWith('/') ? template : `${root}/${template}`,
      implicitTemp: false
    }));
  }
  if (templates.length === 0) {
    // `mktemp -d` with no path at all: the implicit OS temp dir (I3.3).
    return [
      {
        offset,
        statement: statementIndex,
        createdPath: statement.trim(),
        implicitTemp: true
      }
    ];
  }
  // A NAMED template is not the implicit OS temp dir (issue #362, F2.4): §2.3.4
  // documents the filter as temp-anchored OR `smoke`-named, so
  // `mktemp -d "$PWD/fixture-XXXXXX"` is an explicit workspace directory and
  // only `implicitTemp` (bare `mktemp -d`) is temp by construction.
  return templates.map((template) => ({
    offset,
    statement: statementIndex,
    createdPath: template,
    implicitTemp: false
  }));
}

/** The first non-flag argument of a `mkdir [-p] …` statement. */
function mkdirCandidate(
  statement: string,
  offset: number,
  statementIndex: number
): SandboxCandidate | null {
  const tokens = splitShellTokens(statement);
  const start = tokens.findIndex((token) => token === 'mkdir');
  if (start === -1) return null;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-m' || token === '--mode') {
      index++;
      continue;
    }
    if (token.startsWith('-')) continue;
    return {
      offset,
      statement: statementIndex,
      createdPath: normalisePathText(token),
      implicitTemp: false
    };
  }
  return null;
}

/** The explicit target directory of `git clone <url> <dir>` — never the 2-arg form. */
function gitCloneCandidate(
  statement: string,
  offset: number,
  statementIndex: number
): SandboxCandidate | null {
  const tokens = splitShellTokens(statement);
  const cloneIndex = tokens.findIndex(
    (token, index) => token === 'clone' && tokens[index - 1] === 'git'
  );
  if (cloneIndex === -1) return null;
  const positional = tokens.slice(cloneIndex + 1).filter((token) => !token.startsWith('-'));
  const target = positional[1];
  if (target === undefined) return null;
  return {
    offset,
    statement: statementIndex,
    createdPath: normalisePathText(target),
    implicitTemp: false
  };
}

/**
 * Splits a line at its top-level `;` and `&&` separators (issue #362, F2.3;
 * `&&` added by #364 so `cd "$SBX" && mkdir -p artifacts/x` yields two
 * statements and the cwd can be tracked). Quote-aware: a separator inside a
 * quoted value is data. `||` is deliberately NOT a separator — `cd A || cd B`
 * is ambiguous, so the cwd stays unknown rather than guessed.
 */
function splitStatements(line: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: string | null = null;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === ';') {
      statements.push(line.slice(start, index));
      start = index + 1;
      continue;
    }
    if (char === '&' && line[index + 1] === '&') {
      statements.push(line.slice(start, index));
      index++;
      start = index + 1;
    }
  }

  statements.push(line.slice(start));
  return statements;
}

/**
 * Every path-shaped assignment in a STATEMENT (`SBX=/tmp/…`,
 * `SBX="$HOME/.cache/agyloop/smoke-x"`).
 *
 * The old single-candidate form read
 * `SANDBOX="$HOME/.cache/agyloop"; mkdir -p "$SANDBOX"; WS="$(mktemp …)"` as ONE
 * assignment whose value swallowed the rest of the line, so the trailing
 * `smoke` token still flagged a correct, runtime-accepted sandbox (#284).
 */
function assignmentCandidates(
  statement: string,
  offset: number,
  statementIndex: number
): SandboxCandidate[] {
  const match = ASSIGNMENT_PATTERN.exec(statement);
  if (!match) return [];
  const value = normalisePathText(match[2].trim());
  if (!PATH_SHAPED_VALUE.test(value)) return [];
  return [{ offset, statement: statementIndex, createdPath: value, implicitTemp: false }];
}

/**
 * The `VAR=<path>` assignments visible at each body line (issue #362, F2.3):
 * cumulative, last assignment wins, only path-shaped values recorded.
 */
function assignmentsByLine(
  bodyLines: readonly string[]
): ReadonlyMap<number, ReadonlyMap<string, string>> {
  const byLine = new Map<number, ReadonlyMap<string, string>>();
  const visible = new Map<string, string>();

  bodyLines.forEach((line, offset) => {
    if (!isCommentLine(line)) {
      for (const statement of splitStatements(line)) {
        const match = ASSIGNMENT_PATTERN.exec(statement);
        if (!match) continue;
        const value = normalisePathText(match[2].trim());
        if (!PATH_SHAPED_VALUE.test(value)) continue;
        visible.set(match[1], value);
      }
    }
    byLine.set(offset, new Map(visible));
  });

  return byLine;
}

/**
 * The `cd <target>` a statement performs, if any (issue #364).
 *
 * @returns `undefined` when the statement is not a `cd`; `null` when the cwd
 *          becomes UNKNOWN (bare `cd`, `cd -`, a subshell/pipeline/backtick
 *          `cd`, or an unresolvable variable) — never guessed; otherwise the
 *          resolved target (still possibly relative).
 */
function cdTarget(
  statement: string,
  assignments: ReadonlyMap<string, string>
): string | null | undefined {
  const trimmed = statement.trim();
  const match = CD_STATEMENT.exec(trimmed);
  if (!match) return undefined;

  // A subshell, backtick, or pipeline `cd` never changes the PARENT's cwd.
  if (trimmed.includes('$(') || trimmed.includes('`') || trimmed.includes('(') || trimmed.includes('|')) {
    return null;
  }

  const rawTarget = (match[1] ?? '').trim();
  if (rawTarget.length === 0) return null;
  // `cd -` and `$OLDPWD` depend on shell history the rule cannot see.
  if (rawTarget === '-' || rawTarget === '$OLDPWD' || rawTarget === '${OLDPWD}' || rawTarget === '~-') {
    return null;
  }

  const resolved = resolveVariables(normalisePathText(rawTarget), assignments);
  if (resolved.trim().length === 0) return null;
  // A variable the rule could not resolve (other than the documented `$HOME`
  // anchor) leaves the cwd unknown rather than guessed.
  if (/\$[A-Za-z_{]/.test(resolved.replace(/\$\{HOME\}|\$HOME/g, ''))) return null;
  return resolved;
}

/**
 * The tracked working directory IN EFFECT BEFORE each statement (issue #364).
 *
 * Keyed `${lineOffset}:${statementIndex}`. Walked once, in statement order: a
 * resolvable `cd` moves the cwd only for the statements that FOLLOW it, so
 * `cd "$SBX" && mkdir -p artifacts/x` judges the mkdir against the sandbox
 * while `mkdir -p artifacts/x && cd "$SBX"` still judges the mkdir against the
 * cwd before the cd (unknown, hence flagged — the mkdir really did run outside
 * the sandbox). The map is per CHECK (one `bodyLines` array), so a `cd` in
 * check 1 can never leak into check 2. The cwd starts UNKNOWN.
 */
function cwdByStatement(
  bodyLines: readonly string[],
  assignments: ReadonlyMap<number, ReadonlyMap<string, string>>
): ReadonlyMap<string, string | null> {
  const byStatement = new Map<string, string | null>();
  let cwd: string | null = null;

  bodyLines.forEach((line, offset) => {
    if (isCommentLine(line)) return;
    splitStatements(line).forEach((statement, index) => {
      byStatement.set(statementKey(offset, index), cwd);
      const target = cdTarget(statement, assignments.get(offset) ?? new Map<string, string>());
      if (target === undefined) return;
      cwd = target === null ? null : resolvePathAgainstCwd(cwd, target);
    });
  });

  return byStatement;
}

/** The key of one statement in a check body: `<line offset>:<statement index>`. */
function statementKey(offset: number, statement: number): string {
  return `${offset}:${statement}`;
}

/** Expands `$NAME`/`${NAME}` from the assignments visible at that line. */
function resolveVariables(text: string, assignments: ReadonlyMap<string, string>): string {
  let resolved = text;

  for (let pass = 0; pass < 5; pass++) {
    const next = resolved.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (whole, braced: string | undefined, plain: string | undefined) => {
        const value = assignments.get(braced ?? plain ?? '');
        return value === undefined ? whole : value;
      }
    );
    if (next === resolved) break;
    resolved = next;
  }

  return resolved;
}

/** Every sandbox-creation candidate of one check body (§2.3.3). */
function sandboxCandidates(bodyLines: readonly string[]): SandboxCandidate[] {
  const candidates: SandboxCandidate[] = [];
  bodyLines.forEach((line, offset) => {
    if (isCommentLine(line)) return;
    // Statement granularity (issue #364 review): the cwd a creation is judged
    // against is the one in effect BEFORE its own statement, so a trailing
    // `&& cd "$SBX"` can no longer launder a mkdir that ran elsewhere.
    splitStatements(line).forEach((statement, statementIndex) => {
      candidates.push(...mktempCandidates(statement, offset, statementIndex));
      for (const candidate of [
        mkdirCandidate(statement, offset, statementIndex),
        gitCloneCandidate(statement, offset, statementIndex)
      ]) {
        if (candidate !== null) candidates.push(candidate);
      }
      candidates.push(...assignmentCandidates(statement, offset, statementIndex));
    });
  });
  return candidates;
}

// ---------------------------------------------------------------------------
// Issue #388: the `missing-parent-directory` rule.
//
// The #382 plan's Smoke 6/7 seeded `.agyloop/tasks/382.json` with a
// `node -e 'fs.writeFileSync(…)'` one-liner but never created `.agyloop/tasks`.
// Every assertion downstream died at the write, and the validator still
// reported `executable: true`, so the gate had to edit the frozen script.
//
// The scan is deliberately CONSERVATIVE and I/O-free:
//
//   - writes are recognised from shell redirections (`>`, `>>`, `&>`), `tee`
//     and a bounded list of literal `node -e` fs calls;
//   - a `path.join(…)` or unresolved `$VAR` path is skipped, never guessed;
//   - heredoc data is skipped, so a plan TEXT seeded inside `node - <<'NODE'`
//     is never mistaken for an executed write;
//   - created directories accumulate in CHECK ORDER (one script, executed in
//     order) while each check keeps its own `cd`/assignment state;
//   - a write under `.agyloop/`, `artifacts/plans/` or `.worktrees/` is
//     exempt after an earlier `codeloop` invocation, because the CLI creates
//     the checkpoint directory, the plan scaffold or the task worktree.
// ---------------------------------------------------------------------------

/** Parents that always exist, so a write into them needs no `mkdir` first. */
const ALWAYS_PRESENT_PARENTS: readonly string[] = Object.freeze(
  ['/tmp', '/var/tmp', '/dev/shm', '$TMPDIR', '$HOME', '$HOME/.cache/agyloop'].map(
    (path) => normaliseLexicalPath(path)
  )
);

/** The paths the `codeloop` CLI creates on its own (issue #388 §2.2). */
const TOOL_SCAFFOLD_MARKERS: readonly string[] = Object.freeze([
  '/.agyloop/',
  '/artifacts/plans/',
  '/.worktrees/'
]);

/** Redirection targets that are not filesystem writes. */
const NON_WRITE_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/1',
  '/dev/fd/2'
]);

/** The `node -e` fs calls whose first argument can be a literal write path. */
const LITERAL_WRITE_CALLS: ReadonlySet<string> = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'createWriteStream',
  'openSync'
]);

const HEREDOC_OPEN = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/;
const NODE_EVAL = /\bnode\s+(?:--eval|-e)\s+'([^']*)'/;

interface WriteTarget {
  /** 0-based offset of the line within the check body. */
  readonly offset: number;
  /** 0-based index of the statement on that line. */
  readonly statement: number;
  /** The path as written (quotes stripped, variables unresolved). */
  readonly path: string;
}

interface CreatedDirectory {
  readonly path: string;
  /** `mkdir -p` guarantees every ancestor; plain `mkdir` guarantees only itself. */
  readonly recursive: boolean;
}

/** The set of body-line offsets that are heredoc DATA (never executed). */
function heredocDataLines(bodyLines: readonly string[]): ReadonlySet<number> {
  const data = new Set<number>();
  let delimiter: string | null = null;
  let indented = false;

  bodyLines.forEach((line, offset) => {
    if (delimiter !== null) {
      const candidate = indented ? line.trim() : line;
      data.add(offset);
      if (candidate === delimiter) delimiter = null;
      return;
    }

    HEREDOC_OPEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HEREDOC_OPEN.exec(line)) !== null) {
      if (!isProseAt(line, match.index)) {
        indented = match[1] === '-';
        delimiter = match[3];
        break;
      }
    }
  });

  return data;
}

/**
 * Offsets of lines that START inside a multi-line shell quote.
 *
 * A common plan shape is `node -e '` followed by a multi-line JS body and a
 * closing `'`. Those body lines are shell STRING DATA, so an arrow function
 * (`=>`) or a regex (`/^…/`) inside them must never be read as a shell
 * redirection. The opening line itself is still scanned: a real write before
 * the quote (`printf x > out.json; node -e '…'`) stays visible.
 */
function quotedContinuationLines(bodyLines: readonly string[]): ReadonlySet<number> {
  const continuation = new Set<number>();
  let quote: string | null = null;

  bodyLines.forEach((line, offset) => {
    if (quote !== null) continuation.add(offset);
    if (isCommentLine(line)) return;

    let index = 0;
    while (index < line.length) {
      const char = line[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (quote === null) {
        if (char === "'" || char === '"' || char === '`') quote = char;
      } else if (char === quote) {
        quote = null;
      }
      index++;
    }
  });

  return continuation;
}

/** True when `text` starts a new JS string literal at `index`. */
function isJsQuote(text: string, index: number): boolean {
  const char = text[index];
  return char === "'" || char === '"' || char === '`';
}

/** The offset just past the JS string literal opened at `start`. */
function skipJsString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index++;
  }
  return text.length;
}

/**
 * Literal write paths in a `node -e` script.
 *
 * The tiny lexer skips JS string literals, so
 * `fs.writeFileSync(".agyloop/tasks/382.json", …)` is found while
 * `const seeded = 'fs.writeFileSync(".agyloop/tasks/x.json", …)'` is not.
 */
function literalWritePaths(script: string): string[] {
  const paths: string[] = [];
  let index = 0;

  while (index < script.length) {
    const char = script[index];
    if (isJsQuote(script, index)) {
      index = skipJsString(script, index);
      continue;
    }
    if (!/[A-Za-z_$]/.test(char)) {
      index++;
      continue;
    }

    let end = index;
    while (end < script.length && /[\w$]/.test(script[end])) end++;
    const name = script.slice(index, end);

    if (LITERAL_WRITE_CALLS.has(name)) {
      let cursor = end;
      while (cursor < script.length && /\s/.test(script[cursor])) cursor++;
      if (script[cursor] === '(') {
        cursor++;
        while (cursor < script.length && /\s/.test(script[cursor])) cursor++;
        const quote = script[cursor];
        if (quote === "'" || quote === '"') {
          const close = skipJsString(script, cursor);
          const literal = script.slice(cursor + 1, close - 1);
          if (literal.length > 0 && !literal.includes('${')) paths.push(literal);
          index = close;
          continue;
        }
      }
    }

    index = end;
  }

  return paths;
}

/** Shell redirection targets on a statement (`>`, `>>`, `&>`). */
function redirectTargets(statement: string, offset: number, statementIndex: number): WriteTarget[] {
  const targets: WriteTarget[] = [];

  for (let index = 0; index < statement.length; index++) {
    if (statement[index] === '\\') {
      index++;
      continue;
    }
    if (statement[index] !== '>') continue;
    if (isProseAt(statement, index)) continue;

    let cursor = index + 1;
    if (statement[cursor] === '&') {
      // `>&1` / `>&2` duplicate a file descriptor; `&>` writes a file.
      if (statement[cursor + 1] !== '>') continue;
      cursor += 2;
    } else if (statement[cursor] === '>') {
      cursor++;
    }

    while (cursor < statement.length && /\s/.test(statement[cursor])) cursor++;
    if (cursor >= statement.length) continue;

    let quote: string | null = null;
    let token = '';
    while (cursor < statement.length) {
      const char = statement[cursor];
      if (quote !== null) {
        if (char === quote) {
          quote = null;
          cursor++;
          continue;
        }
        token += char;
        cursor++;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        cursor++;
        continue;
      }
      if (/\s/.test(char) || char === ';' || char === '&' || char === '|') break;
      token += char;
      cursor++;
    }

    index = cursor - 1;
    const target = token.trim();
    if (target.length === 0) continue;
    if (target.startsWith('&') || NON_WRITE_TARGETS.has(target)) continue;
    targets.push({ offset, statement: statementIndex, path: target });
  }

  return targets;
}

/** `tee [-a] <path> …` targets. */
function teeTargets(statement: string, offset: number, statementIndex: number): WriteTarget[] {
  const tokens = splitShellTokens(statement);
  const start = tokens.findIndex((token) => token === 'tee' || token.endsWith('/tee'));
  if (start === -1) return [];

  const targets: WriteTarget[] = [];
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith('-') && token !== '-') continue;
    const path = normalisePathText(token);
    if (path.length > 0) targets.push({ offset, statement: statementIndex, path });
  }
  return targets;
}

function nodeEvalTargets(statement: string, offset: number, statementIndex: number): WriteTarget[] {
  const match = NODE_EVAL.exec(statement);
  if (match === null) return [];
  return literalWritePaths(match[1]).map((path) => ({ offset, statement: statementIndex, path }));
}

/** Every write target of one statement. */
function writeTargets(statement: string, offset: number, statementIndex: number): WriteTarget[] {
  return [
    ...redirectTargets(statement, offset, statementIndex),
    ...teeTargets(statement, offset, statementIndex),
    ...nodeEvalTargets(statement, offset, statementIndex)
  ];
}

/** Every directory a statement creates: all `mkdir` args, `mktemp -d`, `git clone`. */
function createdDirectories(statement: string, offset: number, statementIndex: number): CreatedDirectory[] {
  const created: CreatedDirectory[] = [];
  const tokens = splitShellTokens(statement);
  const mkdirStart = tokens.findIndex((token) => token === 'mkdir');

  if (mkdirStart !== -1) {
    const recursive = tokens
      .slice(mkdirStart + 1)
      .some((token) => token === '--parents' || /^-[a-zA-Z]*p/.test(token));
    for (let index = mkdirStart + 1; index < tokens.length; index++) {
      const token = tokens[index];
      if (token === '-m' || token === '--mode') {
        index++;
        continue;
      }
      if (token.startsWith('-')) continue;
      const path = normalisePathText(token);
      if (path.length > 0) created.push({ path, recursive });
    }
  }

  for (const candidate of mktempCandidates(statement, offset, statementIndex)) {
    if (candidate.implicitTemp) continue;
    created.push({ path: candidate.createdPath, recursive: true });
  }

  const clone = gitCloneCandidate(statement, offset, statementIndex);
  if (clone !== null) created.push({ path: clone.createdPath, recursive: false });

  return created;
}

/**
 * Resolves a path for coverage comparison. A relative path under an unknown
 * cwd is compared RELATIVE-TO-ITSELF: both the write and the `mkdir` that
 * should cover it are judged the same way, so `mkdir -p .agyloop/tasks` covers
 * `.agyloop/tasks/382.json` even when no `cd` anchors the check.
 */
function resolveComparable(cwd: string | null, path: string): string | null {
  const text = String(path ?? '').trim();
  if (text.length === 0) return null;
  if (isAnchoredPath(text)) return normaliseLexicalPath(text);
  if (cwd === null || cwd.trim().length === 0) return normaliseLexicalPath(text);
  return normaliseLexicalPath(`${cwd}/${text}`);
}

/** The directory containing `path`, or `null` when it has no directory component. */
function parentDirectory(path: string): string | null {
  const normalised = normaliseLexicalPath(path);
  const slash = normalised.lastIndexOf('/');
  if (slash === -1) return null;
  if (slash === 0) return '/';
  return normalised.slice(0, slash);
}

function isAlwaysPresentParent(parent: string): boolean {
  return ALWAYS_PRESENT_PARENTS.includes(normaliseLexicalPath(parent));
}

function isToolScaffolded(
  parent: string,
  cliRoots: ReadonlySet<string>,
  cliInUnknownCwd: boolean
): boolean {
  const padded = `/${normaliseLexicalPath(parent)}/`;
  if (!TOOL_SCAFFOLD_MARKERS.some((marker) => padded.includes(marker))) return false;

  if (isAnchoredPath(parent)) {
    for (const root of cliRoots) {
      if (root.length === 0) continue;
      if (parent === root || parent.startsWith(`${root}/`)) return true;
    }
    return false;
  }
  // A relative parent can only be scaffolded by a CLI that ALSO ran without a
  // tracked cwd — the same relative comparison context.
  return cliInUnknownCwd;
}

/** True when a resolved path still carries a variable the rule cannot resolve. */
function hasUnresolvedVariable(path: string): boolean {
  return /\$[A-Za-z_{]/.test(
    path.replace(/\$\{HOME\}|\$HOME|\$\{TMPDIR\}|\$TMPDIR/g, '')
  );
}

/** Adds a created directory, and every ancestor when the mkdir was recursive. */
function addCreatedDirectory(
  covered: Set<string>,
  directory: CreatedDirectory,
  cwd: string | null,
  assignments: ReadonlyMap<string, string>
): void {
  const resolved = resolveComparable(cwd, resolveVariables(directory.path, assignments));
  if (resolved === null || hasUnresolvedVariable(resolved)) return;

  const segments = resolved.split('/');
  if (!directory.recursive) {
    covered.add(resolved);
    return;
  }
  // `mkdir -p a/b` guarantees `a` as well; never walk above the anchor.
  let prefix = resolved.startsWith('/') ? '' : null;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.length === 0) continue;
    prefix = prefix === null ? segment : `${prefix}/${segment}`;
    if (prefix.length > 0) covered.add(prefix);
  }
}

/**
 * Accumulates created directories and CLI invocations in CHECK ORDER and emits
 * one `missing-parent-directory` finding per offending write line (issue #388).
 *
 * Every write is judged against its OWN path and its OWN `cd`/assignment state;
 * only the set of created directories and the "a CLI ran earlier" flag carry
 * across checks, matching the ONE script `toScript()` builds.
 */
function collectMissingParentFindings(
  checks: readonly SmokeCheck[],
  findings: SmokeFinding[]
): void {
  const covered = new Set<string>();
  const cliRoots = new Set<string>();
  let cliInUnknownCwd = false;

  for (const check of checks) {
    const bodyLines = check.body.split('\n');
    const heredocData = heredocDataLines(bodyLines);
    const quotedContinuation = quotedContinuationLines(bodyLines);
    const assignments = assignmentsByLine(bodyLines);
    const cwds = cwdByStatement(bodyLines, assignments);
    // One finding per offending write LINE, even when a line carries two writes.
    const reportedOffsets = new Set<number>();

    bodyLines.forEach((line, offset) => {
      if (isCommentLine(line) || heredocData.has(offset) || quotedContinuation.has(offset)) return;
      const lineAssignments = assignments.get(offset) ?? new Map<string, string>();

      splitStatements(line).forEach((statement, statementIndex) => {
        const key = statementKey(offset, statementIndex);
        const cwd = cwds.get(key) ?? null;
        const statementInvokesCli = invokesCodeloopCli(statement);

        for (const directory of createdDirectories(statement, offset, statementIndex)) {
          addCreatedDirectory(covered, directory, cwd, lineAssignments);
        }

        for (const target of writeTargets(statement, offset, statementIndex)) {
          const resolved = resolveComparable(cwd, resolveVariables(target.path, lineAssignments));
          if (resolved === null || hasUnresolvedVariable(resolved)) continue;
          const parent = parentDirectory(resolved);
          // No directory component: the write lands in the current directory.
          if (parent === null) continue;
          if (isAlwaysPresentParent(parent)) continue;
          if (covered.has(parent)) continue;
          if (isToolScaffolded(parent, cliRoots, cliInUnknownCwd)) continue;
          if (reportedOffsets.has(offset)) continue;

          reportedOffsets.add(offset);
          findings.push({
            rule: SMOKE_RULE_MISSING_PARENT_DIRECTORY,
            checkIndex: check.index,
            label: check.label,
            line: check.planLine + 1 + offset,
            excerpt: `${truncate(line)} — required parent: ${parent}`
          });
        }

        if (statementInvokesCli) {
          // The CLI creates `.agyloop/`, the plan scaffold and the task worktree
          // in ITS OWN sandbox — never in a sibling sandbox a later check uses.
          if (cwd === null) cliInUnknownCwd = true;
          else cliRoots.add(normaliseLexicalPath(cwd));
        }
      });
    });
  }
}

function collectFindings(
  checkIndex: number,
  label: string,
  fenceStartLine: number,
  bodyLines: readonly string[],
  findings: SmokeFinding[]
): void {
  const hasExecutableLine = bodyLines.some((line) => !isCommentLine(line));
  if (!hasExecutableLine) {
    findings.push({
      rule: SMOKE_RULE_EMPTY_CHECK,
      checkIndex,
      label,
      line: fenceStartLine,
      excerpt: truncate(label)
    });
    return;
  }

  // The function set is per CHECK, not per fence-wide substring search.
  const jsonFunctions = jsonQuotingFunctions(bodyLines);

  bodyLines.forEach((line, offset) => {
    const lineNumber = fenceStartLine + 1 + offset;
    const trimmed = line.trim();
    if (isCommentLine(line)) return;

    if (isQuotedJsonComparison(line, jsonFunctions)) {
      findings.push({
        rule: SMOKE_RULE_QUOTED_JSON_COMPARISON,
        checkIndex,
        label,
        line: lineNumber,
        excerpt: truncate(trimmed)
      });
    }

    const bareSpecifier = bareModuleSpecifier(line);
    if (bareSpecifier !== null) {
      findings.push({
        rule: SMOKE_RULE_BARE_MODULE_PATH,
        checkIndex,
        label,
        line: lineNumber,
        excerpt: truncate(trimmed)
      });
    }
  });

  // Issue #359, §2.3: a check that invokes the CLI must sandbox where the
  // state guard recognises it. One finding per offending line (I2: the
  // analysis never taints a sibling check that does not invoke the CLI).
  if (bodyLines.some((line) => invokesCodeloopCli(line))) {
    // Issue #362, F2.3: variables visible at the candidate's line are resolved
    // BEFORE both tests, so `mktemp -d "$SANDBOX/smoke-…"` (the #284 shape) is
    // recognised — while a variable that resolves onto `/tmp` is still
    // flagged, because resolution cannot launder a temp root.
    //
    // Issue #364: the cwd is tracked per check, so a RELATIVE path under a
    // sandbox `cd` is recognised (#354 shape) and a `..`-escaped path that
    // resolves outside the sandbox is refused. A path no `cd` can anchor keeps
    // the token heuristic (SP15: a bare relative `artifacts/smoke359` stays
    // flagged).
    const assignments = assignmentsByLine(bodyLines);
    const cwds = cwdByStatement(bodyLines, assignments);
    const flaggedOffsets = new Set<number>();
    for (const candidate of sandboxCandidates(bodyLines)) {
      if (flaggedOffsets.has(candidate.offset)) continue;
      const resolved = resolveVariables(
        candidate.createdPath,
        assignments.get(candidate.offset) ?? new Map<string, string>()
      );
      const cwdBefore = cwds.get(statementKey(candidate.offset, candidate.statement)) ?? null;
      const absolute = resolvePathAgainstCwd(cwdBefore, resolved);
      if (absolute !== null && isWithinSmokeSandbox(absolute)) continue;
      const display = absolute ?? resolved;
      const offending =
        candidate.implicitTemp || TEMP_ROOT_PATTERN.test(display) || display.includes(SMOKE_TOKEN);
      if (!offending) continue;
      flaggedOffsets.add(candidate.offset);
      // The required path rides in `excerpt` AFTER truncation, so the 160-char
      // cap can never cut it.
      findings.push({
        rule: SMOKE_RULE_SANDBOX_PATH,
        checkIndex,
        label,
        line: fenceStartLine + 1 + candidate.offset,
        excerpt: `${truncate(bodyLines[candidate.offset])} — required sandbox: ${SMOKE_SANDBOX_RECOMMENDED_PATH}`
      });
    }
  }
}
