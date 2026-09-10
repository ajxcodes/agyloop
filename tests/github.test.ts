const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  getCurrentRepo,
  fetchIssueContext,
  formatIssueForPrompt
} = require('../dist');

describe('GitHub Context Discovery (TypeScript)', () => {
  test('getCurrentRepo detects active git repository slug', () => {
    const repo = getCurrentRepo();
    assert.ok(repo !== null, 'Repository should be detected');
    assert.strictEqual(typeof repo, 'string');
    assert.ok(repo.includes('/'), 'Repository slug should follow owner/repo format');
  });

  test('formatIssueForPrompt formats issue details and discussion into clean markdown', () => {
    const mockIssue = {
      repo: 'ajxcodes/agyloop',
      number: 42,
      title: 'Fix edge case in state machine',
      body: 'When transitioning under high concurrency, state may become inconsistent.',
      labels: ['bug', 'p1'],
      comments: [
        {
          author: 'alice',
          body: 'Reproduced on Node 20.',
          createdAt: '2026-09-10T10:00:00Z'
        },
        {
          author: 'bob',
          body: 'Working on patch now.',
          createdAt: '2026-09-10T10:30:00Z'
        }
      ]
    };

    const formatted = formatIssueForPrompt(mockIssue);

    assert.ok(formatted.includes('### Active Issue: #42 - Fix edge case in state machine'));
    assert.ok(formatted.includes('**Repository:** `ajxcodes/agyloop`'));
    assert.ok(formatted.includes('**Labels:** bug, p1'));
    assert.ok(formatted.includes('When transitioning under high concurrency'));
    assert.ok(formatted.includes('#### Discussion & Comments (2):'));
    assert.ok(formatted.includes('> **@alice** (2026-09-10T10:00:00Z):'));
    assert.ok(formatted.includes('> Reproduced on Node 20.'));
    assert.ok(formatted.includes('> **@bob** (2026-09-10T10:30:00Z):'));
  });

  test('formatIssueForPrompt handles error objects gracefully', () => {
    const errorIssue = {
      repo: 'ajxcodes/agyloop',
      number: 99,
      title: '',
      body: '',
      labels: [],
      comments: [],
      error: 'Not Found'
    };

    const formatted = formatIssueForPrompt(errorIssue);
    assert.ok(formatted.includes('Associated GitHub Issue: #99'));
    assert.ok(formatted.includes('Warning: Unable to fetch live issue details: Not Found'));
  });

  test('fetchIssueContext returns null for empty or null issue number', () => {
    assert.strictEqual(fetchIssueContext(0), null);
    assert.strictEqual(fetchIssueContext(-1), null);
  });
});
