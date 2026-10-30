/**
 * agyloop - QualityGateTargets parser (issue #298, revised by #369)
 *
 * Pure parser for the approved plan's verification section. It extracts the
 * commands the gate MUST execute, in plan order, and returns everything that
 * looked like verification but was not executable as `unparsed` evidence — an
 * unparsed line is NEVER executed.
 *
 * Static rule (issue #348, narrowed by #369): `committed-tree-assertion` — the
 * gate runs in the task worktree against the UNCOMMITTED change, before the
 * commit gate, so a command that ASSERTS the worktree or the index matches HEAD
 * (`git diff --exit-code`, `git diff --quiet`) can never pass there. Listing
 * forms (`git diff --stat`, `git status --porcelain`) exit 0 and are allowed.
 * Such a target is REFUSED at plan approval, never silently filtered.
 *
 * A declared entry the parser cannot execute is a typed `rejection` (issue
 * #369): it is refused at approval, never silently dropped into auto-detect.
 *
 * No I/O, no external imports: regex and string operations only.
 */

import {
  GATE_TARGET_RULE_COMMITTED_TREE_ASSERTION,
  GATE_TARGET_RULE_UNEXECUTABLE_TARGET,
  GATE_TARGET_RULE_WORKFLOW_LINT_MISSING,
  HEADING_MANUAL_SMOKE_TEST_PROTOCOL,
  MAX_SHELL_WRAPPER_DEPTH,
  MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION,
  MSG_GATE_TARGET_UNEXECUTABLE_ENTRY,
  MSG_GATE_TARGET_WORKFLOW_LINT_MISSING,
  PLAN_TARGET_HEADING_CANDIDATES
} from '../constants';

/** One executable target: the command and the plan line it was written on. */
export interface QualityGateTarget {
  readonly command: string;
  /** 1-based plan line (the FIRST line of a `\` continuation). */
  readonly line: number;
}

/** Why a declared entry could not be turned into an executable command (#369). */
export type GateTargetRejectionReason =
  /** `;`, `|`, backticks or `$(` — never inferred into an execution plan. */
  | 'compound-syntax'
  /** The first token is not a known runner and is not path-like. */
  | 'unrecognized-command'
  /** An unterminated `\` continuation. */
  | 'incomplete-continuation';

/** A declared entry that was classified as a command and then rejected (#369). */
export interface GateTargetRejection {
  /** The line as written (bullets and inline-code markers removed). */
  readonly entry: string;
  /** 1-based plan line. */
  readonly line: number;
  readonly reason: GateTargetRejectionReason;
}

export interface QualityGateTargetsResult {
  /** Deduplicated targets in plan order, with their plan line (issue #348). */
  readonly targets: readonly QualityGateTarget[];
  /** Executable commands in plan order (deduplicated). Equivalent to `targets.map(t => t.command)`. */
  readonly commands: readonly string[];
  /** Section lines that were not executable (prose, tables, rejected shapes). */
  readonly unparsed: readonly string[];
  /**
   * The actionable subset of `unparsed` (issue #369): a line that was
   * classified as a command and then refused. NEVER silently dropped.
   */
  readonly rejections: readonly GateTargetRejection[];
  /** True when the section exists AND yielded at least one executable target. */
  readonly found: boolean;
  /** 1-based line of the section heading, or 0 when absent. */
  readonly sectionLine: number;
}

/** The static-rule vocabulary one finding may carry (#348, #369). */
export type GateTargetRule =
  | typeof GATE_TARGET_RULE_COMMITTED_TREE_ASSERTION
  | typeof GATE_TARGET_RULE_UNEXECUTABLE_TARGET
  | typeof GATE_TARGET_RULE_WORKFLOW_LINT_MISSING;

/** A static-rule finding against one parsed target or rejected entry. */
export interface GateTargetFinding {
  readonly rule: GateTargetRule;
  /** 1-based position within `targets` (matches `Plan Target <n>`); 0 for rejections. */
  readonly index: number;
  readonly line: number;
  readonly command: string;
  /** Rule-specific evidence: the rejection reason, the affected files, … */
  readonly detail?: string;
}

/**
 * The first token a verification line may start with. Anything else is either
 * prose (reported as `unparsed`) or a refused entry (reported as a rejection,
 * #369). Path-like first tokens are accepted separately.
 */
const COMMAND_FIRST_TOKENS: ReadonlySet<string> = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'node',
  'git',
  'make',
  'go',
  'cargo',
  'pytest',
  'python',
  'python3',
  'dotnet',
  'mvn',
  'mvnw',
  'gradle',
  './gradlew',
  './mvnw',
  'act',
  'docker',
  'podman',
  'bash',
  'sh',
  'eslint',
  'tsc',
  'bin/agyloop',
  'codeloop',
  'agyloop',
  // Polyglot runners (#369, was #372): a declared target outside the old
  // allowlist is now executed, not silently dropped into auto-detect.
  'uv',
  'uvx',
  'poetry',
  'pipenv',
  'tox',
  'nox',
  'php',
  'composer',
  'deno',
  'bundle',
  'rake',
  'rspec',
  'mix',
  'swift',
  'flutter',
  'just',
  'bazel',
  'turbo',
  'nx',
  'tsx',
  'ts-node',
  'vitest',
  'jest',
  'mocha',
  'playwright'
]);

/** A `NAME=value` prefix accepted by `env`. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Prefixes that run their remainder unchanged. */
const TRANSPARENT_PREFIXES: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time'
]);

/** Shells whose `-c` argument is itself a command. */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'dash',
  'zsh',
  'ksh',
  'fish'
]);

/** Options that consume the FOLLOWING token as their value. */
const PREFIX_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir'
]);

/** A shell flag carrying `-c` (alone or combined, e.g. `-lc` / `-ec`). */
const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

/** First token of an intended command entry (not structural prose, #369). */
const COMMAND_ENTRY_PATTERN = /^[A-Za-z0-9_./~][A-Za-z0-9_./~-]*/;

/** Fence languages whose bodies are harvested as commands. */
const COMMAND_FENCE_LANGUAGES: ReadonlySet<string> = new Set([
  '',
  'bash',
  'sh',
  'shell',
  'console'
]);

const FENCE_PREFIX = '```';
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const HEADING_NUMBER_PREFIX = /^\d+[.)]\s*/;
const BULLET_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BOLD_LABEL = /^\*\*[^*]+\*\*\s*:?\s*/;
const TRAILING_COMMENT = /\s+#.*$/;
const SHELL_PROMPT = /^\$\s+/;

/** A `\` at the end of a fenced line continues the command on the next line. */
const FENCE_CONTINUATION = /\\\s*$/;

/** One inline-code span; a bullet made only of spans is a command bullet. */
const INLINE_CODE_SPAN = /`[^`]+`/g;

/**
 * What may remain after every inline-code span is removed for the line to be
 * "the whole line is the command": separators only, never a trailing clause.
 */
const INLINE_CODE_SEPARATORS = /^[\s,&:]*$/;

/** Joins several inline-code commands of one bullet into an ordered chain. */
const SPAN_CHAIN_SEPARATOR = ' && ';

/** A sentence-shaped tail (`exits 0.`) means the line is prose, not a command. */
const SENTENCE_TERMINATOR = /[.!?]$/;

/**
 * Words that only appear in prose acceptance criteria, never in an executable
 * verification command. A bare (non-backticked) bullet containing one is
 * evidence, not a target.
 */
const PROSE_CUE_WORDS: ReadonlySet<string> = new Set([
  'exit',
  'exits',
  'must',
  'should',
  'passes',
  'passing',
  'fails',
  'failing',
  'warning',
  'warnings',
  'green',
  'skipped'
]);

interface Heading {
  readonly level: number;
  readonly title: string;
}

function normalizeTitle(raw: string): string {
  const withoutClosingHashes = raw.replace(/#+\s*$/, '').trim();
  const withoutNumbering = withoutClosingHashes.replace(HEADING_NUMBER_PREFIX, '').trim();
  return withoutNumbering.replace(/:\s*$/, '').trim().toLowerCase();
}

function detectHeading(line: string): Heading | null {
  const match = HEADING_PATTERN.exec(line.trim());
  if (!match) return null;
  return { level: match[1].length, title: normalizeTitle(match[2]) };
}

const TARGET_HEADINGS: ReadonlySet<string> = new Set(
  PLAN_TARGET_HEADING_CANDIDATES.map((heading) => normalizeTitle(heading))
);

function isSmokeHeading(title: string): boolean {
  return title.includes(normalizeTitle(HEADING_MANUAL_SMOKE_TEST_PROTOCOL));
}

/** Strips list markers, labels, prompts and comments from a fenced line. */
function cleanFenceLine(raw: string): string {
  let candidate = raw.trim();
  candidate = candidate.replace(SHELL_PROMPT, '');
  const wrapped = /^`([^`]+)`$/.exec(candidate);
  if (wrapped) candidate = wrapped[1].trim();
  candidate = candidate.replace(TRAILING_COMMENT, '');
  return candidate.trim();
}

type BulletCandidate =
  | { readonly kind: 'command'; readonly text: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unparsed' };

/**
 * Classifies a non-fenced section line (usually a bullet).
 *
 * A line is a command ONLY when the whole line is the command. Two shapes are
 * accepted:
 *
 *   - `- \`npm run lint\`` / `- \`npm run build\`, \`npm test\`` — inline-code
 *     spans, with nothing but separators outside them.
 *   - `- npm run lint` — the whole bullet, with no sentence-shaped tail.
 *
 * Anything with a trailing prose clause (`` - `npm run lint` exits 0. ``) is
 * `unparsed` evidence and is NEVER executed.
 */
function classifyBulletLine(raw: string): BulletCandidate {
  let candidate = raw.trim();
  candidate = candidate.replace(BULLET_MARKER, '');
  candidate = candidate.replace(BOLD_LABEL, '');
  candidate = candidate.replace(TRAILING_COMMENT, '');
  candidate = candidate.replace(SHELL_PROMPT, '').trim();

  if (candidate.length === 0) return { kind: 'empty' };

  const spans = candidate.match(INLINE_CODE_SPAN);
  if (spans && spans.length > 0) {
    const remainder = candidate.replace(INLINE_CODE_SPAN, '');
    if (!INLINE_CODE_SEPARATORS.test(remainder)) return { kind: 'unparsed' };
    const commands = spans.map((span) => span.slice(1, -1).trim());
    if (commands.some((command) => command.length === 0)) return { kind: 'unparsed' };
    return { kind: 'command', text: commands.join(SPAN_CHAIN_SEPARATOR) };
  }

  if (SENTENCE_TERMINATOR.test(candidate)) return { kind: 'unparsed' };
  const words = candidate.toLowerCase().split(/\s+/);
  if (words.some((word) => PROSE_CUE_WORDS.has(word))) return { kind: 'unparsed' };

  return { kind: 'command', text: candidate };
}

/** Splits on `&&` only outside single/double quotes. */
function splitAndChain(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '&' && command[i + 1] === '&') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Splits a command into words, honouring single and double quotes and
 * backslash escapes outside single quotes (#369).
 */
export function tokenizeShellWords(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && i + 1 < command.length) {
        current += command[++i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (char === '\\' && i + 1 < command.length) {
      current += command[++i];
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

/**
 * Unwraps transparent prefixes (`env`, `command`, `exec`, `nohup`, `time`) and
 * shell `-c` wrappers so a wrapped assertion is classified exactly like the
 * bare command (#369).
 *
 * Past `MAX_SHELL_WRAPPER_DEPTH` the wrapper is opaque: the tokens are returned
 * as-is and are therefore NOT classified as an assertion.
 */
export function unwrapShellPrefix(tokens: readonly string[], depth = 0): string[] {
  if (tokens.length === 0) return [];
  if (depth > MAX_SHELL_WRAPPER_DEPTH) return [...tokens];

  const [head, ...rest] = tokens;

  if (TRANSPARENT_PREFIXES.has(head)) {
    let i = 0;
    while (i < rest.length) {
      const token = rest[i];
      if (token === '--') {
        i += 1;
        break;
      }
      if (PREFIX_OPTIONS_WITH_VALUE.has(token)) {
        i += 2;
        continue;
      }
      if (token.startsWith('-')) {
        i += 1;
        continue;
      }
      if (head === 'env' && ENV_ASSIGNMENT.test(token)) {
        i += 1;
        continue;
      }
      break;
    }
    return unwrapShellPrefix(rest.slice(i), depth + 1);
  }

  if (SHELL_WRAPPERS.has(head)) {
    let i = 0;
    let hasCommandFlag = false;
    while (i < rest.length) {
      const token = rest[i];
      if (token === '--') {
        i += 1;
        continue;
      }
      if (!token.startsWith('-')) break;
      if (SHELL_COMMAND_FLAG.test(token)) hasCommandFlag = true;
      i += 1;
    }
    if (!hasCommandFlag || i >= rest.length) return [...tokens];
    const script = rest.slice(i).join(' ');
    return unwrapShellPrefix(tokenizeShellWords(script), depth + 1);
  }

  return [...tokens];
}

/**
 * True when the line looks like an INTENDED command entry rather than
 * structural prose (#369): a Markdown table row, a blockquote or a horizontal
 * rule is evidence, never a dropped target.
 */
function looksLikeCommandEntry(candidate: string): boolean {
  const text = candidate.trim();
  if (text.length === 0) return false;
  if (text.startsWith('|') || text.startsWith('>')) return false;
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) return false;
  return COMMAND_ENTRY_PATTERN.test(text);
}

function isAllowedFirstToken(command: string): boolean {
  if (command.startsWith('./')) return true;
  // #369: transparent prefixes and shell wrappers are unwrapped first, so
  // `env git diff …` / `bash -c 'npm test'` are classified by the command they
  // actually run. An unknown command behind a wrapper is still a rejection.
  const first = unwrapShellPrefix(tokenizeShellWords(command))[0];
  if (first === undefined || first.length === 0) return false;
  if (COMMAND_FIRST_TOKENS.has(first)) return true;
  // Path-like binaries: `node_modules/.bin/tsc`, `vendor/bin/phpunit`,
  // `/usr/local/bin/make` (#369, was #372).
  return first.includes('/');
}

type CommandResolution =
  | { readonly commands: readonly string[] }
  | { readonly rejection: GateTargetRejectionReason };

/**
 * Returns the individual commands of a candidate line, or the reason the line
 * cannot be executed as written (#369).
 */
function toCommands(candidate: string): CommandResolution | null {
  if (candidate.length === 0) return null;
  // Compound shell syntax is never inferred into an execution plan.
  if (/[;|`]/.test(candidate) || candidate.includes('$(')) {
    return { rejection: 'compound-syntax' };
  }

  const parts = splitAndChain(candidate);
  if (parts.length === 0) return null;
  if (parts.some((part) => !isAllowedFirstToken(part))) {
    return { rejection: 'unrecognized-command' };
  }
  return { commands: parts };
}

/**
 * Parses the plan's Quality Gate Targets section.
 *
 * Collection stops at the next heading of the same or higher level, and always
 * at any Manual Smoke Test Protocol heading.
 *
 * Fenced lines are commands (a `\` continuation joins the following lines into
 * ONE target, so a multi-line `node --test` invocation is never truncated).
 * Bullets are commands only when the whole line is the command.
 */
export function parseQualityGateTargets(markdown: string): QualityGateTargetsResult {
  const lines = (markdown ?? '').split('\n');
  const targets: QualityGateTarget[] = [];
  const unparsed: string[] = [];
  const rejections: GateTargetRejection[] = [];
  const seen = new Set<string>();

  let sectionLine = 0;
  let sectionLevel = 0;
  let inSection = false;
  let inCommandFence = false;
  let fenceLanguage: string | null = null;
  let pendingContinuation: { text: string; line: number } | null = null;

  const pushUnparsed = (raw: string): void => {
    const evidence = raw.trim();
    if (evidence.length > 0) unparsed.push(evidence);
  };

  /**
   * Records a refused entry ONLY when the line was an intended command (#369).
   * Structural prose stays evidence-only, so a plan's own decision table is
   * never mistaken for a dropped target.
   */
  const pushRejection = (
    candidate: string,
    line: number,
    reason: GateTargetRejectionReason
  ): void => {
    if (!looksLikeCommandEntry(candidate)) return;
    rejections.push({ entry: candidate.trim(), line, reason });
  };

  const pushCommands = (candidate: string, raw: string, line: number): void => {
    if (candidate.length === 0) return;
    const resolved = toCommands(candidate);
    if (resolved === null) return;
    if ('rejection' in resolved) {
      pushUnparsed(raw);
      pushRejection(candidate, line, resolved.rejection);
      return;
    }
    for (const command of resolved.commands) {
      if (seen.has(command)) continue;
      seen.add(command);
      targets.push({ command, line });
    }
  };

  /** An unterminated `\` continuation is incomplete: evidence, never execution. */
  const flushContinuation = (): void => {
    if (pendingContinuation === null) return;
    pushUnparsed(pendingContinuation.text);
    pushRejection(pendingContinuation.text, pendingContinuation.line, 'incomplete-continuation');
    pendingContinuation = null;
  };

  const pushFenceLine = (raw: string, line: number): void => {
    const trimmed = raw.trim();
    // A blank line or a shell comment ends a pending continuation: joining
    // across it would invent a command the plan never wrote.
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      flushContinuation();
      return;
    }

    const joined =
      pendingContinuation === null ? trimmed : `${pendingContinuation.text} ${trimmed}`;
    // A continuation reports the line it STARTED on, not where it ended.
    const joinedLine = pendingContinuation === null ? line : pendingContinuation.line;

    if (FENCE_CONTINUATION.test(joined)) {
      pendingContinuation = { text: joined.replace(FENCE_CONTINUATION, '').trimEnd(), line: joinedLine };
      return;
    }

    pendingContinuation = null;
    pushCommands(cleanFenceLine(joined), joined, joinedLine);
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    // Fence tracking comes FIRST: a shell comment inside a fenced block looks
    // like a Markdown heading and must not terminate the section.
    if (fenceLanguage !== null) {
      if (trimmed.startsWith(FENCE_PREFIX)) {
        flushContinuation();
        fenceLanguage = null;
        inCommandFence = false;
      } else if (inSection && inCommandFence) {
        pushFenceLine(line, index + 1);
      }
      continue;
    }

    if (trimmed.startsWith(FENCE_PREFIX)) {
      fenceLanguage = trimmed.slice(FENCE_PREFIX.length).trim().toLowerCase();
      inCommandFence = inSection && COMMAND_FENCE_LANGUAGES.has(fenceLanguage);
      continue;
    }

    const heading = detectHeading(line);

    if (!inSection) {
      if (heading && TARGET_HEADINGS.has(heading.title)) {
        inSection = true;
        sectionLine = index + 1;
        sectionLevel = heading.level;
      }
      continue;
    }

    if (heading) {
      if (isSmokeHeading(heading.title)) {
        break;
      }
      // #369: a deeper heading that is ITSELF a target heading re-anchors the
      // section, so the most specific declaration wins and a following
      // same-level subheading ends collection instead of swallowing the rest.
      if (TARGET_HEADINGS.has(heading.title) && heading.level > sectionLevel) {
        sectionLine = index + 1;
        sectionLevel = heading.level;
        continue;
      }
      if (heading.level <= sectionLevel) {
        break;
      }
      // A deeper structural heading inside the section is not a target.
      continue;
    }

    if (trimmed.length === 0) continue;

    const bullet = classifyBulletLine(line);
    if (bullet.kind === 'empty') continue;
    if (bullet.kind === 'unparsed') {
      pushUnparsed(line);
      continue;
    }
    pushCommands(bullet.text, line, index + 1);
  }

  flushContinuation();

  return {
    targets,
    commands: targets.map((target) => target.command),
    unparsed,
    rejections,
    found: targets.length > 0,
    sectionLine
  };
}

/** Git global options that consume the FOLLOWING token as their value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--exec-path',
  '--super-prefix'
]);

/** The git subcommand and its arguments, skipping global options. */
function gitSubcommand(tokens: readonly string[]): { subcommand: string; args: string[] } | null {
  if (tokens[0] !== 'git') return null;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith('-')) {
      i += 1;
      continue;
    }
    return { subcommand: token, args: tokens.slice(i + 1) };
  }
  return null;
}

/**
 * The #369 decision table: a target is refused iff it is a `git diff` that
 * ASSERTS there is no difference (`--exit-code` / `--quiet`) over the worktree
 * or the index. Everything else is a listing and exits 0 on a dirty tree.
 *
 * | Shape | Verdict | Rationale |
 * |---|---|---|
 * | `git diff`, `--stat`, `--check`, `--name-only HEAD` | allowed | listing |
 * | `git status [--porcelain]` | allowed | status is a listing |
 * | `git diff HEAD` | allowed | one-revision listing |
 * | `git diff --cached [--stat]` | allowed | index listing |
 * | `git diff --exit-code` / `--quiet` | REFUSED | assertion vs worktree |
 * | `git diff HEAD --exit-code` | REFUSED | one-revision assertion |
 * | `git diff --cached --exit-code` | REFUSED | index assertion |
 * | `git diff HEAD~1 HEAD --exit-code` | allowed | committed pair only |
 * | `git diff --no-index a b --exit-code` | allowed | file-to-file |
 * | `git log` / `git diff-tree` | allowed | not a worktree diff |
 *
 * Exported name and signature are unchanged (#348 compatibility).
 */
export function isCommittedTreeAssertion(command: string): boolean {
  const parsed = gitSubcommand(unwrapShellPrefix(tokenizeShellWords(command.trim())));
  if (parsed === null) return false;
  // `status` is a listing: it exits 0 on a dirty tree.
  if (parsed.subcommand !== 'diff') return false;

  const args = parsed.args;
  // File-to-file comparison: no worktree, no index.
  if (args.includes('--no-index')) return false;
  // A listing (`--stat`, `--name-only`, `--cached` alone) exits 0.
  const asserts = args.includes('--exit-code') || args.includes('--quiet');
  if (!asserts) return false;

  const separator = args.indexOf('--');
  const before = separator === -1 ? args : args.slice(0, separator);
  const revisions = before.filter((token) => !token.startsWith('-'));
  // A two-commit range (`A..B`, `A...B`) never looks at the worktree.
  if (revisions.some((revision) => revision.includes('..'))) return false;
  // Zero or one revision: the assertion involves the worktree/index.
  return revisions.length < 2;
}

/** Lints the targets the gate will actually execute (one rule, issue #348). */
export function lintQualityGateTargets(
  targets: readonly QualityGateTarget[]
): readonly GateTargetFinding[] {
  const findings: GateTargetFinding[] = [];
  targets.forEach((target, idx) => {
    if (!isCommittedTreeAssertion(target.command)) return;
    findings.push({
      rule: GATE_TARGET_RULE_COMMITTED_TREE_ASSERTION,
      index: idx + 1,
      line: target.line,
      command: target.command
    });
  });
  return findings;
}

/**
 * Lints the entries the parser REFUSED (#369): the consumer that makes a
 * rejection a refusal instead of a silent fall-through to auto-detect.
 */
export function lintGateTargetRejections(
  result: Pick<QualityGateTargetsResult, 'rejections'>
): readonly GateTargetFinding[] {
  return result.rejections.map((rejection) => ({
    rule: GATE_TARGET_RULE_UNEXECUTABLE_TARGET,
    index: 0,
    line: rejection.line,
    command: rejection.entry,
    detail: rejection.reason
  }));
}

/**
 * Renders every finding through ONE formatter (issue #348, R6; #369).
 *
 * Shared by approval rejection, the dispatch blocker and the in-process gate
 * preflight, so their messages cannot drift.
 */
export function formatGateTargetContractViolations(
  findings: readonly GateTargetFinding[]
): string {
  return findings
    .map((finding) => {
      switch (finding.rule) {
        case GATE_TARGET_RULE_UNEXECUTABLE_TARGET:
          return MSG_GATE_TARGET_UNEXECUTABLE_ENTRY.replace('{line}', String(finding.line))
            .replace('{command}', finding.command)
            .replace('{detail}', finding.detail ?? 'unexecutable');
        case GATE_TARGET_RULE_WORKFLOW_LINT_MISSING:
          return MSG_GATE_TARGET_WORKFLOW_LINT_MISSING.replace(
            '{detail}',
            finding.detail ?? '(unknown files)'
          ).replace('{command}', finding.command);
        default:
          return MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION.replace(
            '{index}',
            String(finding.index)
          )
            .replace('{line}', String(finding.line))
            .replace('{command}', finding.command);
      }
    })
    .join(' ');
}
