/* eslint-disable @typescript-eslint/no-unused-vars */

// OpenCode Integration Installer (issue #218 / AC1-AC3)

/** XDG-style config root beneath `$HOME`. */
export const OPENCODE_CONFIG_DIR_NAME = '.config' as const;


/** OpenCode's per-application directory beneath the config root. */
export const OPENCODE_APP_DIR_NAME = 'opencode' as const;


/** Config filenames in precedence order: `.jsonc` first, plain `.json` second. */
export const OPENCODE_CONFIG_FILENAMES = Object.freeze([
  'opencode.jsonc',
  'opencode.json'
] as const);


/**
 * Filename used when no OpenCode config exists yet. Freshly created configs carry no
 * comments, so a strict-JSON filename is the honest choice.
 */
export const OPENCODE_CONFIG_CREATE_FILENAME = 'opencode.json' as const;


/** Suffix for the pre-rewrite snapshot of a hand-maintained OpenCode config. */
export const OPENCODE_CONFIG_BACKUP_SUFFIX = '.codeloop.bak' as const;


/** Skill directory name; must match the skill frontmatter `name`. */
export const OPENCODE_SKILL_NAME = 'codeloop' as const;


/** OpenCode scans a directory named after the skill, containing this file. */
export const OPENCODE_SKILL_FILENAME = 'SKILL.md' as const;


/** Repo-relative path of the skill asset, resolved against the workspace root. */
export const OPENCODE_SKILL_ASSET_RELATIVE_PATH = 'integrations/opencode/codeloop-skill.md' as const;


/** Repo-relative path of the slash-command payload asset. */
export const OPENCODE_COMMAND_ASSET_RELATIVE_PATH = 'integrations/opencode/codeloop-command.json' as const;


/** Legacy (never-scanned) install root left behind by pre-#218 installers. */
export const OPENCODE_LEGACY_DIR_NAME = '.opencode' as const;


/** Legacy flat filename that produced the live dangling symlink. */
export const OPENCODE_LEGACY_SKILL_FILENAME = 'codeloop.md' as const;


/** Slash-command key registered in `opencode.json(c)` under `command`. */
export const OPENCODE_COMMAND_NAME = 'codeloop' as const;


/** Compiled-in fallback used when the command asset cannot be read. */
export const OPENCODE_COMMAND_DESCRIPTION =
  'Run the CodeLoop multi-subagent development lifecycle' as const;


/** Compiled-in fallback used when the command asset cannot be read. */
export const OPENCODE_COMMAND_TEMPLATE =
  'Execute the codeloop multi-subagent lifecycle pipeline for the current task: $ARGUMENTS' as const;


/**
 * `symlinkSync` error codes that justify a copy fallback. Anything else is treated as a
 * programming/environment error and rethrown rather than silently downgraded.
 */
export const OPENCODE_SYMLINK_FALLBACK_CODES = Object.freeze([
  'EEXIST',
  'EPERM',
  'EXDEV',
  'ENOTSUP',
  'ENOSYS'
] as const);
