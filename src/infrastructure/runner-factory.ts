/**
 * agyloop - RunnerFactory Infrastructure Factory
 *
 * Resolves the appropriate AgentRunnerPort implementation based on
 * explicit configuration, environment variables, or runtime environment discovery.
 */

import * as child_process from 'child_process';
import { AgentRunnerPort, AgyLoopConfig, CommandExecutorPort } from '../ports';
import { DEFAULT_OPENCODE_MODEL } from '../domain';
import { AntigravityAgentRunner } from './antigravity-agent-runner';
import { OpenCodeAgentRunner } from './opencode-agent-runner';
import { ProcessCommandExecutor } from './process-command-executor';

export interface RunnerFactoryOptions {
  readonly config?: AgyLoopConfig;
  readonly commandExecutor?: CommandExecutorPort;
  readonly env?: NodeJS.ProcessEnv;
}

export class RunnerFactory {
  public static createRunner(options: RunnerFactoryOptions = {}): AgentRunnerPort {
    const env = options.env || process.env;
    const config = options.config;
    const commandExecutor = options.commandExecutor || new ProcessCommandExecutor();

    // 1. Check explicit override from environment
    let selectedRunner = env.CODELOOP_RUNNER;

    // 2. Fall back to config runner
    if (!selectedRunner && config?.runner) {
      selectedRunner = config.runner;
    }

    // 3. Normalize runner choice
    if (selectedRunner) {
      selectedRunner = selectedRunner.toLowerCase().trim();
    }

    // If explicit opencode
    if (selectedRunner === 'opencode') {
      const model = env.OPENCODE_MODEL || config?.opencode?.model || DEFAULT_OPENCODE_MODEL;
      return new OpenCodeAgentRunner({
        commandExecutor,
        defaultModel: model
      });
    }

    // If explicit antigravity
    if (selectedRunner === 'antigravity') {
      return new AntigravityAgentRunner();
    }

    // 4. Auto detection
    if (selectedRunner === 'auto' || !selectedRunner) {
      if (this.detectsOpenCodeEnvironment(env)) {
        const model = env.OPENCODE_MODEL || config?.opencode?.model || DEFAULT_OPENCODE_MODEL;
        return new OpenCodeAgentRunner({
          commandExecutor,
          defaultModel: model
        });
      }
      // Default safely to Antigravity
      return new AntigravityAgentRunner();
    }

    // Fallback default
    return new AntigravityAgentRunner();
  }

  private static detectsOpenCodeEnvironment(env: NodeJS.ProcessEnv): boolean {
    // 1. OpenCode environment variables
    if (env.OPENCODE || env.OPENCODE_SESSION || env.OPENCODE_PROJECT) {
      return true;
    }

    // 2. Check if opencode binary exists in PATH
    try {
      const checkCmd = process.platform === 'win32' ? 'where opencode' : 'which opencode';
      child_process.execSync(checkCmd, { stdio: 'ignore', timeout: 1000, env });
      return true;
    } catch {
      return false;
    }
  }
}
