/**
 * agyloop - CommitMessage Value Object Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  CommitMessage,
  COMMIT_TYPE_FEAT,
  COMMIT_TYPE_FIX,
  COMMIT_TYPE_REFACTOR,
  COMMIT_TYPE_TEST,
  ValidationError
} = require('../../dist/domain');

describe('CommitMessage Value Object', () => {
  test('creates valid commit message with type and description', () => {
    const msg = CommitMessage.create({
      type: COMMIT_TYPE_FEAT,
      description: 'add commit drafting functionality'
    });

    assert.strictEqual(msg.type, 'feat');
    assert.strictEqual(msg.scope, null);
    assert.strictEqual(msg.description, 'add commit drafting functionality');
    assert.strictEqual(msg.isBreaking, false);
    assert.strictEqual(msg.toSingleLine(), 'feat: add commit drafting functionality');
    assert.strictEqual(msg.toFullMessage(), 'feat: add commit drafting functionality');
  });

  test('formats single line with scope and issue number', () => {
    const msg = CommitMessage.create({
      type: COMMIT_TYPE_FIX,
      scope: 'reviewer',
      description: 'correct verdict parsing',
      issueNumber: 30
    });

    assert.strictEqual(msg.scope, 'reviewer');
    assert.strictEqual(msg.issueNumber, 30);
    assert.strictEqual(msg.toSingleLine(), 'fix(reviewer): correct verdict parsing (#30)');
  });

  test('does not duplicate issue number if already in description', () => {
    const msg = CommitMessage.create({
      type: COMMIT_TYPE_REFACTOR,
      scope: 'domain',
      description: 'clean up error hierarchy (#30)',
      issueNumber: 30
    });

    assert.strictEqual(msg.toSingleLine(), 'refactor(domain): clean up error hierarchy (#30)');
  });

  test('formats breaking change with exclamation mark and footer', () => {
    const msg = CommitMessage.create({
      type: COMMIT_TYPE_FEAT,
      scope: 'api',
      description: 'change pipeline lifecycle transition',
      body: 'The transition contract now requires an explicit confirmation callback.',
      isBreaking: true
    });

    assert.strictEqual(msg.isBreaking, true);
    assert.strictEqual(msg.toSingleLine(), 'feat(api)!: change pipeline lifecycle transition');
    const full = msg.toFullMessage();
    assert.ok(full.startsWith('feat(api)!: change pipeline lifecycle transition\n\n'));
    assert.ok(full.includes('The transition contract now requires an explicit confirmation callback.'));
    assert.ok(full.includes('BREAKING CHANGE: change pipeline lifecycle transition'));
  });

  test('preserves existing BREAKING CHANGE footer in body without duplication', () => {
    const msg = CommitMessage.create({
      type: COMMIT_TYPE_FEAT,
      description: 'remove deprecated v1 API',
      body: 'BREAKING CHANGE: v1 API endpoints are permanently deleted.',
      isBreaking: true
    });

    const full = msg.toFullMessage();
    const count = (full.match(/BREAKING CHANGE/g) || []).length;
    assert.strictEqual(count, 1);
  });

  test('serializes to JSON cleanly', () => {
    const msg = CommitMessage.create({
      type: COMMIT_TYPE_TEST,
      scope: 'gate',
      description: 'verify isolated shell execution',
      issueNumber: 25
    });

    const json = msg.toJSON();
    assert.strictEqual(json.type, 'test');
    assert.strictEqual(json.scope, 'gate');
    assert.strictEqual(json.description, 'verify isolated shell execution');
    assert.strictEqual(json.issueNumber, 25);
    assert.strictEqual(json.singleLine, 'test(gate): verify isolated shell execution (#25)');
  });

  test('parses simple single line conventional commit', () => {
    const raw = 'feat(reviewer): add ai reviewer subagent (#28)';
    const parsed = CommitMessage.parse(raw);

    assert.strictEqual(parsed.type, 'feat');
    assert.strictEqual(parsed.scope, 'reviewer');
    assert.strictEqual(parsed.description, 'add ai reviewer subagent (#28)');
    assert.strictEqual(parsed.issueNumber, 28);
    assert.strictEqual(parsed.isBreaking, false);
  });

  test('parses breaking change commit with exclamation mark', () => {
    const raw = 'fix(core)!: update state schema version';
    const parsed = CommitMessage.parse(raw);

    assert.strictEqual(parsed.type, 'fix');
    assert.strictEqual(parsed.scope, 'core');
    assert.strictEqual(parsed.isBreaking, true);
  });

  test('parses multi-line commit message with body and footer', () => {
    const raw = `feat(pipeline): implement human approval gate (#30)

Detailed explanation of the human-in-the-loop confirmation invariant.

BREAKING CHANGE: silent commits are strictly forbidden.`;

    const parsed = CommitMessage.parse(raw);
    assert.strictEqual(parsed.type, 'feat');
    assert.strictEqual(parsed.scope, 'pipeline');
    assert.strictEqual(parsed.issueNumber, 30);
    assert.strictEqual(parsed.isBreaking, true);
    assert.ok(parsed.body?.includes('Detailed explanation of the human-in-the-loop confirmation invariant.'));
  });

  test('rejects invalid commit types', () => {
    assert.throws(
      () => CommitMessage.create({ type: 'invalid_type', description: 'some work' }),
      ValidationError
    );
  });

  test('rejects empty description', () => {
    assert.throws(
      () => CommitMessage.create({ type: 'feat', description: '   ' }),
      ValidationError
    );
  });

  test('rejects illegal characters in scope', () => {
    assert.throws(
      () => CommitMessage.create({ type: 'feat', scope: 'bad scope with spaces!', description: 'some work' }),
      ValidationError
    );
  });

  test('rejects invalid raw message during parse', () => {
    assert.throws(
      () => CommitMessage.parse('non-conventional commit message here'),
      ValidationError
    );
  });
});
