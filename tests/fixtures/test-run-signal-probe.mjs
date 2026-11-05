import test from 'node:test';
import assert from 'node:assert';

test('probe 1: the runner executed this file', () => {
  assert.strictEqual(1 + 1, 2);
});

test('probe 2: a second case proves the file was not skipped', () => {
  assert.ok(true);
});
