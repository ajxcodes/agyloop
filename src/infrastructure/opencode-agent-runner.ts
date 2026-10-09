/**
 * agyloop - OpenCodeAgentRunner Infrastructure Adapter
 *
 * Implements AgentRunnerPort by dispatching subagent requests to the OpenCode CLI.
 */

import { AgentRunnerPort, RunnerSubagentPayload, CommandExecutorPort } from '../ports';
import { DEFAULT_OPENCODE_MODEL } from '../domain';
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
    const prompt = payload.prompt;
    const escapedPrompt = prompt.replace(/'/g, "'\\''");

    const command = `${this.binaryPath} run --standalone --auto --model ${model} '${escapedPrompt}'`;

    const result = await this.executor.execute(command, {
      cwd: payload.cwd,
      env: payload.env
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `OpenCode execution failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`
      );
    }
  }
}
