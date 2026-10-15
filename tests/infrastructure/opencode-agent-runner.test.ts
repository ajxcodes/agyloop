const { describe, test } = require('node:test');
const assert = require('node:assert');
const { OpenCodeAgentRunner } = require('../../dist/infrastructure/opencode-agent-runner');
const { QuotaExhaustedError } = require('../../dist/domain');

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
    assert.strictEqual(executed.command, 'opencode');
    assert.deepStrictEqual(executed.options?.args, [
      'run',
      '--standalone',
      '--auto',
      '--model',
      'ollama/ornith:9b-128k',
      'Design architecture for Phase 6'
    ]);
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
    assert.strictEqual(mockExecutor.executedCommands[0].command, 'opencode');
    assert.deepStrictEqual(mockExecutor.executedCommands[0].options?.args, [
      'run',
      '--standalone',
      '--auto',
      '--model',
      'custom-provider/custom-model:latest',
      'Implement feature'
    ]);
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
    assert.strictEqual(mockExecutor.executedCommands[0].command, 'opencode');
    assert.deepStrictEqual(mockExecutor.executedCommands[0].options?.args, [
      'run',
      '--standalone',
      '--auto',
      '--model',
      'ollama/ornith:9b-128k',
      'Implement feature'
    ]);
  });

  test('passes prompt verbatim as argument array without shell escaping', async () => {
    const mockExecutor = new MockCommandExecutor();
    const runner = new OpenCodeAgentRunner({
      commandExecutor: mockExecutor
    });

    const rawPrompt = "Don't break 'existing' code; $(rm -rf /)";
    await runner.invokeSubagent({
      subagentName: 'tester',
      prompt: rawPrompt
    });

    assert.strictEqual(mockExecutor.executedCommands.length, 1);
    assert.strictEqual(mockExecutor.executedCommands[0].command, 'opencode');
    assert.deepStrictEqual(mockExecutor.executedCommands[0].options?.args, [
      'run',
      '--standalone',
      '--auto',
      '--model',
      'ollama/ornith:9b-128k',
      rawPrompt
    ]);
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

  test('throws QuotaExhaustedError when opencode CLI reports RESOURCE_EXHAUSTED', async () => {
    const mockExecutor = new MockCommandExecutor();
    mockExecutor.mockExitCode = 1;
    mockExecutor.mockStderr = 'RESOURCE_EXHAUSTED: quota exceeded; retry-after: 3600';

    const runner = new OpenCodeAgentRunner({ commandExecutor: mockExecutor });

    await assert.rejects(
      async () => runner.invokeSubagent({ subagentName: 'gate', prompt: 'Verify tests' }),
      (err: any) => {
        assert.ok(err instanceof QuotaExhaustedError, `expected QuotaExhaustedError, got ${err}`);
        assert.strictEqual(err.signal.isQuotaExhausted, true);
        assert.strictEqual(err.signal.retryAfterSeconds, 3600);
        assert.strictEqual(err.runner, 'opencode');
        assert.ok(err.message.includes('3600'), err.message);
        return true;
      }
    );
  });

  test('parses Retry-After header into the quota signal', async () => {
    const mockExecutor = new MockCommandExecutor();
    mockExecutor.mockExitCode = 1;
    mockExecutor.mockStderr = 'HTTP 429 Too Many Requests\nretry-after: 120';

    const runner = new OpenCodeAgentRunner({ commandExecutor: mockExecutor });

    await assert.rejects(
      async () => runner.invokeSubagent({ subagentName: 'gate', prompt: 'Verify tests' }),
      (err: any) => {
        assert.ok(err instanceof QuotaExhaustedError);
        assert.strictEqual(err.retryAfterSeconds, 120);
        assert.strictEqual(err.providerCode, 429);
        assert.strictEqual(err.quotaResetEstimated, false);
        return true;
      }
    );
  });

  test('throws QuotaExhaustedError on HTTP 429 reported only on stdout', async () => {
    const mockExecutor = new MockCommandExecutor();
    mockExecutor.mockExitCode = 1;
    mockExecutor.mockStderr = '';
    mockExecutor.mockStdout = 'HTTP 429 Too Many Requests';

    const runner = new OpenCodeAgentRunner({ commandExecutor: mockExecutor });

    await assert.rejects(
      async () => runner.invokeSubagent({ subagentName: 'gate', prompt: 'Verify tests' }),
      (err: any) => {
        assert.ok(err instanceof QuotaExhaustedError);
        assert.strictEqual(err.signal.status, 429);
        assert.strictEqual(err.retryAfterSeconds, null);
        assert.strictEqual(err.quotaResetEstimated, true);
        return true;
      }
    );
  });

  test('keeps the plain Error shape for non-quota failures with empty stderr', async () => {
    const mockExecutor = new MockCommandExecutor();
    mockExecutor.mockExitCode = 2;
    mockExecutor.mockStderr = '';
    mockExecutor.mockStdout = 'network unreachable';

    const runner = new OpenCodeAgentRunner({ commandExecutor: mockExecutor });

    await assert.rejects(
      async () => runner.invokeSubagent({ subagentName: 'gate', prompt: 'Verify tests' }),
      /OpenCode execution failed with exit code 2: network unreachable/
    );
  });
});
