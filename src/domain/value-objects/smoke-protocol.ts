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
 * No I/O, no external imports.
 */

import {
  HEADING_MANUAL_SMOKE_TEST_PROTOCOL,
  SMOKE_CHECK_MARKER_PREFIX,
  SMOKE_CHECK_MARKER_SUFFIX,
  SMOKE_RULE_BARE_MODULE_PATH,
  SMOKE_RULE_EMPTY_CHECK,
  SMOKE_RULE_NO_EXECUTABLE_CHECK,
  SMOKE_RULE_QUOTED_JSON_COMPARISON
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
const JSON_QUOTING_HELPER = 'JSON.stringify';
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

  const body = bodyLines.join('\n');
  const usesJsonQuoting = body.includes(JSON_QUOTING_HELPER);

  bodyLines.forEach((line, offset) => {
    const lineNumber = fenceStartLine + 1 + offset;
    const trimmed = line.trim();
    if (isCommentLine(line)) return;

    if (usesJsonQuoting && QUOTED_COMPARISON.test(line)) {
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
}
