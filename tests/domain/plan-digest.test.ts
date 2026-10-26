/**
 * agyloop - Plan digest normalization tests (issue #298, AC9)
 *
 * PD1 - checkbox ticks do not change the normalized plan
 * PD2 - a real content edit does
 * PD3 - CRLF and trailing whitespace are noise, trailing blanks are ignored
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { normalizePlanForDigest } = require('../../dist/domain');

describe('normalizePlanForDigest (issue #298)', () => {
  test('PD1: checkbox ticks normalize to the same digest input', () => {
    const unticked = ['# Plan', '', '- [ ] Step one', '- [ ] Step two', ''].join('\n');
    const ticked = ['# Plan', '', '- [x] Step one', '- [X] Step two', ''].join('\n');

    assert.strictEqual(normalizePlanForDigest(ticked), normalizePlanForDigest(unticked));
    assert.ok(normalizePlanForDigest(ticked).includes('- [ ] Step one'));
  });

  test('PD2: a real content edit changes the digest input', () => {
    const before = ['# Plan', '', '## Quality Gate Targets', '- `npm test`', ''].join('\n');
    const after = ['# Plan', '', '## Quality Gate Targets', '- `npm run lint`', ''].join('\n');

    assert.notStrictEqual(normalizePlanForDigest(after), normalizePlanForDigest(before));
  });

  test('PD3: CRLF, trailing whitespace and trailing blank lines are ignored', () => {
    const lf = ['# Plan', '', '- [ ] Step one', ''].join('\n');
    const noisy = '# Plan   \r\n\r\n- [ ] Step one\t\r\n\r\n\r\n';

    assert.strictEqual(normalizePlanForDigest(noisy), normalizePlanForDigest(lf));
    assert.ok(normalizePlanForDigest(noisy).endsWith('\n'));
    assert.ok(!normalizePlanForDigest(noisy).endsWith('\n\n'));
  });
});
