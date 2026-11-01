/**
 * agyloop - Test Register parsing (issue #432, TR-33 / TR-44)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseTestRegister,
  extractTestBlock,
  normaliseAssertion,
  findContradiction,
  findDuplicateNewTest
} = require('../../dist/domain');

const SOURCE = [
  "const assert = require('node:assert');",
  "test('fresh run halts at PLAN', () => {",
  '  const result = { pausedAtGate: undefined };',
  '  assert.strictEqual(result.pausedAtGate, undefined);',
  '});'
].join('\n');

const REGISTER = [
  '## 4. Test Register',
  '',
  '- **TR-1** — the fresh run',
  '  - **Pins:** `tests/application/run-lifecycle.test.ts` :: `fresh run halts at PLAN`',
  '  - **Asserts:** `assert.strictEqual(result.pausedAtGate, GATE_APPROVAL)`',
  '- **TR-2** — **New test:** `tests/domain/none.test.ts` :: `a brand-new case`',
  '  - **Asserts:** `assert.strictEqual(blocks.length, 2)`',
  '',
  '## 5. Quality Gate Targets',
  '- `npm run lint`'
].join('\n');

describe('Test Register (issue #432)', () => {
  test('TRD1 extracts the pinned block by title', () => {
    const block = extractTestBlock(SOURCE, 'fresh run halts at PLAN');
    assert.ok(block);
    assert.ok(block.text.includes('assert.strictEqual(result.pausedAtGate, undefined);'));
    assert.strictEqual(block.line, 2);

    const contradiction = findContradiction(
      ['`assert.strictEqual(result.pausedAtGate, GATE_APPROVAL)`'],
      block.text,
      block.line
    );
    assert.ok(contradiction);
    assert.strictEqual(contradiction.subject, 'result.pausedAtGate');
    assert.strictEqual(contradiction.pinnedValue, 'undefined');
    assert.strictEqual(contradiction.line, 4);
  });

  test('TRD2 a register row inside a smoke fence is not parsed', () => {
    const fenced = [
      '### Manual Smoke Test Protocol',
      '',
      '```bash',
      '### Test Register',
      '- **TR-9** — **New test:** `x.test.ts` :: `fenced row`',
      '  - **Asserts:** `assert.strictEqual(a, 1)`',
      '```',
      '',
      REGISTER
    ].join('\n');
    const rows = parseTestRegister(fenced);
    assert.deepStrictEqual(
      rows.map((row: any) => row.id),
      ['TR-1', 'TR-2']
    );
    assert.strictEqual(rows[0].pins.title, 'fresh run halts at PLAN');
    assert.strictEqual(rows[1].newTest.title, 'a brand-new case');
  });

  test('TRD3 normalises equality shapes and refuses non-assertions', () => {
    assert.deepStrictEqual(normaliseAssertion('assert.strictEqual(a.b, 2)'), {
      subject: 'a.b',
      operator: '===',
      expected: '2'
    });
    assert.deepStrictEqual(normaliseAssertion('assert.ok(a.b === 2)'), {
      subject: 'a.b',
      operator: '===',
      expected: '2'
    });
    assert.strictEqual(normaliseAssertion('const x = 2'), null);
  });

  test('TRD4 a duplicate New test title is detected', () => {
    assert.strictEqual(findDuplicateNewTest(SOURCE, 'fresh run halts at PLAN'), true);
    assert.strictEqual(findDuplicateNewTest(SOURCE, 'another title'), false);
  });
});
