/**
 * codeloop - PlanDeviation value object (issue #432, TR-1..TR-3)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseBlocks,
  planDeviationIdentity,
  isUnacknowledged,
  PLAN_DEVIATION_EXAMPLE
} = require('../../dist/domain');

const BLOCK = [
  'Some prose before the block.',
  'PLAN_DEVIATION:',
  '{ "planSection": "§4.2 row IMPL-428-4 (d)",',
  '  "planLiteral": "result.pausedAtGate === GATE_APPROVAL",',
  '  "implementedAssertion": "result.currentStage === STAGE_PLAN",',
  '  "reason": "the fresh-run case already pins STAGE_PLAN",',
  '  "files": ["tests/application/run-lifecycle.test.ts:664"] }'
].join('\n');

describe('PlanDeviation (issue #432)', () => {
  test('PD1 parses one block with all required fields', () => {
    const blocks = parseBlocks(BLOCK);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].planSection, '§4.2 row IMPL-428-4 (d)');
    assert.strictEqual(blocks[0].planLiteral, 'result.pausedAtGate === GATE_APPROVAL');
    assert.strictEqual(blocks[0].implementedAssertion, 'result.currentStage === STAGE_PLAN');
    assert.strictEqual(blocks[0].reason, 'the fresh-run case already pins STAGE_PLAN');
    assert.deepStrictEqual([...blocks[0].files], ['tests/application/run-lifecycle.test.ts:664']);
  });

  test('PD2 refuses a block with a missing field', () => {
    const text = [
      'PLAN_DEVIATION:',
      '{ "planSection": "§4.2", "planLiteral": "a", "reason": "because" }'
    ].join('\n');
    assert.throws(() => parseBlocks(text), /implementedAssertion/);
  });

  test('PD3 files the same identity twice as one record', () => {
    const a = parseBlocks(BLOCK)[0];
    const b = parseBlocks(BLOCK.replace('  ', ' '))[0];
    assert.strictEqual(planDeviationIdentity(a), planDeviationIdentity(b));
  });

  test('PD4 a fresh record is unacknowledged and a comment marker is prose', () => {
    assert.strictEqual(isUnacknowledged({ acknowledged: false } as any), true);
    const commented = `# PLAN_DEVIATION:\n{ "planSection": "x", "planLiteral": "a", "implementedAssertion": "b", "reason": "c" }`;
    assert.throws(() => parseBlocks(commented), /PLAN_DEVIATION/);
  });

  test('PD5 parses a prose-label block into the four required fields (#451)', () => {
    const prose = [
      'PLAN_DEVIATION:',
      'Plan section: §3 Implementation Step 3',
      'Plan literal: const jsonBase = shellQuote(a);',
      'Implemented: const jsonBase = shellQuote(b);',
      'Reason: the frozen idiom is banned'
    ].join('\n');
    const blocks = parseBlocks(prose);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].planSection, '§3 Implementation Step 3');
    assert.strictEqual(blocks[0].planLiteral, 'const jsonBase = shellQuote(a);');
    assert.strictEqual(blocks[0].implementedAssertion, 'const jsonBase = shellQuote(b);');
    assert.strictEqual(blocks[0].reason, 'the frozen idiom is banned');
    assert.deepStrictEqual([...blocks[0].files], []);
  });

  test('PD6 a malformed block names all four keys and shows the accepted shape (#451 AC2)', () => {
    const text = ['PLAN_DEVIATION:', '{ "planSection": "§4.2" }'].join('\n');
    let msg = '';
    try {
      parseBlocks(text);
    } catch (err: any) {
      msg = err.message;
    }
    for (const key of ['planSection', 'planLiteral', 'implementedAssertion', 'reason']) {
      assert.ok(msg.includes(key), `the refusal must name ${key}: ${msg}`);
    }
    assert.ok(msg.includes(PLAN_DEVIATION_EXAMPLE), `the refusal must show the shape: ${msg}`);
  });

  test('PD7 a narrative line that names the marker does not swallow the following block (#451)', () => {
    const jsonText = [
      'Per the directive, I emit one PLAN_DEVIATION: block per changed literal:',
      'PLAN_DEVIATION:',
      '{ "planSection": "§4.2", "planLiteral": "a", "implementedAssertion": "b", "reason": "c" }'
    ].join('\n');
    const json = parseBlocks(jsonText);
    assert.strictEqual(json.length, 1);
    assert.strictEqual(json[0].implementedAssertion, 'b');

    const proseText = [
      'Per the directive, I emit one PLAN_DEVIATION: block per changed literal:',
      'PLAN_DEVIATION:',
      'Plan section: §4.2',
      'Plan literal: a',
      'Implemented: b',
      'Reason: c'
    ].join('\n');
    const prose = parseBlocks(proseText);
    assert.strictEqual(prose.length, 1);
    assert.strictEqual(prose[0].implementedAssertion, 'b');
  });

  test('PD8 parses a JS object literal with unquoted keys (#451 AC3)', () => {
    const text = [
      'PLAN_DEVIATION:',
      '{ planSection: "§4.2", planLiteral: "a === 1", implementedAssertion: "a === 2", reason: "pinned" }'
    ].join('\n');
    const blocks = parseBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].planLiteral, 'a === 1');
    assert.strictEqual(blocks[0].implementedAssertion, 'a === 2');
  });
});
