/**
 * agyloop - QualityGateTargets parser (issue #298)
 *
 * Pure parser for the approved plan's verification section. It extracts the
 * commands the gate MUST execute, in plan order, and returns everything that
 * looked like verification but was not executable as `unparsed` evidence — an
 * unparsed line is NEVER executed.
 *
 * Static rule (issue #348): `committed-tree-assertion` — the gate runs in the
 * task worktree against the UNCOMMITTED change, before the commit gate, so a
 * command that compares the worktree or the index to HEAD (`git diff`, `git
 * status`) can never pass there. Such a target is REFUSED at plan approval,
 * never silently filtered.
 *
 * No I/O, no external imports: regex and string operations only.
 */

import {
  GATE_TARGET_RULE_COMMITTED_TREE_ASSERTION,
  HEADING_MANUAL_SMOKE_TEST_PROTOCOL,
  MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION,
  PLAN_TARGET_HEADING_CANDIDATES
} from '../constants';

/** One executable target: the command and the plan line it was written on. */
export interface QualityGateTarget {
  readonly command: string;
  /** 1-based plan line (the FIRST line of a `\` continuation). */
  readonly line: number;
}

export interface QualityGateTargetsResult {
  /** Deduplicated targets in plan order, with their plan line (issue #348). */
  readonly targets: readonly QualityGateTarget[];
  /** Executable commands in plan order (deduplicated). Equivalent to `targets.map(t => t.command)`. */
  readonly commands: readonly string[];
  /** Section lines that were not executable (prose, tables, rejected shapes). */
  readonly unparsed: readonly string[];
  /** True when the section exists AND yielded at least one executable target. */
  readonly found: boolean;
  /** 1-based line of the section heading, or 0 when absent. */
  readonly sectionLine: number;
}

/** A static-rule finding against one parsed target (issue #348). */
export interface GateTargetFinding {
  readonly rule: typeof GATE_TARGET_RULE_COMMITTED_TREE_ASSERTION;
  /** 1-based position within `targets` (matches `Plan Target <n>`). */
  readonly index: number;
  readonly line: number;
  readonly command: string;
}

/**
 * The first token a verification line may start with. Anything else is prose
 * and is reported as `unparsed` instead of being executed.
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
  'agyloop'
]);

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

function isAllowedFirstToken(command: string): boolean {
  if (command.startsWith('./')) return true;
  const first = command.split(/\s+/)[0];
  return COMMAND_FIRST_TOKENS.has(first);
}

/**
 * Returns the individual commands of a candidate line, or null when the line
 * is not safely executable as written.
 */
function toCommands(candidate: string): string[] | null {
  if (candidate.length === 0) return null;
  // Compound shell syntax is never inferred into an execution plan.
  if (/[;|`]/.test(candidate)) return null;
  if (candidate.includes('$(')) return null;

  const parts = splitAndChain(candidate);
  if (parts.length === 0) return null;
  if (parts.some((part) => !isAllowedFirstToken(part))) return null;
  return parts;
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

  const pushCommands = (candidate: string, raw: string, line: number): void => {
    if (candidate.length === 0) return;
    const resolved = toCommands(candidate);
    if (resolved === null) {
      pushUnparsed(raw);
      return;
    }
    for (const command of resolved) {
      if (seen.has(command)) continue;
      seen.add(command);
      targets.push({ command, line });
    }
  };

  /** An unterminated `\` continuation is incomplete: evidence, never execution. */
  const flushContinuation = (): void => {
    if (pendingContinuation === null) return;
    pushUnparsed(pendingContinuation.text);
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
      if (isSmokeHeading(heading.title) || heading.level <= sectionLevel) {
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
function gitSubcommand(tokens: string[]): { subcommand: string; args: string[] } | null {
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
 * True when a command compares the worktree or the index to HEAD (issue #348).
 *
 * Pure and textual: the gate runs before the commit, so such a comparison
 * always sees the change under test and can never pass on a correct tree.
 */
export function isCommittedTreeAssertion(command: string): boolean {
  const parsed = gitSubcommand(command.trim().split(/\s+/));
  if (parsed === null) return false;
  // `git status` is always worktree/index-relative.
  if (parsed.subcommand === 'status') return true;
  // `diff-tree`, `log`, `show` are commit-based and are legitimate.
  if (parsed.subcommand !== 'diff') return false;

  const args = parsed.args;
  // File-to-file comparison: no worktree, no index.
  if (args.includes('--no-index')) return false;
  if (args.includes('--cached') || args.includes('--staged')) return true;

  const separator = args.indexOf('--');
  const before = separator === -1 ? args : args.slice(0, separator);
  const revisions = before.filter((token) => !token.startsWith('-'));
  // A two-commit range (`A..B`, `A...B`) never looks at the worktree.
  if (revisions.some((revision) => revision.includes('..'))) return false;
  // Zero or one revision: the comparison involves the worktree/index.
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
 * Renders every finding through ONE template (issue #348, R6).
 *
 * Shared by approval rejection, the dispatch blocker and the in-process gate
 * preflight, so their messages cannot drift.
 */
export function formatGateTargetContractViolations(
  findings: readonly GateTargetFinding[]
): string {
  return findings
    .map((finding) =>
      MSG_GATE_TARGET_COMMITTED_TREE_ASSERTION.replace('{index}', String(finding.index))
        .replace('{line}', String(finding.line))
        .replace('{command}', finding.command)
    )
    .join(' ');
}
