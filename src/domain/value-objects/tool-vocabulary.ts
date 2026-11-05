/**
 * agyloop - Tool Vocabulary Value Object
 *
 * Renders a dispatched subagent directive's tool prose from host-neutral
 * CAPABILITIES rather than from one harness's tool identifiers (issue #241,
 * D6 slice 1).
 *
 * The Antigravity plugin's identifiers stay where they are correct: the
 * machine-readable `ToolWhitelist` shipped in `plugin.json` and that plugin's
 * `system_prompt` assets. A dispatched `Prompt` is executed by whatever harness
 * the operator runs, so by default it must not name a host it was not written
 * for.
 *
 * Issue #290 (D6 slice 2): when the operator HAS selected a host, the caller may
 * pass that host's `HostToolVocabulary`, and each capability renders as the tool
 * name that host actually exposes. With no vocabulary the output is byte-identical
 * to the neutral form above.
 */

import { TOOL_PROSE_QUALIFIER, ToolCapability } from '../tools';
import { HostToolVocabulary } from './host-tool-vocabulary';

export interface FormatToolProseOptions {
  /** Plural nouns ("tools") for a capability set; singular ("tool") otherwise. */
  readonly plural?: boolean;
  /**
   * The selected host's vocabulary (issue #290). Absent/null renders the
   * host-neutral capability words — the #241 prose, unchanged.
   */
  readonly vocabulary?: HostToolVocabulary | null;
}

/**
 * Formats a capability set as prose, e.g.
 * `your harness-provided read, search and list tools`.
 *
 * Without a vocabulary the words are generic verbs, never a host's tool
 * identifiers: naming one host's tools would re-introduce the same defect in the
 * other direction. With a vocabulary each capability is its host's tool name.
 */
export function formatToolProse(
  capabilities: readonly ToolCapability[],
  options: FormatToolProseOptions = {}
): string {
  const vocabulary = options.vocabulary ?? null;
  const words = capabilities.map((capability) =>
    vocabulary ? vocabulary.tools[capability] : capability
  );

  if (words.length === 0) {
    return `${TOOL_PROSE_QUALIFIER} tools`;
  }

  const last = words[words.length - 1];
  const list =
    words.length === 1
      ? last
      : `${words.slice(0, -1).join(', ')} and ${last}`;

  return `${TOOL_PROSE_QUALIFIER} ${list} ${options.plural ? 'tools' : 'tool'}`;
}
