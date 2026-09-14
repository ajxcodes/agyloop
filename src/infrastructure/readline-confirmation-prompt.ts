/**
 * agyloop - ReadlineConfirmationPrompt (Infrastructure Layer)
 *
 * Implements ConfirmationPromptPort using Node.js readline interface.
 * Prompts user for affirmative confirmation before executing state mutations.
 */

import * as readline from 'readline';
import { ConfirmationPromptPort } from '../ports/confirmation-prompt';
import { CONFIRMATION_AFFIRMATIVE_RESPONSES } from '../domain/constants';

export interface ReadlineConfirmationPromptOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export class ReadlineConfirmationPrompt implements ConfirmationPromptPort {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  constructor(options: ReadlineConfirmationPromptOptions = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
  }

  public async confirm(message: string, defaultValue = false): Promise<boolean> {
    const rl = readline.createInterface({
      input: this.input,
      output: this.output
    });

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      rl.question(message, (answer) => {
        if (!resolved) {
          resolved = true;
          rl.close();
          const trimmed = answer.trim().toLowerCase();
          if (!trimmed) {
            resolve(defaultValue);
          } else {
            resolve(
              (CONFIRMATION_AFFIRMATIVE_RESPONSES as readonly string[]).includes(trimmed)
            );
          }
        }
      });

      rl.on('close', () => {
        if (!resolved) {
          resolved = true;
          resolve(defaultValue);
        }
      });

      rl.on('error', () => {
        if (!resolved) {
          resolved = true;
          rl.close();
          resolve(defaultValue);
        }
      });
    });
  }
}
