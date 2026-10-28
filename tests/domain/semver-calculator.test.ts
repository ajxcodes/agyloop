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

  /* ----------------------------------------------------------------------- *
   * Squash bodies (issue #257 / #315, AC-26, AC-27, AC-31)
   * ----------------------------------------------------------------------- */

  test('a squash body renders its deliverables as first-class entries', () => {
    // The real shape: `-` bullets, plus a `*` bullet and a nested one.
    const body = [
      '- fix(worktree): keep the repository root',
      '* fix(lifecycle): forward noWorktree',
      '  * fix(preflight): halt on evidence'
    ].join('\n');

    const evalResult = SemVerCalculator.evaluate([
      { header: 'fix(worktree): [Phase 6] teardown (#247) (#253)', body }
    ]);

    const entries = evalResult.changelog
      .split('\n')
      .filter((line: string) => line.trim().startsWith('- '));
    assert.strictEqual(entries.length, 4, evalResult.changelog);
    assert.strictEqual(evalResult.totalCommits, 4);
    assert.strictEqual(evalResult.commitObjects, 1);
    assert.strictEqual(evalResult.fixesCount, 4);
    assert.ok(
      evalResult.changelog.includes('**lifecycle:** forward noWorktree'),
      evalResult.changelog
    );
    assert.ok(
      evalResult.changelog.includes('**preflight:** halt on evidence'),
      evalResult.changelog
    );
  });

  test('a bullet repeating the subject is not duplicated', () => {
    const evalResult = SemVerCalculator.evaluate([
      { header: 'fix(x): y', body: '- fix(x): y' }
    ]);

    assert.strictEqual(evalResult.totalCommits, 1);
    assert.strictEqual(evalResult.commitObjects, 1);
    const occurrences = evalResult.changelog.split('**x:** y').length - 1;
    assert.strictEqual(occurrences, 1, evalResult.changelog);
  });

  test('the headline counts deliverables, not commit objects', () => {
    const body = [
      '- fix(a): one',
      '- fix(b): two',
      '- fix(c): three',
      '- feat(d): four'
    ].join('\n');

    const evalResult = SemVerCalculator.evaluate([{ header: 'fix(scope): primary', body }]);

    assert.strictEqual(evalResult.commitObjects, 1);
    assert.strictEqual(evalResult.totalCommits, 5, 'subject + 4 bullets');
    assert.strictEqual(evalResult.fixesCount, 4);
    assert.strictEqual(evalResult.featuresCount, 1);
    // The bump follows the deliverables too: one feat ⇒ MINOR.
    assert.strictEqual(evalResult.bump, RELEASE_BUMP_MINOR);
  });

  /* ----------------------------------------------------------------------- *
   * The real release range (issue #315 review round 1: AC-26, AC-27)
   *
   * `fixtures/real-range-phase6-codeloop.json` is `git log main..phase/6-codeloop
   * --format='%s%x1f%b%x1e'` captured at `cb10f48` (44 commit objects, 4 of them
   * merge objects). It is frozen so these assertions cannot drift with the
   * branch, and every number below is reproducible from that command.
   * ----------------------------------------------------------------------- */

  const realRange = require('./fixtures/real-range-phase6-codeloop.json');

  test('the real range: merge commits are topology, never deliverables', () => {
    const evalResult = SemVerCalculator.evaluate(realRange);

    assert.strictEqual(evalResult.commitObjects, 44, 'the fixture is the real range');
    assert.strictEqual(
      evalResult.deliverables.filter((d: any) => d.header.startsWith('Merge pull request')).length,
      0,
      'a merge object is not work'
    );
    assert.ok(
      !evalResult.changelog.includes('Merge pull request'),
      `published notes must never list a merge object:\n${evalResult.changelog}`
    );
  });

  test('the real range: the headline is the deduped deliverable total', () => {
    const evalResult = SemVerCalculator.evaluate(realRange);

    // 40 conventional subjects + 133 body bullets = 173, minus the 9 bullets
    // that restate a commit already in the range → 164.
    assert.strictEqual(evalResult.totalCommits, 164);
    assert.strictEqual(evalResult.featuresCount, 5);
    assert.strictEqual(evalResult.fixesCount, 44);

    const lines = evalResult.changelog
      .split('\n')
      .filter((line: string) => line.trim().startsWith('- '));
    assert.strictEqual(lines.length, evalResult.totalCommits, 'one rendered entry per deliverable');
    assert.strictEqual(
      new Set(lines).size,
      lines.length,
      `the changelog must not render the same deliverable twice:\n${lines.join('\n')}`
    );
  });

  test('the real range: a self-echoing bullet is counted once', () => {
    // Three real commits whose squash body repeats their own subject with a
    // SHORTER trailing reference group (`(#218) (#219)` subject, `(#218)`
    // bullet). An exact-description dedupe missed them; normalising the refs
    // collapses the pair.
    const evalResult = SemVerCalculator.evaluate(realRange);
    for (const needle of [
      'harden installer, quota pauses',
      'implement OpenCode IDE & CLI compatibility layer',
      'prune legacy js artifacts'
    ]) {
      const occurrences = evalResult.changelog
        .split('\n')
        .filter((line: string) => line.includes(needle)).length;
      assert.strictEqual(occurrences, 1, `${needle} must appear once:\n${evalResult.changelog}`);
    }
  });

  test('the real range: wrapped bullets are joined, never truncated', () => {
    // The first bullet of the #327 squash body wraps over five lines. The old
    // one-line-per-bullet reader published the first fragment and dropped the
    // other four.
    const evalResult = SemVerCalculator.evaluate(realRange);
    const entries = evalResult.changelog
      .split('\n')
      .filter((line: string) => line.trim().startsWith('- '));

    assert.ok(
      entries.some((entry: string) =>
        entry.includes(
          'and records implementationDispatchCount without advancing the stage.'
        )
      ),
      `the wrapped bullet must survive whole:\n${evalResult.changelog}`
    );
    assert.ok(
      entries.some((entry: string) => entry.includes('table-derived legal walk-back.')),
      'the last wrapped bullet must keep its tail'
    );
    assert.deepStrictEqual(
      entries.filter((entry: string) => /\bwith the existing$/.test(entry)),
      [],
      'no entry may stop mid-sentence'
    );
  });
});
