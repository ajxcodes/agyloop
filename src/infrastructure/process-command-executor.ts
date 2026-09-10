/**
 * agyloop - ProcessCommandExecutor Infrastructure Adapter
 *
 * Implements CommandExecutorPort using isolated child processes (child_process.spawn)
 * with timeout enforcement and stdout/stderr stream buffering.
 */

import * as child_process from 'child_process';
import {
  CommandExecutorPort,
  CommandExecutionOptions,
  CommandExecutionResult
} from '../ports';

export class ProcessCommandExecutor implements CommandExecutorPort {
  public async execute(
    command: string,
    options: CommandExecutionOptions = {}
  ): Promise<CommandExecutionResult> {
    const cwd = options.cwd || process.cwd();
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;
    const env = options.env ? { ...process.env, ...options.env } : process.env;

    const startTime = Date.now();

    return new Promise<CommandExecutionResult>((resolve) => {
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let combinedBuffer = '';
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;

      const proc = child_process.spawn(command, {
        shell: true,
        cwd,
        env,
        detached: process.platform !== 'win32'
      });

      if (timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            if (proc.pid && process.platform !== 'win32') {
              process.kill(-proc.pid, 'SIGTERM');
            } else {
              proc.kill('SIGTERM');
            }
          } catch {
            try {
              proc.kill('SIGTERM');
            } catch {
              // Process may have already exited
            }
          }

          // Force SIGKILL after 500ms if still active
          const killTimer = setTimeout(() => {
            try {
              if (proc.pid && process.platform !== 'win32') {
                process.kill(-proc.pid, 'SIGKILL');
              } else {
                proc.kill('SIGKILL');
              }
            } catch {
              // Ignore kill errors
            }
          }, 500);
          killTimer.unref();
        }, timeoutMs);
      }


      proc.stdout?.on('data', (chunk: Buffer | string) => {
        const str = chunk.toString();
        stdoutBuffer += str;
        combinedBuffer += str;
      });

      proc.stderr?.on('data', (chunk: Buffer | string) => {
        const str = chunk.toString();
        stderrBuffer += str;
        combinedBuffer += str;
      });

      proc.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        stderrBuffer += `\nProcess execution error: ${err.message}`;
        combinedBuffer += `\nProcess execution error: ${err.message}`;
        resolve({
          command,
          exitCode: 1,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          combinedOutput: combinedBuffer,
          durationMs,
          timedOut
        });
      });

      proc.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        let exitCode = code !== null ? code : 1;
        if (timedOut) {
          exitCode = exitCode !== 0 ? exitCode : 1;
        }

        resolve({
          command,
          exitCode,
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          combinedOutput: combinedBuffer,
          durationMs,
          timedOut
        });
      });
    });
  }
}
