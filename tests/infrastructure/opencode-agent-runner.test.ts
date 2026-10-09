const { describe, test } = require('node:test');
const assert = require('node:assert');
const { OpenCodeAgentRunner } = require('../../dist/infrastructure/opencode-agent-runner');

class MockCommandExecutor {
  public executedCommands: Array<{ command: string; options?: any }> = [];
  public mockExitCode: number = 0;
  public mockStdout: string = 'Mock output';
  public mockStderr: string = '';

  public async execute(command: string, options?: any): Promise<any> {
    this.executedCommands.push({ command, options });
    return {
      command,
      exitCode: this.mockExitCode,
      stdout: this.mockStdout,
      stderr: this.mockStderr,
      combinedOutput: this.mockStdout + this.mockStderr,
      durationMs: 50,
      timedOut: false
    };
  }
}

describe('OpenCodeAgentRunner', () => {
  test('formats the command correctly and executes the opencode CLI via the mock executor', async () => {
    const mockExecutor = new MockCommandExecutor();
    const runner = new OpenCodeAgentRunner({
      commandExecutor: mockExecutor,
      defaultModel: 'ollama/ornith:9b-128k'
    });

    await runner.invokeSubagent({
      subagentName: 'planner',
      prompt: 'Design architecture for Phase 6',
      cwd: '/tmp/test-workspace'
    });

    assert.strictEqual(mockExecutor.executedCommands.length, 1);
    const executed = mockExecutor.executedCommands[0];
    assert.strictEqual(
      executed.command,
      "opencode run --standalone --auto --model ollama/ornith:9b-128k 'Design architecture for Phase 6'"
    );
    assert.strictEqual(executed.options?.cwd, '/tmp/test-workspace');
  });

  test('overrides default model if specified in invocation payload', async () => {
    const mockExecutor = new MockCommandExecutor();
    const runner = new OpenCodeAgentRunner({
      commandExecutor: mockExecutor,
      defaultModel: 'ollama/ornith:9b-128k'
    });

    await runner.invokeSubagent({
      subagentName: 'implementer',
      prompt: 'Implement feature',
      model: 'custom-provider/custom-model:latest'
    });

    assert.strictEqual(mockExecutor.executedCommands.length, 1);
    assert.strictEqual(
      mockExecutor.executedCommands[0].command,
      "opencode run --standalone --auto --model custom-provider/custom-model:latest 'Implement feature'"
    );
  });

  test('normalizes model name without provider prefix to ollama/ provider', async () => {
    const mockExecutor = new MockCommandExecutor();
    const runner = new OpenCodeAgentRunner({
      commandExecutor: mockExecutor,
      defaultModel: 'ornith:9b-128k'
    });

    await runner.invokeSubagent({
      subagentName: 'implementer',
      prompt: 'Implement feature'
    });

    assert.strictEqual(mockExecutor.executedCommands.length, 1);
    assert.strictEqual(
      mockExecutor.executedCommands[0].command,
      "opencode run --standalone --auto --model ollama/ornith:9b-128k 'Implement feature'"
    );
  });

  test('escapes single quotes in prompt safely', async () => {
    const mockExecutor = new MockCommandExecutor();
    const runner = new OpenCodeAgentRunner({
      commandExecutor: mockExecutor
    });

    await runner.invokeSubagent({
      subagentName: 'tester',
      prompt: "Don't break 'existing' code"
    });

    assert.strictEqual(mockExecutor.executedCommands.length, 1);
    assert.strictEqual(
      mockExecutor.executedCommands[0].command,
      "opencode run --standalone --auto --model ollama/ornith:9b-128k 'Don'\\''t break '\\''existing'\\'' code'"
    );
  });

  test('throws error if opencode CLI returns non-zero exit code', async () => {
    const mockExecutor = new MockCommandExecutor();
    mockExecutor.mockExitCode = 1;
    mockExecutor.mockStderr = 'Model not found';

    const runner = new OpenCodeAgentRunner({
      commandExecutor: mockExecutor
    });

    await assert.rejects(
      async () => {
        await runner.invokeSubagent({
          subagentName: 'gate',
          prompt: 'Verify tests'
        });
      },
      /OpenCode execution failed with exit code 1: Model not found/
    );
  });
});
