/**
 * agyloop - Dispatch-counter warning vocabulary (issue #242, absorbs #309.2)
 *
 * The counter label union and the warning sentence used to be inline in
 * `get-next-action.ts`. They now live in `src/domain/constants.ts` so all four
 * counters are byte-identical by construction.
 *
 * D1 - the counter vocabulary is exactly the four shipped kinds
 * D2 - each kind produces the exact operator sentence (four byte-for-byte pins)
 * D3 - the template is shared: both placeholders exist and no kind is baked in
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  DISPATCH_COUNTER_KINDS,
  MSG_DISPATCH_COUNTER_UNRECORDED_TEMPLATE,
  formatDispatchCounterUnrecorded
} = require('../../dist/domain');

const STATE_PATH = '/tmp/x/.agyloop/tasks/242.json';

describe('dispatch-counter warning', () => {
  test('D1: the counter vocabulary is the four shipped kinds', () => {
    assert.deepStrictEqual(
      [...DISPATCH_COUNTER_KINDS],
      ['review', 'discovery', 'plan', 'implementation']
    );
  });

  test('D2: every counter emits the exact sentence', () => {
    const expectations: Record<string, string> = {
      review: `[codeloop] Warning: could not record the review dispatch counter at ${STATE_PATH}; returning the directive unchanged.`,
      discovery: `[codeloop] Warning: could not record the discovery dispatch counter at ${STATE_PATH}; returning the directive unchanged.`,
      plan: `[codeloop] Warning: could not record the plan dispatch counter at ${STATE_PATH}; returning the directive unchanged.`,
      implementation: `[codeloop] Warning: could not record the implementation dispatch counter at ${STATE_PATH}; returning the directive unchanged.`
    };

    for (const kind of DISPATCH_COUNTER_KINDS) {
      assert.strictEqual(formatDispatchCounterUnrecorded(kind, STATE_PATH), expectations[kind]);
    }
  });

  test('D3: the template is shared and no kind is hard-coded into it', () => {
    assert.ok(MSG_DISPATCH_COUNTER_UNRECORDED_TEMPLATE.includes('{counter}'));
    assert.ok(MSG_DISPATCH_COUNTER_UNRECORDED_TEMPLATE.includes('{path}'));

    for (const kind of DISPATCH_COUNTER_KINDS) {
      assert.ok(
        !MSG_DISPATCH_COUNTER_UNRECORDED_TEMPLATE.includes(kind),
        `the template hard-codes the ${kind} label`
      );
    }

    const review = formatDispatchCounterUnrecorded('review', STATE_PATH);
    const plan = formatDispatchCounterUnrecorded('plan', STATE_PATH);
    assert.notStrictEqual(review, plan);
    assert.strictEqual(
      review.split('review').join('<counter>'),
      plan.split('plan').join('<counter>'),
      'the two strings may differ only at the counter label'
    );
  });
});
