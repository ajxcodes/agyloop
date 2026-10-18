/**
 * agyloop - Pull-request ↔ issue association rules (Domain Layer) Tests
 *
 * Pure, no mocks. Covers the rule that separates *delivery evidence* (a GitHub
 * closing keyword in the PR body) from *mere association* (branch name, title).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const {
  closingKeywordPattern,
  prAssertsIssueDelivery,
  branchNameReferencesIssue
} = require('../../dist/domain');

describe('closingKeywordPattern', () => {
  test('matches GitHub closing keyword forms for the issue', () => {
    const pattern = closingKeywordPattern(226);
    const matching = [
      'Closes #226',
      'Fixes #226.',
      'fixes 226',
      'Resolved: #226',
      'CLOSES #226',
      'close #226',
      'fixed #226',
      'Resolves #226'
    ];
    for (const body of matching) {
      assert.ok(pattern.test(body), `Expected '${body}' to match issue 226`);
    }
  });

  test('rejects prose, longer issue numbers and shorter issue numbers', () => {
    const pattern = closingKeywordPattern(226);
    const nonMatching = [
      'Fixes Alpine CI failure',
      'Closes #2260',
      'Closes #22',
      'Closes #2260-fix',
      'fix(tests): narrow git branch mock (#226)',
      'prefixCloses #226'
    ];
    for (const body of nonMatching) {
      assert.ok(!pattern.test(body), `Expected '${body}' NOT to match issue 226`);
    }
  });

  test('accepts a string issue number and escapes regex metacharacters', () => {
    assert.ok(closingKeywordPattern('226').test('Closes #226'));
    assert.ok(!closingKeywordPattern('226').test('Closes #2260'));
  });
});

describe('prAssertsIssueDelivery', () => {
  test('ignores the title so a (#226) cross-reference is not delivery evidence', () => {
    assert.strictEqual(
      prAssertsIssueDelivery(
        { title: 'fix(tests): narrow git branch mock (#226)', body: 'no reference' },
        226
      ),
      false
    );
  });

  test('is case-insensitive and tolerates a null or empty body', () => {
    assert.strictEqual(prAssertsIssueDelivery({ body: 'closes #226' }, 226), true);
    assert.strictEqual(prAssertsIssueDelivery({ body: null }, 226), false);
    assert.strictEqual(prAssertsIssueDelivery({ body: '' }, 226), false);
    assert.strictEqual(prAssertsIssueDelivery({}, 226), false);
  });

  test('does not match a closing keyword aimed at a different issue', () => {
    assert.strictEqual(prAssertsIssueDelivery({ body: 'Closes #227' }, 226), false);
  });

  test('does not match the body of PR #228 (Fixes Alpine CI failure) for issue 226', () => {
    const body =
      '## Summary\n\nFixes Alpine CI failure in `tests/…`.\n\n### Fix\nNarrowed the mock…';
    assert.strictEqual(prAssertsIssueDelivery({ body }, 226), false);
  });
});

describe('branchNameReferencesIssue', () => {
  test('matches the task/ and fix/ branch conventions', () => {
    const matching = ['task/226', 'task/226-state-contracts', 'fix/226', 'FIX/226'];
    for (const name of matching) {
      assert.ok(branchNameReferencesIssue(name, 226), `Expected '${name}' to reference issue 226`);
    }
  });

  test('rejects branches that merely contain or neighbour the number', () => {
    const nonMatching = ['task/2260', 'issue/226/fix', 'feature/226', '', null, undefined];
    for (const name of nonMatching) {
      assert.ok(
        !branchNameReferencesIssue(name, 226),
        `Expected '${String(name)}' NOT to reference issue 226`
      );
    }
  });
});