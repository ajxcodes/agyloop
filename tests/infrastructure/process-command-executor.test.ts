const { test, describe } = require('node:test');
const assert = require('node:assert');
const { ProcessCommandExecutor } = require('../../dist');

describe('ProcessCommandExecutor (Infrastructure Layer)', () => {
  const executor = new ProcessCommandExecutor();

  test('executes successful command and buffers stdout and stderr', async () => {
    const result = await executor.execute('node -e "console.log(\'test-stdout\'); console.error(\'test-stderr\');"');

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.timedOut, false);
    assert.ok(result.stdout.includes('test-stdout'));
    assert.ok(result.stderr.includes('test-stderr'));
    assert.ok(result.combinedOutput.includes('test-stdout'));
    assert.ok(result.combinedOutput.includes('test-stderr'));
    assert.ok(result.durationMs >= 0);
  });

  test('captures non-zero exit code on failure', async () => {
    const result = await executor.execute('node -e "process.exit(42);"');

    assert.strictEqual(result.exitCode, 42);
    assert.strictEqual(result.timedOut, false);
  });

  test('enforces timeout and flags timedOut', async () => {
    const startTime = Date.now();
    const result = await executor.execute(
      'node -e "setTimeout(() => {}, 3000);"',
      { timeoutMs: 200 }
    );
    const elapsed = Date.now() - startTime;

    assert.strictEqual(result.timedOut, true);
    assert.notStrictEqual(result.exitCode, 0);
    assert.ok(elapsed < 2500, `Execution took ${elapsed}ms, expected timeout around 200ms`);
  });
});
