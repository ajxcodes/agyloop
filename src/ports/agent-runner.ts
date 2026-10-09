/**
 * agyloop - AgentRunnerPort Interface
 *
 * Inversion of control contract for platform-agnostic subagent dispatch
 * across Google Antigravity, OpenCode, and future agent runtimes.
 */

export interface RunnerSubagentPayload {
  readonly subagentName: string;
  readonly role?: string;
  readonly description?: string;
  readonly model?: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly [key: string]: unknown;
}

export interface AgentRunnerPort {
  /**
   * Dispatches a subagent invocation payload to the underlying agent platform.
   */
  invokeSubagent(payload: RunnerSubagentPayload): Promise<void>;
}
