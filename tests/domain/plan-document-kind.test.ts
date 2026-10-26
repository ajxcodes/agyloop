/**
 * agyloop - Plan document kind tests (issue #299)
 *
 * The discriminator looks at the TITLE LINE only: a real implementation plan may
 * legitimately carry a "Root Cause Analysis" section, so headings alone cannot
 * classify a document.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isDiscoveryPlanDocument } = require('../../dist/domain');

describe('isDiscoveryPlanDocument (#299)', () => {
  test('accepts a discovery-scaffold title', () => {
    assert.strictEqual(isDiscoveryPlanDocument('# [Discovery] - Some bug\n\nbody'), true);
    assert.strictEqual(isDiscoveryPlanDocument('\n\n# [Discovery] - Leading blanks\n'), true);
    assert.strictEqual(isDiscoveryPlanDocument('# [discovery] - lowercase\n'), true);
  });

  test('rejects an implementation document that carries an RCA section', () => {
    const implementationPlan = [
      '# [Implementation] - Plan artifacts are wrong',
      '',
      '## 2. Root Cause Analysis (RCA)',
      '- **Identified Failure Mode:** the mirror held the RCA template'
    ].join('\n');
    assert.strictEqual(isDiscoveryPlanDocument(implementationPlan), false);
  });

  test('rejects empty and non-string input', () => {
    assert.strictEqual(isDiscoveryPlanDocument(''), false);
    assert.strictEqual(isDiscoveryPlanDocument(null as unknown as string), false);
    assert.strictEqual(isDiscoveryPlanDocument('some prose with no title'), false);
  });
});
