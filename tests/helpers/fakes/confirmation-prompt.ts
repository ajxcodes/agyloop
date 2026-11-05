/**
 * codeloop - ONE canonical ConfirmationPromptPort double (issue #544 / AC2)
 * Retires the 4 `ConfirmationPromptDouble` copies. Queue-init answers;
 * default `confirm()` plays its `defaultValue` (always-NO under the CLI's
 * non-interactive default).
 */

import type { ConfirmationPromptPort } from '../../../src/ports';

class FakeConfirmationPrompt implements ConfirmationPromptPort {
  public calls: Record<string, unknown[]> = { confirm: [] };

  public prompts: Array<{ message: string; defaultValue?: boolean }> = [];
  private answers: boolean[];

  constructor(answers?: boolean[]) {
    this.answers = answers ?? [];
  }

  public async confirm(message: string, defaultValue?: boolean): Promise<boolean> {
    this.calls.confirm.push([message, defaultValue]);
    this.prompts.push({ message, defaultValue });
    if (this.answers.length > 0) {
      return this.answers.shift() ?? false;
    }
    return defaultValue ?? false;
  }
}

module.exports = { FakeConfirmationPrompt };
