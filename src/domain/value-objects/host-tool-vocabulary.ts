/**
 * agyloop - Host Tool Vocabulary Value Object (issue #290, D6 slice 2)
 *
 * Maps the host-neutral `ToolCapability` words onto the concrete tool
 * identifiers each supported harness exposes, so a role prompt can name the
 * tools the executing host actually has.
 *
 * The vocabulary is DATA, not a conditional: nothing in a prompt string, a
 * prompt asset or a builder branches on the host. The two tables below are the
 * only place the host axis exists, and `HOST_TOOL_VOCABULARIES` is an exhaustive
 * `Record<RunnerType, ...>` so adding a runner without adding a vocabulary is a
 * compile error.
 *
 * `auto` maps to `null` explicitly: an unresolved host is never guessed. A
 * `null` vocabulary is the identity everywhere, which is what keeps the
 * host-neutral prose from #241/D6 slice 1 and the Antigravity assets intact.
 */

import { TOOL_CAPABILITY_EDIT, TOOL_CAPABILITY_LIST, TOOL_CAPABILITY_READ, TOOL_CAPABILITY_SEARCH, TOOL_CAPABILITY_SHELL, TOOL_CAPABILITY_WRITE, TOOL_FIND_BY_NAME, TOOL_GREP_SEARCH, TOOL_LIST_DIR, TOOL_MULTI_REPLACE_FILE_CONTENT, TOOL_REPLACE_FILE_CONTENT, TOOL_RUN_COMMAND, TOOL_VIEW_FILE, TOOL_WRITE_TO_FILE, ToolCapability } from '../tools';
import { isRunnerType, RunnerType } from './runner-type';

export interface HostToolVocabulary {
  readonly host: 'antigravity' | 'opencode';
  readonly displayName: string;
  readonly tools: Readonly<Record<ToolCapability, string>>;
}

/** The Antigravity plugin's own tool identifiers. */
export const ANTIGRAVITY_TOOL_VOCABULARY: HostToolVocabulary = Object.freeze({
  host: 'antigravity',
  displayName: 'Google Antigravity',
  tools: Object.freeze({
    [TOOL_CAPABILITY_READ]: TOOL_VIEW_FILE,
    [TOOL_CAPABILITY_SEARCH]: TOOL_GREP_SEARCH,
    [TOOL_CAPABILITY_LIST]: TOOL_LIST_DIR,
    [TOOL_CAPABILITY_WRITE]: TOOL_WRITE_TO_FILE,
    [TOOL_CAPABILITY_EDIT]: TOOL_REPLACE_FILE_CONTENT,
    [TOOL_CAPABILITY_SHELL]: TOOL_RUN_COMMAND
  })
});

/** The OpenCode harness's tool identifiers. */
export const OPENCODE_TOOL_VOCABULARY: HostToolVocabulary = Object.freeze({
  host: 'opencode',
  displayName: 'OpenCode',
  tools: Object.freeze({
    [TOOL_CAPABILITY_READ]: 'read',
    [TOOL_CAPABILITY_SEARCH]: 'grep',
    [TOOL_CAPABILITY_LIST]: 'glob',
    [TOOL_CAPABILITY_WRITE]: 'write',
    [TOOL_CAPABILITY_EDIT]: 'edit',
    [TOOL_CAPABILITY_SHELL]: 'shell'
  })
});

/**
 * One entry per `RunnerType`. `auto` is `null` on purpose: the runner list is
 * exhaustive, but the HOST is not known, and guessing one would contradict AC4.
 */
export const HOST_TOOL_VOCABULARIES = Object.freeze({
  auto: null,
  antigravity: ANTIGRAVITY_TOOL_VOCABULARY,
  opencode: OPENCODE_TOOL_VOCABULARY
} satisfies Readonly<Record<RunnerType, HostToolVocabulary | null>>);

/**
 * The REVERSE table: Antigravity identifier → capability, longest identifier
 * first so `multi_replace_file_content` is never half-substituted into
 * `multi_edit`.
 */
export const ANTIGRAVITY_TOOL_CAPABILITIES: readonly (readonly [string, ToolCapability])[] =
  Object.freeze([
    Object.freeze([TOOL_MULTI_REPLACE_FILE_CONTENT, TOOL_CAPABILITY_EDIT] as const),
    Object.freeze([TOOL_REPLACE_FILE_CONTENT, TOOL_CAPABILITY_EDIT] as const),
    Object.freeze([TOOL_WRITE_TO_FILE, TOOL_CAPABILITY_WRITE] as const),
    Object.freeze([TOOL_FIND_BY_NAME, TOOL_CAPABILITY_LIST] as const),
    Object.freeze([TOOL_LIST_DIR, TOOL_CAPABILITY_LIST] as const),
    Object.freeze([TOOL_GREP_SEARCH, TOOL_CAPABILITY_SEARCH] as const),
    Object.freeze([TOOL_VIEW_FILE, TOOL_CAPABILITY_READ] as const),
    Object.freeze([TOOL_RUN_COMMAND, TOOL_CAPABILITY_SHELL] as const)
  ]);

/**
 * Resolves a runner name to its vocabulary.
 *
 * Returns `null` for `undefined`, `null`, `'auto'` and anything unrecognised:
 * an unresolved host never guesses, it falls back to the neutral prose.
 */
export function resolveHostToolVocabulary(
  runner: string | null | undefined
): HostToolVocabulary | null {
  if (typeof runner !== 'string') {
    return null;
  }
  const normalized = runner.trim().toLowerCase();
  if (!isRunnerType(normalized)) {
    return null;
  }
  return HOST_TOOL_VOCABULARIES[normalized];
}

/**
 * Translates one Antigravity identifier to the vocabulary's name for the same
 * capability.
 *
 * `null`/`undefined`/`antigravity` return the name UNCHANGED — translation is the
 * identity for the Antigravity surface, so `find_by_name` stays `find_by_name`
 * instead of being rewritten to a different Antigravity name. A name absent from
 * the reverse table passes through untouched.
 */
export function translateToolName(
  name: string,
  vocabulary: HostToolVocabulary | null | undefined
): string {
  if (!vocabulary || vocabulary.host === 'antigravity') {
    return name;
  }
  for (const [identifier, capability] of ANTIGRAVITY_TOOL_CAPABILITIES) {
    if (identifier === name) {
      return vocabulary.tools[capability];
    }
  }
  return name;
}

/**
 * Translates a whitelist, deduping the 7→6 capability collapse while preserving
 * first-occurrence order (`find_by_name` and `list_dir` both become `glob`).
 */
export function translateToolNames(
  names: readonly string[],
  vocabulary: HostToolVocabulary | null | undefined
): readonly string[] {
  const translated: string[] = [];
  for (const name of names) {
    const replacement = translateToolName(name, vocabulary);
    if (!translated.includes(replacement)) {
      translated.push(replacement);
    }
  }
  return translated;
}

/** Two adjacent, identical backticked tool names, e.g. `` `glob`, `glob` ``. */
const DUPLICATE_TOOL_PATTERN = /`([a-z_]+)`(,|, and| and) `\1`/g;

function collapseDuplicateToolNames(text: string): string {
  let current = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current.replace(DUPLICATE_TOOL_PATTERN, '`$1`');
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

/**
 * Renders a system prompt for a host.
 *
 * Identity for `null`/`undefined`/`antigravity`: the Antigravity asset is
 * returned byte-identically (AC4/AC5). For `opencode` the identifiers are
 * substituted at word boundaries (the assets already wrap them in backticks, so
 * no backticks are added), the host label is replaced, and the identifier
 * collapse is repaired so the discovery prompt never reads "`glob`, `glob`".
 */
export function renderSystemPromptForHost(
  prompt: string,
  vocabulary?: HostToolVocabulary | null
): string {
  if (!vocabulary || vocabulary.host === 'antigravity') {
    return prompt;
  }

  let rendered = prompt;
  for (const [identifier, capability] of ANTIGRAVITY_TOOL_CAPABILITIES) {
    rendered = rendered.replace(new RegExp(`\\b${identifier}\\b`, 'g'), vocabulary.tools[capability]);
  }
  rendered = rendered.replaceAll(ANTIGRAVITY_TOOL_VOCABULARY.displayName, vocabulary.displayName);
  return collapseDuplicateToolNames(rendered);
}

/**
 * The write-tool list the `implement` banner prints, derived from the vocabulary
 * instead of a hard-coded Antigravity literal (AC6).
 */
export function formatWriteCapabilitySummary(
  vocabulary: HostToolVocabulary | null | undefined
): string {
  return translateToolNames(
    [TOOL_WRITE_TO_FILE, TOOL_REPLACE_FILE_CONTENT, TOOL_RUN_COMMAND],
    vocabulary
  ).join(', ');
}
