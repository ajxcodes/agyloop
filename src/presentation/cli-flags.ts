/**
 * agyloop - CLI flag vocabulary and command capability policy (issue #248)
 *
 * ONE table for the parser diagnostics, the capability gate, the help text and
 * the contract tests. The defect this module exists to stop is drift: the CLI
 * parsed a flag globally and then decided per call site whether to forward it,
 * and a token it did not recognise was silently dropped (`else if
 * (!arg.startsWith('-'))` with no terminal branch). A misspelled `--dry-runn`
 * therefore became "no --dry-run at all", and the command mutated anyway.
 *
 * Deliberately presentation-local and dependency-free: it declares the shape of
 * the invocation STRUCTURALLY (`CapabilitySubject`) instead of importing
 * `CliOptions` from `cli.ts`, which would be a circular import.
 */

import {
  COMMAND_IMPLEMENT,
  COMMAND_PLAN,
  COMMAND_YOLO,
  FLAG_COMMIT_AFTER,
  FLAG_CONFIG,
  FLAG_CRITIQUE_REPORT,
  FLAG_DRY_RUN,
  FLAG_FORCE,
  FLAG_FORCE_SHORT,
  FLAG_HELP,
  FLAG_HELP_SHORT,
  FLAG_ISSUE,
  FLAG_JSON,
  FLAG_KEEP_WORKTREE,
  FLAG_MESSAGE,
  FLAG_MESSAGE_SHORT,
  FLAG_NO_WORKTREE,
  FLAG_PLAN_DIR,
  FLAG_PLAN_PATH,
  FLAG_QUARANTINE,
  FLAG_REFRESH,
  FLAG_REPORT_FILE,
  FLAG_REPORT_STDIN,
  FLAG_REVIEW_OUTPUT,
  FLAG_STAGED,
  FLAG_STAGED_SHORT,
  FLAG_TITLE,
  FLAG_TYPE,
  FLAG_VERDICT_FILE,
  FLAG_VERDICT_STDIN,
  FLAG_VERSION,
  FLAG_VERSION_SHORT,
  FLAG_WORKTREE,
  FLAG_YES,
  FLAG_YES_SHORT,
  FLAG_YOLO
} from '../domain';

/**
 * Every long flag this build recognises (43 entries).
 *
 * The verdict flags come from their domain constants (issue #269) rather than
 * being re-typed here; `--critique-report` is the hermetic Tier 1 evidence
 * channel (issue #297), and `--report-file` / `--report-stdin` are the gate
 * evidence channel (issue #284). `--plan-path` / `--plan-dir` are implemented
 * (issue #267): they are accepted by plan/implement/yolo and refused, loudly,
 * by every other command.
 */
export const KNOWN_LONG_FLAGS: readonly string[] = Object.freeze([
  '--all',
  '--base-branch',
  FLAG_COMMIT_AFTER,
  FLAG_CONFIG,
  '--create-pr',
  FLAG_CRITIQUE_REPORT,
  FLAG_DRY_RUN,
  FLAG_FORCE,
  FLAG_HELP,
  FLAG_ISSUE,
  FLAG_JSON,
  FLAG_KEEP_WORKTREE,
  '--keep-worktrees',
  FLAG_MESSAGE,
  '--message-file',
  '--model',
  '--no-quarantine',
  FLAG_NO_WORKTREE,
  FLAG_PLAN_DIR,
  FLAG_PLAN_PATH,
  '--prune-stale',
  FLAG_QUARANTINE,
  '--reason',
  FLAG_REFRESH,
  FLAG_REPORT_FILE,
  FLAG_REPORT_STDIN,
  '--restart',
  '--retry-after',
  FLAG_REVIEW_OUTPUT,
  '--skip-discovery',
  FLAG_STAGED,
  '--step',
  '--subagents',
  FLAG_TITLE,
  FLAG_TYPE,
  FLAG_VERDICT_FILE,
  FLAG_VERDICT_STDIN,
  FLAG_VERSION,
  '--workspace',
  '--workspace-dir',
  FLAG_WORKTREE,
  FLAG_YES,
  FLAG_YOLO
]);

/** Every short flag this build recognises (6 entries). */
export const KNOWN_SHORT_FLAGS: readonly string[] = Object.freeze([
  FLAG_HELP_SHORT,
  FLAG_VERSION_SHORT,
  FLAG_YES_SHORT,
  FLAG_STAGED_SHORT,
  FLAG_FORCE_SHORT,
  FLAG_MESSAGE_SHORT
]);

/** The union, frozen: 43 long + 6 short = 49. */
export const KNOWN_CLI_FLAGS: readonly string[] = Object.freeze([
  ...KNOWN_LONG_FLAGS,
  ...KNOWN_SHORT_FLAGS
]);

/**
 * Flags the parser recognises ON PURPOSE but that this build refuses.
 *
 * Empty as of issue #267: `--plan-path` is now IMPLEMENTED. Kept as the
 * single vocabulary for any future recognised-but-unimplemented flag, so the
 * "unknown vs unimplemented" distinction survives.
 */
export const UNIMPLEMENTED_FLAGS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The operator-supplied plan inputs (issue #267).
 */
export const PLAN_INPUT_FLAGS: readonly string[] = Object.freeze([
  FLAG_PLAN_PATH,
  FLAG_PLAN_DIR
]);

/** The ONLY commands that execute a plan, and so may accept a supplied one. */
export const COMMANDS_ACCEPTING_PLAN_INPUT: readonly string[] = Object.freeze([
  COMMAND_PLAN,
  COMMAND_IMPLEMENT,
  COMMAND_YOLO,
  '(default)'
]);

/**
 * Refuses a plan input on a command that does not execute one.
 *
 * Without this, the parser would accept `--plan-path` globally and the flag
 * would be silently dropped on `status`/`next`/`transition` — the exact defect
 * class issue #248 removed for `--dry-run`.
 */
export function validatePlanInputScope(subject: {
  readonly command: string | null;
  readonly planPathRequested: boolean;
  readonly planDirRequested: boolean;
}): readonly string[] {
  const key = subject.command === null ? '(default)' : subject.command;
  if (COMMANDS_ACCEPTING_PLAN_INPUT.includes(key)) {
    return [];
  }
  const lines: string[] = [];
  if (subject.planPathRequested) {
    lines.push(
      `✗ '${FLAG_PLAN_PATH}' is only supported by ${COMMANDS_ACCEPTING_PLAN_INPUT.filter((c) => c !== '(default)').join('/')}. Remove the flag from '${key}'.`
    );
  }
  if (subject.planDirRequested) {
    lines.push(
      `✗ '${FLAG_PLAN_DIR}' is only supported by ${COMMANDS_ACCEPTING_PLAN_INPUT.filter((c) => c !== '(default)').join('/')}. Remove the flag from '${key}'.`
    );
  }
  return lines;
}

/** Whether a command simulates (`supported`) or refuses (`refused`) a flag. */
export type FlagSupport = 'supported' | 'refused';

export interface CommandCapability {
  readonly dryRun: FlagSupport;
  readonly json: FlagSupport;
}

/**
 * The single source of truth for `--dry-run` / `--json` support.
 *
 * Keys are `<command>`, `<command>:<subcommand>` or `(default)` for a bare
 * `codeloop`. The gate, the help text and the contract tests all read THIS
 * table, so a command cannot quietly accept a flag it ignores.
 *
 * Unknown commands are absent on purpose: the gate skips them and the existing
 * switch error reports them.
 */
export const COMMAND_CAPABILITIES: Readonly<Record<string, CommandCapability>> = Object.freeze({
  '(default)': { dryRun: 'supported', json: 'refused' },
  init: { dryRun: 'supported', json: 'supported' },
  // `next` is a query that records its context fields (baseBranch, dispatch
  // counters, updatedAt), so `--dry-run` has a real simulation path: read,
  // declare the suppressed writes, write nothing (issue #301, absorbing #304).
  next: { dryRun: 'supported', json: 'supported' },
  'branch-info': { dryRun: 'refused', json: 'supported' },
  status: { dryRun: 'refused', json: 'supported' },
  config: { dryRun: 'refused', json: 'refused' },
  models: { dryRun: 'refused', json: 'refused' },
  prompt: { dryRun: 'refused', json: 'refused' },
  reset: { dryRun: 'supported', json: 'refused' },
  resume: { dryRun: 'supported', json: 'supported' },
  halt: { dryRun: 'supported', json: 'supported' },
  abort: { dryRun: 'supported', json: 'refused' },
  transition: { dryRun: 'supported', json: 'refused' },
  'worktree:list': { dryRun: 'refused', json: 'refused' },
  'worktree:clean': { dryRun: 'supported', json: 'refused' },
  'worktree:prune': { dryRun: 'supported', json: 'refused' },
  'worktree:remove': { dryRun: 'supported', json: 'refused' },
  'critique:status': { dryRun: 'refused', json: 'supported' },
  'critique:install': { dryRun: 'supported', json: 'refused' },
  'critique:update': { dryRun: 'supported', json: 'refused' },
  'opencode:install': { dryRun: 'refused', json: 'refused' },
  triage: { dryRun: 'supported', json: 'supported' },
  review: { dryRun: 'supported', json: 'supported' },
  // `gate-report` validates AND persists an evidence block (or clears a stale
  // one), so it has a real simulation path (issue #284).
  'gate-report': { dryRun: 'supported', json: 'supported' },
  plan: { dryRun: 'supported', json: 'refused' },
  implement: { dryRun: 'supported', json: 'refused' },
  // `commit --json` used to mean "never prompt" while printing human text. The
  // non-interactive path is `-y/--yes`; `--json` is refused (decision 3).
  commit: { dryRun: 'supported', json: 'refused' },
  release: { dryRun: 'supported', json: 'refused' },
  yolo: { dryRun: 'supported', json: 'refused' },
  sync: { dryRun: 'supported', json: 'refused' }
});

/** The structural shape the gate needs — never `CliOptions` (no cycle). */
export interface CapabilitySubject {
  readonly command: string | null;
  readonly yolo: boolean;
  readonly worktreeSubcommand: string | null;
  readonly critiqueSubcommand: string | null;
  readonly opencodeSubcommand: string | null;
}

/** The capability-table key for an invocation. */
export function capabilityKey(subject: CapabilitySubject): string {
  const command = subject.command;
  if (command === null) {
    return '(default)';
  }
  if (command === 'worktree') {
    const sub = subject.worktreeSubcommand ?? 'list';
    return `worktree:${sub === 'rm' ? 'remove' : sub}`;
  }
  if (command === 'critique') {
    return `critique:${subject.critiqueSubcommand ?? 'status'}`;
  }
  if (command === 'opencode') {
    return `opencode:${subject.opencodeSubcommand ?? 'install'}`;
  }
  return command;
}

/** `worktree:list` -> `worktree list`; `(default)` -> `codeloop`. */
export function displayCommandName(key: string): string {
  if (key === '(default)') {
    return 'codeloop';
  }
  return key.split(':').join(' ');
}

/**
 * The closest known long flag within edit distance 2, or null.
 *
 * Long flags only: answering `-q` with "did you mean `-y`" is noise, not a
 * suggestion. Ties are broken by the vocabulary's own order so the answer is
 * deterministic.
 */
export function suggestFlag(token: string): string | null {
  if (!token.startsWith('--')) {
    return null;
  }
  const base = stripValue(token);
  let best: string | null = null;
  let bestDistance = 3;
  for (const known of KNOWN_LONG_FLAGS) {
    const distance = levenshtein(base, known);
    if (distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  return bestDistance <= 2 ? best : null;
}

/** `--flag=value` -> `--flag` (no `=` means unchanged). */
function stripValue(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

/** Classic Levenshtein distance over two short ASCII tokens. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous: number[] = [];
  for (let j = 0; j <= b.length; j++) {
    previous.push(j);
  }

  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(current[j - 1] + 1, previous[j] + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length];
}

/** `✗ Unknown flag '--bogus'. [Did you mean '--dry-run'? ]Run 'codeloop --help' …` */
export function formatUnknownFlag(token: string, suggestion: string | null): string {
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
  return `✗ Unknown flag '${token}'.${hint} Run 'codeloop --help' for the supported flags.`;
}

/** `✗ Flag '--dry-run' does not take a value. Remove '=true'.` */
export function formatFlagTakesNoValue(flag: string, value: string): string {
  return `✗ Flag '${flag}' does not take a value. Remove '=${value}'.`;
}

/** `✗ '--plan-path' is recognised but not implemented yet (issue #267). …` */
export function formatUnimplementedFlag(flag: string, tracking: string): string {
  return `✗ '${flag}' is recognised but not implemented yet (${tracking}). Nothing was changed; remove the flag.`;
}

/** `✗ '--dry-run' has no effect on 'status': the command does not modify state. …` */
export function formatDryRunRefused(displayName: string): string {
  return `✗ '--dry-run' has no effect on '${displayName}': the command does not modify state. Remove the flag.`;
}

/** `✗ '--json' is not supported by 'transition'. Stdout would not be a JSON document; …` */
export function formatJsonRefused(displayName: string): string {
  return `✗ '--json' is not supported by '${displayName}'. Stdout would not be a JSON document; re-run without --json.`;
}

/**
 * Every diagnostic for an unrecognised token. PURE — callers print the result.
 *
 * Called BEFORE help/version so an unknown flag is never silently discarded,
 * even alongside `--help` (AC-248.9/10).
 */
export function validateUnknownFlags(unknownFlags: readonly string[]): readonly string[] {
  const lines: string[] = [];

  for (const token of unknownFlags) {
    if (token === '-' || token === '--') {
      continue;
    }

    const base = stripValue(token);
    if (Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_FLAGS, base)) {
      lines.push(formatUnimplementedFlag(base, UNIMPLEMENTED_FLAGS[base]));
      continue;
    }

    // `--dry-run=true`: the `=value`-stripped base IS a known flag, so this is a
    // shape error, not an unknown flag (and never a nonsense suggestion).
    if (token !== base && KNOWN_LONG_FLAGS.includes(base)) {
      lines.push(formatFlagTakesNoValue(base, token.slice(token.indexOf('=') + 1)));
      continue;
    }

    // Defensive: a known flag that somehow reached this channel is not an error.
    if (KNOWN_CLI_FLAGS.includes(token)) {
      continue;
    }

    lines.push(formatUnknownFlag(token, suggestFlag(token)));
  }

  return lines;
}

/**
 * Every capability refusal for this invocation. PURE.
 *
 * Called AFTER help/version/issue-token and BEFORE any adapter is constructed,
 * so a refused invocation cannot mutate anything (AC-248.10/11).
 */
export function validateCapability(
  subject: CapabilitySubject & { readonly dryRun: boolean; readonly json: boolean }
): readonly string[] {
  const key = capabilityKey(subject);
  const capability = COMMAND_CAPABILITIES[key];
  if (!capability) {
    // Unknown command: the switch's own error reports it.
    return [];
  }

  const displayName = displayCommandName(key);
  const lines: string[] = [];
  if (subject.dryRun && capability.dryRun === 'refused') {
    lines.push(formatDryRunRefused(displayName));
  }
  if (subject.json && capability.json === 'refused') {
    lines.push(formatJsonRefused(displayName));
  }
  return lines;
}
