/**
 * agyloop - Test Register parsing (issue #432, TR-33 / TR-44)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseTestRegister,
  readTestRegister,
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

  test('TRD5 a table register parses rows and skips the header and separator', () => {
    const table = [
      '### Test Register',
      '',
      '| Case | Pins | Asserts |',
      '| --- | --- | --- |',
      '| **TR-1** the standard leg | **Pins:** `tests/pinned.test.ts` :: `fresh run halts at PLAN` | **Asserts:** `assert.strictEqual(result.pausedAtGate, GATE_APPROVAL)` |',
      '| **TR-2** an escaped \\| pipe | **New test:** `tests/new.test.ts` :: `an escaped \\| title` | **Asserts:** `assert.strictEqual(a, 1)` |'
    ].join('\n');
    const rows = parseTestRegister(table);
    assert.deepStrictEqual(rows.map((row: any) => row.id), ['TR-1', 'TR-2']);
    assert.strictEqual(rows[0].pins.title, 'fresh run halts at PLAN');
    assert.strictEqual(rows[1].newTest.title, 'an escaped | title');
  });

  test('TRD6 a register heading with no parsable row reports present and zero rows', () => {
    const section = readTestRegister([
      '# Plan',
      '',
      '### Test Register',
      '',
      '| Case | Assertions |',
      '| --- | --- |',
      '| plain row with no bold id | nothing |'
    ].join('\n'));
    assert.strictEqual(section.present, true);
    assert.strictEqual(section.rows.length, 0);
    assert.strictEqual(section.headingLine, 3);
  });

  const IT_SOURCE = [
    "const assert = require('node:assert');",
    "it('resolves base branch', () => {",
    '  const pausedAtGate = undefined;',
    '  assert.strictEqual(pausedAtGate, undefined);',
    '});'
  ].join('\n');

  test('TRD7 an it-declared case resolves and the block starts at its line', () => {
    const block = extractTestBlock(IT_SOURCE, 'resolves base branch');
    assert.ok(block);
    assert.strictEqual(block.line, 2);
    assert.strictEqual(block.text.includes('assert.strictEqual(pausedAtGate, undefined);'), true);
  });

  test('TRD8 findDuplicateNewTest recognises it and its modifiers', () => {
    assert.strictEqual(findDuplicateNewTest(IT_SOURCE, 'resolves base branch'), true);
    assert.strictEqual(findDuplicateNewTest(IT_SOURCE, 'another title'), false);
    assert.strictEqual(
      findDuplicateNewTest("it.only('focused case', () => {});", 'focused case'),
      true
    );
  });

  test('TRD9 a table row without a pin marker still parses as a row', () => {
    const rows = parseTestRegister([
      '### Test Register',
      '| **TR-1** a row with no marker | **Asserts:** `assert.strictEqual(a, 1)` |'
    ].join('\n'));
    assert.deepStrictEqual(rows.map((row: any) => row.id), ['TR-1']);
    assert.strictEqual(rows[0].pins, null);
  });

  test('TRD10 the scaffold guidance comment is not a register, but an empty heading is', () => {
    const scaffold = [
      '# Plan',
      '',
      '### Test Register',
      '<!-- One row per pinned assertion: `- **TR-1** — **Pins:** `path` :: `test title`` (or `**New test:**`) plus a `**Asserts:**` literal. A `Pins:` row must restate the pinned literal exactly; APPROVAL refuses a contradicting row and names `file:line`. -->'
    ].join('\n');
    const scaffoldSection = readTestRegister(scaffold);
    assert.strictEqual(scaffoldSection.present, false);

    const emptySection = readTestRegister(['# Plan', '', '### Test Register', ''].join('\n'));
    assert.strictEqual(emptySection.present, true);
    assert.strictEqual(emptySection.rows.length, 0);
    assert.strictEqual(emptySection.headingLine, 3);

    const noBoldId = readTestRegister([
      '# Plan',
      '',
      '### Test Register',
      '| Case | Assertions |',
      '| --- | --- |',
      '| plain row with no bold id | nothing |'
    ].join('\n'));
    assert.strictEqual(noBoldId.present, true);
    assert.strictEqual(noBoldId.rows.length, 0);
  });
});
