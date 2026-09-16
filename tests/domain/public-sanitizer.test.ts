/**
 * agyloop - PublicSanitizer Value Object Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { PublicSanitizer } = require('../../dist/domain');

describe('PublicSanitizer Value Object', () => {
  test('strips private tracker URLs from commit message header and body', () => {
    const input = 'feat(bridge): implement websocket handler (ajxcodes/projects#88)\n\nCloses https://github.com/ajxcodes/projects/issues/88';
    const sanitized = PublicSanitizer.sanitizeCommitMessage(input);

    assert(!sanitized.includes('ajxcodes/projects#88'));
    assert(!sanitized.includes('https://github.com/ajxcodes/projects/issues/88'));
    assert(sanitized.includes('feat(bridge): implement websocket handler'));
  });

  test('strips markdown links to private tracker from PR description', () => {
    const prBody = `## Overview
Addresses internal epic: [#88](https://github.com/ajxcodes/projects/issues/88)
Tracked in: ajxcodes/projects#88

### Changes
- Add websocket client`;

    const sanitized = PublicSanitizer.sanitizeMarkdown(prBody);

    assert(!sanitized.includes('ajxcodes/projects'));
    assert(sanitized.includes('### Changes'));
    assert(sanitized.includes('- Add websocket client'));
  });

  test('preserves public repository issue references without private tracker prefix', () => {
    const commit = 'fix: resolve race condition in worker (#42)';
    const sanitized = PublicSanitizer.sanitizeCommitMessage(commit);

    assert.strictEqual(sanitized, 'fix: resolve race condition in worker (#42)');
  });

  test('preserves commit text unchanged if no private tracker URLs exist', () => {
    const text = 'chore: upgrade typescript to v7.0.2\n\nNo breaking changes.';
    assert.strictEqual(PublicSanitizer.sanitizeCommitMessage(text), text);
  });

  test('sanitizes multiple occurrences of internal tracker URLs across lines', () => {
    const text = `Refs: ajxcodes/projects#12
Related: https://github.com/ajxcodes/projects/issues/13
Fixes ajxcodes/projects#14`;

    const sanitized = PublicSanitizer.sanitizeMarkdown(text);
    assert(!sanitized.includes('ajxcodes/projects'));
  });
});
