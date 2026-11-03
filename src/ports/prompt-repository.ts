/**
 * agyloop - PromptRepository Port Interface
 *
 * Inversion of control contract for resolving and reading subagent system prompts.
 */

export interface PromptLoadOptions {
  readonly promptPath?: string;
  readonly cwd?: string;
}

export interface PromptRepository {
  /**
   * Loads system prompt for a specific subagent role (e.g., 'planner', 'implementer').
   * If a prompt file exists on disk, reads and returns it.
   * Otherwise, falls back to the embedded default prompt.
   */
  loadPrompt(role: string, options?: PromptLoadOptions): string;

  /**
   * The path `loadPrompt` would read for this role, or `null` when the embedded
   * default is used instead (issue #290, AC6).
   *
   * The inspection command must name the source it ACTUALLY loaded; sharing one
   * resolver with `loadPrompt` is what makes that label impossible to drift.
   */
  resolvePromptPath(role: string, options?: PromptLoadOptions): string | null;
}
