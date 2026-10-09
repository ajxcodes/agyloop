/**
 * agyloop - AntigravityAgentRunner Infrastructure Adapter
 *
 * Implements AgentRunnerPort for the Google Antigravity runtime environment.
 */

import { AgentRunnerPort, RunnerSubagentPayload } from '../ports';

export class AntigravityAgentRunner implements AgentRunnerPort {
  public async invokeSubagent(payload: RunnerSubagentPayload): Promise<void> {
    // When executing under Antigravity, subagents are orchestrated via the Antigravity protocol/UI.
    // In headless or direct programmatic execution, this records the dispatch directive.
    if (process.env.DEBUG) {
      console.log(`[AntigravityAgentRunner] Invoking subagent: ${payload.subagentName} (role: ${payload.role})`);
    }
  }
}
