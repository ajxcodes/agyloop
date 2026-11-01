/**
 * agyloop - Shared JSON block scanner (issue #432, TR-35)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  sliceBalancedObject,
  jsObjectLiteralToJson
} = require('../../dist/domain');

describe('json-block (issue #432)', () => {
  test('JB1 slices an object containing a brace inside a string', () => {
    const raw = 'PLAN_DEVIATION:\n{ "reason": "a { b }", "n": 1 }';
    const sliced = sliceBalancedObject(raw, 0);
    assert.ok(sliced);
    assert.strictEqual(JSON.parse(sliced.text).reason, 'a { b }');
    assert.strictEqual(sliced.start, raw.indexOf('{'));
    assert.strictEqual(sliced.end, raw.length);
  });

  test('JB2 converts single-quoted JS object literals and refuses template literals', () => {
    const json = jsObjectLiteralToJson("{ reason: 'it\\'s fine', n: 1, }");
    assert.deepStrictEqual(JSON.parse(json as string), { reason: "it's fine", n: 1 });
    assert.strictEqual(jsObjectLiteralToJson('{ a: `x` }'), null);
  });

  test('JB3 returns null for an unbalanced object', () => {
    assert.strictEqual(sliceBalancedObject('{ "a": 1 ', 0), null);
  });
});
