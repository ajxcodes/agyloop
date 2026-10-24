/**
 * agyloop - Tool Vocabulary Value Object
 *
 * Renders a dispatched subagent directive's tool prose from host-neutral
 * CAPABILITIES rather than from one harness's tool identifiers (issue #241,
 * D6 slice 1).
 *
 * The Antigravity identifiers (`view_file`, `run_command`, ...) stay where they
 * are correct: the machine-readable `ToolWhitelist` shipped in `plugin.json` and
 * the Antigravity plugin's `system_prompt` assets. A dispatched `Prompt` is
 * executed by whatever harness the operator runs, so it must not name a host it
 * was not written for.
 */

import { TOOL_PROSE_QUALIFIER, ToolCapability } from '../constants';

export interface FormatToolProseOptions {
  /** Plural nouns ("tools") for a capability set; singular ("tool") otherwise. */
  readonly plural?: boolean;
}

/**
 * Formats a capability set as prose, e.g.
 * `your harness-provided read, search and list tools`.
 *
 * The words are generic verbs, never a host's tool identifiers: naming
 * `read`/`grep` would re-introduce the same defect in the other direction.
 */
export function formatToolProse(
  capabilities: readonly ToolCapability[],
  options: FormatToolProseOptions = {}
): string {
  if (capabilities.length === 0) {
    return `${TOOL_PROSE_QUALIFIER} tools`;
  }

  const last = capabilities[capabilities.length - 1];
  const list =
    capabilities.length === 1
      ? last
      : `${capabilities.slice(0, -1).join(', ')} and ${last}`;

  return `${TOOL_PROSE_QUALIFIER} ${list} ${options.plural ? 'tools' : 'tool'}`;
}
