/**
 * agyloop - the commit exclusion list (issue #301, absorbing #319)
 *
 * ONE predicate decides both what the draft PRINTS and what the commit
 * UNTRACKS, so `Files to commit (N)` can never disagree with the committed
 * paths. These are the unit-level pins for that predicate.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { COMMIT_EXCLUDED_PATHSPECS, isCommitExcludedPath } = require('../../dist/domain');

describe('#301: the shared commit exclusion predicate', () => {
  test('excludes the three bookkeeping trees and everything under them', () => {
    for (const path of [
      '.agyloop',
      '.agyloop/tasks/1.json',
      'artifacts',
      'artifacts/plans/x.md',
      './artifacts',
      'artifacts/',
      'node_modules',
      'node_modules/a/b.js',
      '.agyloop\\state.json'
    ]) {
      assert.strictEqual(isCommitExcludedPath(path), true, `${path} must be excluded`);
    }
  });

  test('does not exclude lookalikes or ordinary files', () => {
    for (const path of [
      'src/app.ts',
      'artifacts.md',
      'node_modules.txt',
      'README.md',
      '.gitignore',
      '',
      '.agyloop-notes.md'
    ]) {
      assert.strictEqual(isCommitExcludedPath(path), false, `${path} must not be excluded`);
    }
  });

  test('the list is frozen and exactly the three pathspecs', () => {
    assert.ok(Object.isFrozen(COMMIT_EXCLUDED_PATHSPECS));
    assert.deepStrictEqual([...COMMIT_EXCLUDED_PATHSPECS], ['.agyloop', 'node_modules', 'artifacts']);
  });
});
