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
}
