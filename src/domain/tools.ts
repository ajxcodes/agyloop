/* eslint-disable @typescript-eslint/no-unused-vars */

export const TOOL_VIEW_FILE = 'view_file' as const;

export const TOOL_GREP_SEARCH = 'grep_search' as const;

export const TOOL_FIND_BY_NAME = 'find_by_name' as const;

export const TOOL_LIST_DIR = 'list_dir' as const;


export const READ_ONLY_TOOLS = Object.freeze([
  TOOL_VIEW_FILE,
  TOOL_GREP_SEARCH,
  TOOL_FIND_BY_NAME,
  TOOL_LIST_DIR
] as const);


export const TOOL_WRITE_TO_FILE = 'write_to_file' as const;

export const TOOL_REPLACE_FILE_CONTENT = 'replace_file_content' as const;

export const TOOL_MULTI_REPLACE_FILE_CONTENT = 'multi_replace_file_content' as const;

export const TOOL_RUN_COMMAND = 'run_command' as const;


/**
 * Host-NEUTRAL capability words for a DISPATCHED prompt (issue #241, D6).
 *
 * The identifiers above are Antigravity's. A dispatched directive is executed
 * by whatever harness the operator runs — OpenCode exposes `read`/`grep`/
 * `glob`/`write`/`edit`/`shell`, not the names above — so naming one host's
 * identifiers in a directive written for another is the same defect as
 * naming a command the CLI refuses.
 *
 * These words are generic English verbs, deliberately NOT any host's tool
 * identifiers: naming `read`/`grep` would re-introduce the same defect in the
 * other direction. `formatToolProse` turns them into prose; `ToolWhitelist`
 * and the Antigravity plugin's system-prompt assets keep the identifiers.
 */
export const TOOL_CAPABILITY_READ = 'read' as const;

export const TOOL_CAPABILITY_SEARCH = 'search' as const;

export const TOOL_CAPABILITY_LIST = 'list' as const;

export const TOOL_CAPABILITY_WRITE = 'write' as const;

export const TOOL_CAPABILITY_EDIT = 'edit' as const;

export const TOOL_CAPABILITY_SHELL = 'shell' as const;

export const TOOL_PROSE_QUALIFIER = 'your harness-provided' as const;


export type ToolCapability =
  | typeof TOOL_CAPABILITY_READ
  | typeof TOOL_CAPABILITY_SEARCH
  | typeof TOOL_CAPABILITY_LIST
  | typeof TOOL_CAPABILITY_WRITE
  | typeof TOOL_CAPABILITY_EDIT
  | typeof TOOL_CAPABILITY_SHELL;
