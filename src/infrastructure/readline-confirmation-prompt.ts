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
  /**
   * Explicit override for prompt permission. When omitted it is inferred: an
   * explicitly injected stream means the caller controls readability (interactive),
   * while the default `process` streams require both stdin and stdout to be TTYs.
   */
  readonly interactive?: boolean;
}

/**
 * A stream is only usable for a blocking prompt when it is attached to a real
 * terminal. Pipes, files and CI log streams expose `isTTY` as `undefined`/`false`.
 */
function isInteractiveStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return (stream as unknown as { isTTY?: boolean }).isTTY === true;
}

export class ReadlineConfirmationPrompt implements ConfirmationPromptPort {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly interactive: boolean;

  constructor(options: ReadlineConfirmationPromptOptions = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    // Zero-Hang Invariant (issue #218 AC6): this adapter must never block a
    // non-interactive consumer. Injected streams stay interactive so a caller that
    // owns the stream (e.g. tests piping scripted answers) is never silenced; the
    // default process streams are gated on a real TTY on both ends.
    this.interactive =
      options.interactive ??
      (options.input || options.output
        ? true
        : isInteractiveStream(process.stdin) && isInteractiveStream(process.stdout));
  }

  public async confirm(message: string, defaultValue = false): Promise<boolean> {
    // A silent-but-open stdin pipe (CI, cron, `npm test`) never fires `question`,
    // `close` or `error`, so the promise below would never settle. Short-circuit
    // before any readline interface is constructed so blocking is impossible.
    if (!this.interactive) {
      return defaultValue;
    }

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
