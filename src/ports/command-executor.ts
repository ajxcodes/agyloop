/**
 * agyloop - CommandExecutorPort Interface
 *
 * Inversion of control contract for executing shell commands, capturing outputs,
 * enforcing execution timeouts, and preventing direct child_process leaks.
 */

export interface CommandExecutionOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CommandExecutionResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly combinedOutput: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface CommandExecutorPort {
  /**
   * Executes a shell command in an isolated child process.
   *
   * @param command - The command string to execute.
   * @param options - Execution options including working directory, timeout, and environment.
   * @returns CommandExecutionResult containing exit code, stdout, stderr, duration, and timeout status.
   */
  execute(command: string, options?: CommandExecutionOptions): Promise<CommandExecutionResult>;
}
