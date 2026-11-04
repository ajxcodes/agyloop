/**
 * agyloop - ONE canonical CommandExecutorPort double (issue #544 / AC2)
 *
 * Retires `CommandExecutorDouble` / `CommandExecutorDouble` / `CommandExecutorDouble`.
 * The one class records every execution AND carries the scripted-response
 * modes the local families needed:
 *
 *   - scripted builder (`createFakeCommandExecutor`)
 *   - `handler(command, options)` bespoke behaviour
 *   - `respond[command]` declarative partial results
 *   - `failCommands` exit-code fixtures (`rev-parse` failures etc)
 */

import type {
  CommandExecutorPort,
  CommandExecutionOptions,
  CommandExecutionResult
} from '../../../src/ports';

type ExecHandler = (
  command: string,
  options?: CommandExecutionOptions
) => Partial<CommandExecutionResult> & { exitCode?: number };

interface FakeCommandExecutorOptions {
  handler?: ExecHandler;
  /** command -> partial result (merged over the zero-result shape). */
  respond?: Record<string, Partial<CommandExecutionResult>>;
  /** Always exit 1 for these commands. */
  failCommands?: readonly string[];
}

function zeroResult(command: string): CommandExecutionResult {
  return {
    command,
    exitCode: 0,
    stdout: '',
    stderr: '',
    combinedOutput: '',
    durationMs: 0,
    timedOut: false
  };
}

class FakeCommandExecutor implements CommandExecutorPort {
  public calls: Record<string, unknown[]> = { execute: [], killAll: [] };

  public executedCommands: string[] = [];
  public executedOptions: Array<CommandExecutionOptions | undefined> = [];
  public responses: Record<string, Partial<CommandExecutionResult>>;
  public failCommands: Set<string>;
  public handler?: ExecHandler;

  constructor(options: FakeCommandExecutorOptions = {}) {
    this.responses = options.respond ?? {};
    this.failCommands = new Set(options.failCommands ?? []);
    this.handler = options.handler;
  }

  public async execute(command: string, options?: CommandExecutionOptions): Promise<CommandExecutionResult> {
    this.calls.execute.push([command, options]);
    this.executedCommands.push(command);
    this.executedOptions.push(options);

    if (this.failCommands.has(command)) {
      return { ...zeroResult(command), exitCode: 1 };
    }
    if (this.handler) {
      return { ...zeroResult(command), ...this.handler(command, options) } as CommandExecutionResult;
    }
    if (this.responses[command] !== undefined) {
      return { ...zeroResult(command), ...this.responses[command] } as CommandExecutionResult;
    }
    return zeroResult(command);
  }

  public killAll(_signal?: string): number {
    this.calls.killAll.push([_signal]);
    return 0;
  }
}

function createFakeCommandExecutor(options?: FakeCommandExecutorOptions): FakeCommandExecutor {
  return new FakeCommandExecutor(options ?? {});
}

function createRecordingExecutor(options?: FakeCommandExecutorOptions): FakeCommandExecutor {
  return createFakeCommandExecutor(options);
}
module.exports = { FakeCommandExecutor, createFakeCommandExecutor, createRecordingExecutor, zeroCommandResult: zeroResult };
