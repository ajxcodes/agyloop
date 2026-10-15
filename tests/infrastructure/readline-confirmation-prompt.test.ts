/**
 * agyloop - ReadlineConfirmationPrompt Infrastructure Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');
const { ReadlineConfirmationPrompt } = require('../../dist/infrastructure');

function createMockStreams(simulatedInput: string) {
  const input = Readable.from([simulatedInput]);
  const output = new Writable({
    write(_chunk: any, _encoding: any, callback: any) {
      callback();
    }
  });
  return { input, output };
}

describe('ReadlineConfirmationPrompt (Infrastructure Layer)', () => {
  test('returns true for affirmative inputs: y', async () => {
    const { input, output } = createMockStreams('y\n');
    const prompt = new ReadlineConfirmationPrompt({ input, output });
    const result = await prompt.confirm('Proceed?');
    assert.strictEqual(result, true);
  });

  test('returns true for affirmative inputs: yes (uppercase)', async () => {
    const { input, output } = createMockStreams('YES\n');
    const prompt = new ReadlineConfirmationPrompt({ input, output });
    const result = await prompt.confirm('Proceed?');
    assert.strictEqual(result, true);
  });

  test('returns false for negative input: n', async () => {
    const { input, output } = createMockStreams('n\n');
    const prompt = new ReadlineConfirmationPrompt({ input, output });
    const result = await prompt.confirm('Proceed?');
    assert.strictEqual(result, false);
  });

  test('returns default value when input is empty', async () => {
    const { input, output } = createMockStreams('\n');
    const prompt = new ReadlineConfirmationPrompt({ input, output });
    const result = await prompt.confirm('Proceed?', false);
    assert.strictEqual(result, false);

    const { input: in2, output: out2 } = createMockStreams('\n');
    const prompt2 = new ReadlineConfirmationPrompt({ input: in2, output: out2 });
    const result2 = await prompt2.confirm('Proceed?', true);
    assert.strictEqual(result2, true);
  });

  test('returns false for arbitrary non-affirmative text', async () => {
    const { input, output } = createMockStreams('maybe later\n');
    const prompt = new ReadlineConfirmationPrompt({ input, output });
    const result = await prompt.confirm('Proceed?');
    assert.strictEqual(result, false);
  });
});

// --- Zero-Hang Invariant (issue #218 / AC6) ---------------------------------
// A silent-but-open stdin pipe (CI, cron, `npm test`) never fires `question`,
// `close` or `error`, so the promise would never settle and the runner would hang
// forever. The adapter must be structurally incapable of blocking such a caller.

describe('ReadlineConfirmationPrompt non-interactive self-guard', () => {
  test('resolves the default value immediately when interactive is false', { timeout: 2000 }, async () => {
    const prompt = new ReadlineConfirmationPrompt({ interactive: false });
    assert.strictEqual(await prompt.confirm('Proceed?', true), true);
    assert.strictEqual(await prompt.confirm('Proceed?', false), false);
    // No defaultValue supplied at all -> the port's default (false).
    assert.strictEqual(await prompt.confirm('Proceed?'), false);
  });

  test('never opens a readline interface when interactive is false', { timeout: 2000 }, async () => {
    // The injected stream *would* answer "y". Resolving the default instead proves
    // no readline interface was ever attached to it, so no hang is possible.
    const { input, output } = createMockStreams('y\n');
    const prompt = new ReadlineConfirmationPrompt({ input, output, interactive: false });
    assert.strictEqual(await prompt.confirm('Proceed?', false), false);
    assert.strictEqual(await prompt.confirm('Proceed?', true), true);
  });

  test('treats non-TTY default process streams as non-interactive', { timeout: 2000 }, async () => {
    const originalStdin = process.stdin.isTTY;
    const originalStdout = process.stdout.isTTY;
    try {
      (process.stdin as any).isTTY = false;
      (process.stdout as any).isTTY = false;

      const prompt = new ReadlineConfirmationPrompt();
      assert.strictEqual(await prompt.confirm('Proceed?', true), true);
      assert.strictEqual(await prompt.confirm('Proceed?', false), false);
    } finally {
      (process.stdin as any).isTTY = originalStdin;
      (process.stdout as any).isTTY = originalStdout;
    }
  });

  test('treats a half-TTY session (stdin only) as non-interactive', { timeout: 2000 }, async () => {
    const originalStdin = process.stdin.isTTY;
    const originalStdout = process.stdout.isTTY;
    try {
      (process.stdin as any).isTTY = true;
      (process.stdout as any).isTTY = false;

      const prompt = new ReadlineConfirmationPrompt();
      assert.strictEqual(await prompt.confirm('Proceed?', true), true);
    } finally {
      (process.stdin as any).isTTY = originalStdin;
      (process.stdout as any).isTTY = originalStdout;
    }
  });

  test('keeps injected streams interactive even when the process streams are not TTYs', async () => {
    const originalStdin = process.stdin.isTTY;
    const originalStdout = process.stdout.isTTY;
    try {
      (process.stdin as any).isTTY = false;
      (process.stdout as any).isTTY = false;

      const { input, output } = createMockStreams('y\n');
      const prompt = new ReadlineConfirmationPrompt({ input, output });
      assert.strictEqual(await prompt.confirm('Proceed?'), true);
    } finally {
      (process.stdin as any).isTTY = originalStdin;
      (process.stdout as any).isTTY = originalStdout;
    }
  });

  test('honours an explicit interactive override over the inferred value', async () => {
    const originalStdin = process.stdin.isTTY;
    const originalStdout = process.stdout.isTTY;
    try {
      (process.stdin as any).isTTY = false;
      (process.stdout as any).isTTY = false;

      const { input, output } = createMockStreams('n\n');
      const prompt = new ReadlineConfirmationPrompt({ input, output, interactive: true });
      assert.strictEqual(await prompt.confirm('Proceed?', true), false);
    } finally {
      (process.stdin as any).isTTY = originalStdin;
      (process.stdout as any).isTTY = originalStdout;
    }
  });
});
