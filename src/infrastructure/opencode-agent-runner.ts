/**
 * agyloop - OpenCodeAgentRunner Infrastructure Adapter
 *
 * Implements AgentRunnerPort by dispatching subagent requests to the OpenCode CLI.
 */

import { AgentRunnerPort, RunnerSubagentPayload, CommandExecutorPort } from '../ports';
import { DEFAULT_OPENCODE_MODEL, QuotaExhaustedError, classifyQuotaExhaustion } from '../domain';
import { ProcessCommandExecutor } from './process-command-executor';

export interface OpenCodeAgentRunnerOptions {
  readonly commandExecutor?: CommandExecutorPort;
  readonly defaultModel?: string;
  readonly binaryPath?: string;
}

export class OpenCodeAgentRunner implements AgentRunnerPort {
  private readonly executor: CommandExecutorPort;
  private readonly defaultModel: string;
  private readonly binaryPath: string;

  constructor(options: OpenCodeAgentRunnerOptions = {}) {
    this.executor = options.commandExecutor || new ProcessCommandExecutor();
    this.defaultModel = options.defaultModel || DEFAULT_OPENCODE_MODEL;
    this.binaryPath = options.binaryPath || 'opencode';
  }

  public async invokeSubagent(payload: RunnerSubagentPayload): Promise<void> {
    let model = payload.model || this.defaultModel;
    if (model && !model.includes('/')) {
      model = `ollama/${model}`;
    }
    const args = ['run', '--standalone', '--auto', '--model', model, payload.prompt];

    const result = await this.executor.execute(this.binaryPath, {
      args,
      cwd: payload.cwd,
      env: payload.env
    });

    if (result.exitCode !== 0) {
      const stderr = result.stderr || '';
      const stdout = result.stdout || '';

      // Classify BEFORE throwing: a quota rejection (HTTP 429 / RESOURCE_EXHAUSTED)
      // must survive as structured data so the lifecycle can checkpoint instead of
      // losing the only carrier of the signal (issue #218 AC4).
      const signal = classifyQuotaExhaustion(`${stderr}\n${stdout}`);
      if (signal.isQuotaExhausted) {
        throw new QuotaExhaustedError({
          signal,
          runner: 'opencode',
          model,
          attempt: 1
        });
      }

      // Unchanged shape for every non-quota failure.
      throw new Error(
        `OpenCode execution failed with exit code ${result.exitCode}: ${stderr || stdout}`
      );
    }
  }
}
