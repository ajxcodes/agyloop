/**
 * codeloop - stale-build docs contract (#521)
 *
 * The skill is the operator-facing promise of the freshness guard. Issue #521
 * widened the guard (unsafe writes, absent `dist/`, a post-pull sync refusal and
 * `implement --no-sync`); this test keeps the documented contract in step with
 * the code instead of re-deriving it by hand.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_PATH = path.join(PROJECT_ROOT, 'skills', 'codeloop', 'SKILL.md');

describe('stale-build docs contract (#521)', () => {
  test('documents the widened stale-build guard and absent-dist state', () => {
    const doc = fs.readFileSync(SKILL_PATH, 'utf8');

    for (const literal of [
      'triage dismiss',
      'worktree clean',
      'dist/presentation/cli.js is missing',
      'implement --no-sync',
    ]) {
      assert.ok(doc.includes(literal), `skills/codeloop/SKILL.md must document '${literal}'`);
    }

    assert.ok(
      doc
        .split('\n')
        .some((line: string) => line.includes('pull') && line.includes('stale')),
      'SKILL.md must document that a sync pull can make the build stale'
    );
  });
});
