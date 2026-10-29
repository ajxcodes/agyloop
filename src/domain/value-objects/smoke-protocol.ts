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
 * no-executable-check (issue #298) and sandbox-path (issue #359 — a check that
 * invokes the CLI must create its directory sandbox where the state guard
 * recognises it).
 *
 * No I/O, no external imports.
 */

import {
  HEADING_MANUAL_SMOKE_TEST_PROTOCOL,
  SMOKE_CHECK_MARKER_PREFIX,
  SMOKE_CHECK_MARKER_SUFFIX,
  SMOKE_RULE_BARE_MODULE_PATH,
  SMOKE_RULE_EMPTY_CHECK,
  SMOKE_RULE_NO_EXECUTABLE_CHECK,
  SMOKE_RULE_QUOTED_JSON_COMPARISON,
  SMOKE_RULE_SANDBOX_PATH,
  SMOKE_SANDBOX_DIR_PREFIX,
  SMOKE_SANDBOX_HOME_ANCHOR,
  SMOKE_SANDBOX_RECOMMENDED_PATH,
  SMOKE_SANDBOX_ROOT_DISPLAY
} from '../constants';

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

function isSmokeHeading(title: string): boolean {
  return title
    .toLowerCase()
    .includes(HEADING_MANUAL_SMOKE_TEST_PROTOCOL.toLowerCase());
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
        if (heading && isSmokeHeading(heading.title)) {
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
// ---------------------------------------------------------------------------

/**
 * A codeloop CLI invocation, anchored at the command token: bare
 * (`codeloop transition`), `node <…>/bin/codeloop.js …`, `npx codeloop …`, the
 * deprecated `agyloop` launcher, each optionally prefixed `env [-u AGY_SUBAGENT] …`.
 *
 * Quote-precedence (issue #359, I4) is built into the boundary: a command
 * token immediately preceded by a quote character — `"node bin/codeloop.js
 * transition …"` inside a `node -e '…'` fixture-seeding script — is prose, not
 * an invocation, so a check that seeds plan TEXT never trips the rule it tests.
 * Quote characters are deliberately absent from the boundary class.
 */
const CLI_INVOCATION_PATTERN =
  /(?:^|[\s;&|(=])(?:env\s+(?:(?:-\S+|[\w=]+)\s+)*|npx\s+)?(?:node\s+\S*bin\/(?:codeloop|agyloop)\.js|(?:codeloop|agyloop)(?![\w-]))/;

/** The guard's recognised root in its three anchor spellings (I5, textual). */
const RECOGNISED_SANDBOX_PREFIXES: readonly string[] = Object.freeze([
  `${SMOKE_SANDBOX_ROOT_DISPLAY}/${SMOKE_SANDBOX_DIR_PREFIX}`,
  `${SMOKE_SANDBOX_ROOT_DISPLAY.replace(SMOKE_SANDBOX_HOME_ANCHOR, '${HOME}')}/${SMOKE_SANDBOX_DIR_PREFIX}`,
  `${SMOKE_SANDBOX_ROOT_DISPLAY.replace(SMOKE_SANDBOX_HOME_ANCHOR, '~')}/${SMOKE_SANDBOX_DIR_PREFIX}`
]);

/** The temp roots the guard refuses: `/tmp`, `/var/tmp`, `/dev/shm`, `$TMPDIR`. */
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
const QUOTE_CHARS = /["'`]/g;

/** One directory-sandbox creation found on a check-body line. */
interface SandboxCandidate {
  /** 0-based offset of the offending line within the fence body. */
  readonly offset: number;
  /** The created path as written (quotes stripped); the line itself for an implicit temp root. */
  readonly createdPath: string;
  /** True when `mktemp -d` names no root: the OS temp dir is implied (I3.3). */
  readonly implicitTemp: boolean;
}

function stripQuotes(text: string): string {
  return text.replace(QUOTE_CHARS, '');
}

function splitShellTokens(line: string): string[] {
  return line.trim().split(/\s+/).filter((token) => token.length > 0);
}

/** True when a non-comment line invokes the codeloop CLI as a command (I3.1). */
function invokesCodeloopCli(line: string): boolean {
  if (isCommentLine(line)) return false;
  return CLI_INVOCATION_PATTERN.test(line);
}

/** `mktemp -d …` creations: named `-p`/`--tmpdir` root, template, or bare (§2.3.3). */
function mktempCandidates(line: string, offset: number): SandboxCandidate[] {
  const tokens = splitShellTokens(line);
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
        root = stripQuotes(value);
        index++;
      }
      continue;
    }
    if (token === '--tmpdir') {
      root = '$TMPDIR';
      continue;
    }
    if (token.startsWith('--tmpdir=')) {
      root = stripQuotes(token.slice('--tmpdir='.length));
      continue;
    }
    if (token.startsWith('-') && token !== '-') continue;
    templates.push(stripQuotes(token));
  }

  if (root !== null) {
    if (templates.length === 0) {
      return [{ offset, createdPath: root, implicitTemp: false }];
    }
    return templates.map((template) => ({
      offset,
      // A relative template lands under the named root; an absolute one is
      // itself the created path.
      createdPath: template.startsWith('/') ? template : `${root}/${template}`,
      implicitTemp: false
    }));
  }
  if (templates.length === 0) {
    // `mktemp -d` with no path at all: the implicit OS temp dir (I3.3).
    return [{ offset, createdPath: line.trim(), implicitTemp: true }];
  }
  return templates.map((template) => ({ offset, createdPath: template, implicitTemp: true }));
}

/** The first non-flag argument of a `mkdir [-p] …` line. */
function mkdirCandidate(line: string, offset: number): SandboxCandidate | null {
  const tokens = splitShellTokens(line);
  const start = tokens.findIndex((token) => token === 'mkdir');
  if (start === -1) return null;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-m' || token === '--mode') {
      index++;
      continue;
    }
    if (token.startsWith('-')) continue;
    return { offset, createdPath: stripQuotes(token), implicitTemp: false };
  }
  return null;
}

/** The explicit target directory of `git clone <url> <dir>` — never the 2-arg form. */
function gitCloneCandidate(line: string, offset: number): SandboxCandidate | null {
  const tokens = splitShellTokens(line);
  const cloneIndex = tokens.findIndex(
    (token, index) => token === 'clone' && tokens[index - 1] === 'git'
  );
  if (cloneIndex === -1) return null;
  const positional = tokens.slice(cloneIndex + 1).filter((token) => !token.startsWith('-'));
  const target = positional[1];
  if (target === undefined) return null;
  return { offset, createdPath: stripQuotes(target), implicitTemp: false };
}

/** A path-shaped assignment (`SBX=/tmp/…`, `SBX="$HOME/.cache/agyloop/smoke-x"`). */
function assignmentCandidate(line: string, offset: number): SandboxCandidate | null {
  const match = ASSIGNMENT_PATTERN.exec(line);
  if (!match) return null;
  const value = stripQuotes(match[2].trim());
  if (!PATH_SHAPED_VALUE.test(value)) return null;
  return { offset, createdPath: value, implicitTemp: false };
}

/** Every sandbox-creation candidate of one check body (§2.3.3). */
function sandboxCandidates(bodyLines: readonly string[]): SandboxCandidate[] {
  const candidates: SandboxCandidate[] = [];
  bodyLines.forEach((line, offset) => {
    if (isCommentLine(line)) return;
    candidates.push(...mktempCandidates(line, offset));
    for (const candidate of [
      mkdirCandidate(line, offset),
      gitCloneCandidate(line, offset),
      assignmentCandidate(line, offset)
    ]) {
      if (candidate !== null) candidates.push(candidate);
    }
  });
  return candidates;
}

/** True when the path is textually the guard's own sandbox (I5, no I/O). */
function isRecognisedSandboxPath(text: string): boolean {
  const path = stripQuotes(text);
  return RECOGNISED_SANDBOX_PREFIXES.some((prefix) => path.startsWith(prefix));
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
    const flaggedOffsets = new Set<number>();
    for (const candidate of sandboxCandidates(bodyLines)) {
      if (flaggedOffsets.has(candidate.offset)) continue;
      if (isRecognisedSandboxPath(candidate.createdPath)) continue;
      const offending =
        candidate.implicitTemp ||
        TEMP_ROOT_PATTERN.test(candidate.createdPath) ||
        candidate.createdPath.includes(SMOKE_TOKEN);
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
