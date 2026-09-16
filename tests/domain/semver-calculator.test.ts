/**
 * agyloop - SemVerCalculator Value Object Unit Tests
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  SemVerCalculator,
  RELEASE_BUMP_MAJOR,
  RELEASE_BUMP_MINOR,
  RELEASE_BUMP_PATCH,
  RELEASE_LABEL_MAJOR,
  RELEASE_LABEL_MINOR,
  RELEASE_LABEL_PATCH
} = require('../../dist/domain');

describe('SemVerCalculator Value Object', () => {
  test('predicts PATCH for bug fix commits only', () => {
    const commits = [
      'fix: resolve memory leak in worker pool',
      'fix(core): handle null pointer in parser'
    ];

    const evalResult = SemVerCalculator.evaluateCommits(commits);

    assert.strictEqual(evalResult.bump, RELEASE_BUMP_PATCH);
    assert.strictEqual(evalResult.releaseLabel, RELEASE_LABEL_PATCH);
    assert.strictEqual(evalResult.fixesCount, 2);
    assert.strictEqual(evalResult.featuresCount, 0);
    assert.strictEqual(evalResult.breakingCount, 0);
  });

  test('predicts MINOR when new features are present', () => {
    const commits = [
      'feat: add websocket bridge adapter',
      'fix: handle reconnection timeout'
    ];

    const evalResult = SemVerCalculator.evaluateCommits(commits);

    assert.strictEqual(evalResult.bump, RELEASE_BUMP_MINOR);
    assert.strictEqual(evalResult.releaseLabel, RELEASE_LABEL_MINOR);
    assert.strictEqual(evalResult.featuresCount, 1);
    assert.strictEqual(evalResult.fixesCount, 1);
    assert.strictEqual(evalResult.breakingCount, 0);
  });

  test('predicts MAJOR when breaking change is present via exclamation mark', () => {
    const commits = [
      'feat!: redesign public configuration API',
      'feat: add new options'
    ];

    const evalResult = SemVerCalculator.evaluateCommits(commits);

    assert.strictEqual(evalResult.bump, RELEASE_BUMP_MAJOR);
    assert.strictEqual(evalResult.releaseLabel, RELEASE_LABEL_MAJOR);
    assert.strictEqual(evalResult.breakingCount, 1);
  });

  test('predicts MAJOR when BREAKING CHANGE footer is present', () => {
    const commits = [
      'feat(auth): require api key in headers\n\nBREAKING CHANGE: legacy tokens are no longer accepted'
    ];

    const evalResult = SemVerCalculator.evaluateCommits(commits);

    assert.strictEqual(evalResult.bump, RELEASE_BUMP_MAJOR);
    assert.strictEqual(evalResult.releaseLabel, RELEASE_LABEL_MAJOR);
    assert.strictEqual(evalResult.breakingCount, 1);
  });

  test('enforces escalation order: MAJOR > MINOR > PATCH', () => {
    // 10 fixes cannot demote 1 feature (MINOR)
    const commits = [
      'feat: add feature A',
      'fix: bug 1',
      'fix: bug 2',
      'fix: bug 3',
      'fix: bug 4',
      'fix: bug 5'
    ];

    const evalResult = SemVerCalculator.evaluateCommits(commits);
    assert.strictEqual(evalResult.bump, RELEASE_BUMP_MINOR);

    // 1 breaking change escalates all to MAJOR
    const withBreaking = [...commits, 'fix!: critical breaking fix'];
    const evalBreaking = SemVerCalculator.evaluateCommits(withBreaking);
    assert.strictEqual(evalBreaking.bump, RELEASE_BUMP_MAJOR);
  });

  test('generates categorized changelog properly formatted in markdown', () => {
    const commits = [
      'feat(bridge): add websocket connector',
      'fix: handle connection reset by peer',
      'docs: update getting started guide'
    ];

    const evalResult = SemVerCalculator.evaluateCommits(commits);
    const changelog = evalResult.changelog;

    assert(changelog.includes('### Features'));
    assert(changelog.includes('**bridge:** add websocket connector'));
    assert(changelog.includes('### Bug Fixes'));
    assert(changelog.includes('handle connection reset by peer'));
    assert(changelog.includes('### Maintenance & Refactoring'));
    assert(changelog.includes('update getting started guide'));
  });

  test('defaults to PATCH when no commits or chore-only commits are present', () => {
    const commits = ['chore: bump dependencies'];
    const evalResult = SemVerCalculator.evaluateCommits(commits);

    assert.strictEqual(evalResult.bump, RELEASE_BUMP_PATCH);
    assert.strictEqual(evalResult.releaseLabel, RELEASE_LABEL_PATCH);
  });
});
