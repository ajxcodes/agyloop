/**
 * agyloop - Subject truncation grammar (issue #376, Defect 2)
 *
 * ONE shared pure trimmer drives both the conventional-commit subject and the
 * derived plan artifact filename. The cases below are the real deliveries the
 * issue records: the head must never end on an article, preposition,
 * conjunction, possessive, dangling adverb, trailing label punctuation or an
 * unmatched opening quote/bracket, and a whole word that fits exactly at the
 * budget must be kept rather than rewound away (#408, 11 chars lost).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  SUBJECT_DANGLING_TOKENS,
  hasUnclosedQuote,
  trimDanglingTail,
  truncateSubjectDescription,
  stripOwnIssueToken,
  CommitMessage
} = require('../../dist/domain');

/** The last whitespace token, lowercased and de-punctuated. */
function lastToken(head: string): string {
  const tokens = head.trim().split(/\s+/);
  const last = tokens.length > 0 ? tokens[tokens.length - 1] : '';
  return last.toLowerCase().replace(/[^a-z0-9&]+/g, '');
}

/** The pre-#376 cut: slice at the budget, then rewind to the last space. */
function naiveCut(description: string, budget: number): string {
  const head = description.slice(0, budget);
  const boundary = head.lastIndexOf(' ');
  return (boundary > 0 ? head.slice(0, boundary) : head).replace(/[,;:/\u2014.\s-]+$/u, '');
}

describe('subject truncation grammar (issue #376, Defect 2)', () => {
  test('ST1: a clause separator wins over a mid-word cut (#388, #445)', () => {
    const description388 =
      'plan evidence is never executed before APPROVAL: a false reproduced baseline';
    assert.strictEqual(
      truncateSubjectDescription(description388, 55),
      'plan evidence is never executed before APPROVAL'
    );

    const description445 = 'tier 1 critique certifies the wrong diff: the reviewer';
    assert.strictEqual(
      truncateSubjectDescription(description445, 50),
      'tier 1 critique certifies the wrong diff'
    );
  });

  test('ST2: a whole word that fits exactly at the budget is kept (#408)', () => {
    const description =
      'post-#405 gate-evidence residuals: a refused transition still reports success';
    assert.strictEqual(
      truncateSubjectDescription(description, 55),
      'post-#405 gate-evidence residuals: a refused transition'
    );
    // The fitting word is 55 characters — the pre-#376 cut discarded it and
    // under-filled the 72-char budget by 11 characters.
    assert.strictEqual(
      truncateSubjectDescription(description, 55).length,
      55
    );
  });

  test('ST3: a dangling article, preposition, conjunction, possessive or adverb is backed off (#402, #421, #428, #435, #436)', () => {
    for (const [label, description, budget] of [
      [
        '#402',
        'the root-build mutation boundary is broken at both ends of the baseline executor',
        66
      ],
      ['#421', 'the approved-plan digest is recorded at IMPLEMENT, not the APPROVAL gate', 60],
      ['#428', 'a bare repository passes the #425 non-git guard and recurses', 52],
      ['#435', 'the delivered-evidence guard is both bypassable and over-eager', 55],
      ['#436', 'the plan guards are under- and over-inclusive: a table', 55]
    ] as const) {
      // Precondition: the pre-#376 cut really did end on a dangling token.
      assert.ok(
        SUBJECT_DANGLING_TOKENS.has(lastToken(naiveCut(description, budget))),
        `precondition (${label}): the naive cut must dangle, got '${naiveCut(description, budget)}'`
      );

      const head = truncateSubjectDescription(description, budget);
      assert.ok(head.length > 0, `the head must never be empty (${label})`);
      assert.ok(
        !SUBJECT_DANGLING_TOKENS.has(lastToken(head)),
        `the head must not end on a dangling token (${label}), got: ${head}`
      );
    }
  });

  test('ST4: a tail that leaves a quote or bracket unclosed is dropped (#426)', () => {
    const description =
      'the #420 refusal teardown cannot tell \u201cnothing existed\u201d about the branch it just pushed';

    for (const budget of [52, 55]) {
      const head = truncateSubjectDescription(description, budget);
      assert.strictEqual(
        head.split('\u201c').length - 1,
        head.split('\u201d').length - 1,
        `the curly quotes must be balanced, got: ${head}`
      );
      assert.strictEqual(
        head.split('"').length % 2,
        1,
        `the straight quotes must be balanced, got: ${head}`
      );
      assert.strictEqual(
        head.split('(').length,
        head.split(')').length,
        `the brackets must be balanced, got: ${head}`
      );
      assert.strictEqual(hasUnclosedQuote(head), false, `still unclosed: ${head}`);
      assert.ok(
        !SUBJECT_DANGLING_TOKENS.has(lastToken(head)),
        `the head must not end on a dangling token, got: ${head}`
      );
    }

    // Budget 52 is the historical failure: the raw last-space cut kept
    // `\u201cnothing` and dropped its partner.
    assert.strictEqual(
      hasUnclosedQuote(naiveCut(description, 52)),
      true,
      'precondition: the naive cut must leave the quote open'
    );
  });

  test('ST5: trailing label punctuation is trimmed and a fitting description is untouched (#418)', () => {
    assert.strictEqual(
      truncateSubjectDescription('short and complete', 55),
      'short and complete'
    );

    const head = truncateSubjectDescription(
      'baseline Evidence is measured in two different cwds: the executor',
      55
    );
    assert.doesNotMatch(head, /[,;:/\u2014-]$/u, `a label may not dangle: ${head}`);
  });

  test('ST6: content-word cuts stay bounded and undangled (#439, #444, #447)', () => {
    for (const [label, scope, description, issueNumber] of [
      [
        '#439',
        'domain',
        'the reviewer prompt still states contracts the tool no longer enforces',
        439
      ],
      [
        '#444',
        'gate',
        'a PASSED gate report can declare the plan\u2019s smoke protocol passes without running it',
        444
      ],
      [
        '#447',
        'app',
        'codeloop sync silently scans only the 30 most recent pull requests and reports success',
        447
      ]
    ] as const) {
      const subject = CommitMessage.create({
        type: 'fix',
        scope,
        description,
        issueNumber
      }).toSingleLine();
      assert.ok(
        subject.length <= 72,
        `over the 72 bound (${subject.length}) for ${label}: ${subject}`
      );
      const withoutSuffix = subject.replace(/ \(#\d+\)$/, '');
      assert.ok(withoutSuffix.length > 0, `the bounded description must never be empty (${label})`);
      assert.ok(
        !SUBJECT_DANGLING_TOKENS.has(lastToken(withoutSuffix)),
        `the subject must not end on a dangling token (${label}), got: ${subject}`
      );
    }
  });

  test('ST7: the trimmer never empties a head, even when every token dangles', () => {
    // It drops until ONE token remains — an empty subject is never produced.
    assert.strictEqual(trimDanglingTail('the of and a'), 'the');
    assert.strictEqual(trimDanglingTail('the'), 'the');
    assert.strictEqual(trimDanglingTail(''), '');
    assert.strictEqual(trimDanglingTail('a query:'), 'a query');
  });

  test('ST8: the own-issue token is boundary-aware (#400)', () => {
    assert.strictEqual(stripOwnIssueToken('a plan note (#4) here', 4), 'a plan note here');
    assert.strictEqual(stripOwnIssueToken('follow-up to #400 without parens', 4), 'follow-up to #400 without parens');
    assert.strictEqual(stripOwnIssueToken('touch the #40 path', 4), 'touch the #40 path');
    assert.strictEqual(stripOwnIssueToken('trailing own token #4', 4), 'trailing own token');
    assert.strictEqual(stripOwnIssueToken('no issue given (#4)', null), 'no issue given (#4)');
  });
});
