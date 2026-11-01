/**
 * agyloop - PlanDeviation value object (issue #432, TR-1..TR-3)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseBlocks,
  planDeviationIdentity,
  isUnacknowledged
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
});
