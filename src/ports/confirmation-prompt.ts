/**
 * agyloop - ConfirmationPromptPort Interface
 *
 * Inversion of control contract for human-in-the-loop confirmation gates.
 * Application use cases must never depend directly on readline, stdin, or tty.
 */

export interface ConfirmationPromptPort {
  /**
   * Prompts the user with an affirmative/negative query.
   *
   * @param message - The confirmation question or prompt text.
   * @param defaultValue - Fallback answer if input is empty or non-interactive (default: false).
   * @returns Promise resolving to true if confirmed, false otherwise.
   */
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
}
