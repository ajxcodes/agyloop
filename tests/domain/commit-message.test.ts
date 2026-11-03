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

describe('72-character subject bound (issue #345 in #339, T11.8 / AC-4.4)', () => {
  // The real delivery titles that produced 178- and 208-character subjects.
  const TITLE_336 =
    '[Phase 6] [Bug] TRIAGE records a dismissal that never happened: ' +
    '`dismiss` without `-m` consumes the gate, `status` hides the disposition, ' +
    'and the shipped skill documents the skip rule backwards';
  const TITLE_338 =
    '[Phase 6] [Bug] Gate evidence is unpublished and under-reported: an undocumented ' +
    '`smokeChecks`/`notRun` shape rejects blocks at filing, and the summary keeps ' +
    'metrics a round never measured (absorbs #343)';

  const SUBJECT_LIMIT = 72;

  function draftSubject(title: string, issueNumber: number): string {
    return CommitMessage.create({
      type: 'fix',
      scope: 'gate',
      description: title,
      issueNumber
    }).toSingleLine();
  }

  for (const [label, title, issueNumber] of [
    ['#336 (178-char title)', TITLE_336, 336],
    ['#338 (208-char title)', TITLE_338, 338]
  ] as const) {
    test(`T11.8: the ${label} is truncated at a word boundary within 72 characters`, () => {
      assert.ok(title.length > SUBJECT_LIMIT, 'precondition: the title must over-run the limit');

      const subject = draftSubject(title, issueNumber);
      assert.ok(
        subject.length <= SUBJECT_LIMIT,
        `subject exceeds ${SUBJECT_LIMIT} chars (${subject.length}): ${subject}`
      );

      // `type(scope): ` and the ` (#N)` suffix survive the truncation.
      const prefix = 'fix(gate): ';
      const suffix = ` (#${issueNumber})`;
      assert.ok(subject.startsWith(prefix), subject);
      assert.ok(subject.endsWith(suffix), `the issue token must survive: ${subject}`);

      // Every word in the surviving description is a WHOLE word from the input
      // — a word-boundary cut, never a mid-word slice.
      //
      // Issue #376: a clause-boundary cut (and the dangling-token backoff)
      // strips a trailing `,`/`;`/`:`/`—`, so the comparison normalises that on
      // both sides instead of demanding byte equality of the last word.
      const normaliseWord = (word: string) => word.replace(/[,;:\u2014]+$/u, '');
      const truncatedDesc = subject.slice(prefix.length, subject.length - suffix.length);
      assert.doesNotMatch(truncatedDesc, /[,;:/\u2014-]$/u, `a label may not dangle: ${subject}`);
      const inputWords = title.split(' ').map(normaliseWord);
      const keptWords = truncatedDesc.split(' ').map(normaliseWord);
      for (const word of keptWords) {
        assert.ok(inputWords.includes(word), `partial word emitted: '${word}' in ${subject}`);
      }
      // …and it really was truncated, not emitted whole.
      assert.ok(keptWords.length < inputWords.length, `the title was not truncated: ${subject}`);
    });
  }

  test('T11.8: a short description is left untouched by the bound', () => {
    const msg = CommitMessage.create({
      type: 'fix',
      scope: 'gate',
      description: 'publish gate evidence',
      issueNumber: 338
    });
    assert.strictEqual(msg.toSingleLine(), 'fix(gate): publish gate evidence (#338)');
  });

  test('T11.8: toFullMessage headers the SAME bounded subject (draft === commit)', () => {
    const msg = CommitMessage.create({
      type: 'fix',
      scope: 'gate',
      description: TITLE_338,
      body: 'Body text.',
      issueNumber: 338
    });
    const header = msg.toFullMessage().split('\n')[0];
    assert.strictEqual(header, msg.toSingleLine());
    assert.ok(header.length <= SUBJECT_LIMIT, `header exceeds the limit: ${header.length}`);
  });

  test('T11.8-376: an explicit -m keeps (#400) and stays within 72', () => {
    const msg = CommitMessage.parse(
      'fix(cli): correct plan subagent attribution and Tier 1 critique failure signalling (#400)'
    );
    const subject = msg.toSingleLine();
    assert.strictEqual(
      subject,
      'fix(cli): correct plan subagent attribution and Tier 1 critique (#400)'
    );
    assert.strictEqual(subject.length, 70);
    assert.ok(subject.includes('(#400)'), `the issue token must survive: ${subject}`);
  });

  test("T11.8-376: the #388 title ends on APPROVAL, not the article 'a'", () => {
    const subject = CommitMessage.create({
      type: 'fix',
      scope: 'app',
      description:
        'plan evidence is never executed before APPROVAL: a false reproduced baseline, smoke blocks that die at seed',
      issueNumber: 388
    }).toSingleLine();
    assert.strictEqual(subject, 'fix(app): plan evidence is never executed before APPROVAL (#388)');
    assert.ok(subject.length <= SUBJECT_LIMIT, `subject exceeds ${SUBJECT_LIMIT}: ${subject}`);
  });

  test("T11.8-376: a #N mention of a DIFFERENT issue does not suppress this issue's suffix", () => {
    const followUp = CommitMessage.create({
      type: 'fix',
      scope: 'app',
      description: 'follow-up to #400 without the paren form',
      issueNumber: 4
    });
    assert.strictEqual(
      followUp.toSingleLine(),
      'fix(app): follow-up to #400 without the paren form (#4)'
    );
    assert.ok(followUp.toSingleLine().includes('#400'), 'another issue token must survive');

    const prefixCollision = CommitMessage.create({
      type: 'fix',
      scope: 'app',
      description: 'touch the #40 path',
      issueNumber: 4
    });
    assert.strictEqual(prefixCollision.toSingleLine(), 'fix(app): touch the #40 path (#4)');

    // …and THIS issue's own token is normalised out and re-appended exactly
    // once, so an explicit `-m` cannot lose it to the bound.
    const own = CommitMessage.create({
      type: 'fix',
      scope: 'app',
      description: 'a bounded description (#4)',
      issueNumber: 4
    });
    assert.strictEqual(own.toSingleLine(), 'fix(app): a bounded description (#4)');
  });

  test('T11.8-376: the #408 whole word that fits exactly at the budget is kept', () => {
    const subject = CommitMessage.create({
      type: 'fix',
      scope: 'app',
      description:
        'post-#405 gate-evidence residuals: a refused transition still reports success',
      issueNumber: 408
    }).toSingleLine();
    assert.strictEqual(
      subject,
      'fix(app): post-#405 gate-evidence residuals: a refused transition (#408)'
    );
    assert.strictEqual(subject.length, 72);
  });
});
