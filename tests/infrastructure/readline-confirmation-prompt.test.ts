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
