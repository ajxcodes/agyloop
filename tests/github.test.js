const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  getCurrentRepo,
  formatIssueForPrompt,
  fetchIssueContext
} = require('../lib/github');

describe('GitHub Context Discovery', () => {
  test('getCurrentRepo detects active git repository slug', () => {
    const repo = getCurrentRepo();
    assert.ok(typeof repo === 'string');
    assert.strictEqual(repo, 'ajxcodes/agyloop');
  });

  test('formatIssueForPrompt formats issue details and discussion into clean markdown', () => {
    const mockIssue = {
      number: 42,
      title: 'Fix edge-case transition loop in state machine',
      repo: 'ajxcodes/agyloop',
      labels: ['bug', 'p1'],
      body: 'State machine gets trapped in DISCOVERY if issue context is invalid.',
      comments: [
        {
          author: 'developer1',
          body: 'We should verify that loadConfig does not return undefined.',
          createdAt: '2026-09-10T12:00:00Z'
        }
      ]
    };

    const formatted = formatIssueForPrompt(mockIssue);
    assert.ok(formatted.includes('Active Issue: #42 - Fix edge-case transition loop in state machine'));
    assert.ok(formatted.includes('**Repository:** `ajxcodes/agyloop`'));
    assert.ok(formatted.includes('**Labels:** bug, p1'));
    assert.ok(formatted.includes('State machine gets trapped'));
    assert.ok(formatted.includes('@developer1'));
    assert.ok(formatted.includes('We should verify that loadConfig'));
  });

  test('formatIssueForPrompt handles error objects gracefully', () => {
    const errorIssue = {
      number: 99999,
      repo: 'ajxcodes/agyloop',
      error: 'Could not resolve to an issue with that number.'
    };

    const formatted = formatIssueForPrompt(errorIssue);
    assert.ok(formatted.includes('Associated GitHub Issue: #99999'));
    assert.ok(formatted.includes('Unable to fetch live issue details'));
  });

  test('fetchIssueContext returns null for empty or null issue number', () => {
    assert.strictEqual(fetchIssueContext(null), null);
    assert.strictEqual(fetchIssueContext(''), null);
  });
});
