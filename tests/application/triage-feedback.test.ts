/**
 * agyloop - PR Feedback Classification Tests (issue #269, Defect 1)
 *
 * The classifier is what tells ACTIONABLE review feedback apart from the
 * repository's own automated summaries and from the TOOL's own replies.
 *
 * TF1 - a plain human review comment is actionable
 * TF2 - an automated summary is a status post, not actionable
 * TF3 - an inline dismissal marker makes a comment an own reply
 * TF4 - a conversation dismissal footer makes a comment an own reply
 * TF5 - classifyPrFeedback partitions a mixed list, own replies first
 * TF6 - feedbackKeyOf returns `id:<n>` / a content key
 * TF7 - feedbackKeysOf de-duplicates
 * TF8 - the three moved helpers behave IDENTICALLY to their pre-move bodies
 * TF9 - actionableReviewFeedback is the ONE selector: identity, order, exclusions (issue #397)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  actionableReviewFeedback,
  classifyPrFeedback,
  feedbackKeyOf,
  feedbackKeysOf,
  isAutomatedSummaryPost,
  isToolOwnedPrReply,
  prFeedbackKey,
  isDismissalReply,
  isInlineDismissalReply
} = require('../../dist/application');
const {
  DISMISS_CONVERSATION_REPLY_FOOTER,
  DISMISS_CONVERSATION_REPLY_REFERENCE_PREFIX,
  DISMISS_INLINE_REPLY_MARKER,
  DISMISS_INLINE_REPLY_SIGNATURE,
  REGEX_PR_FEEDBACK_HEADER,
  REGEX_PR_FEEDBACK_FOOTER
} = require('../../dist/domain');

/**
 * The PRE-MOVE bodies of the three helpers, copied verbatim from
 * `src/application/triage-pr-comments.ts` before issue #269 moved them. TF8
 * asserts the move was a MOVE, not a rewrite.
 */
function legacyPrFeedbackKey(body: string): string {
  const withoutHeader = (body || '').replace(REGEX_PR_FEEDBACK_HEADER, '');
  const withoutFooter = withoutHeader.replace(REGEX_PR_FEEDBACK_FOOTER, '');
  return withoutFooter.replace(/\s+/g, ' ').trim().toLowerCase();
}

function legacyIsDismissalReply(body: string): boolean {
  const text = body || '';
  return (
    text.includes(DISMISS_CONVERSATION_REPLY_FOOTER) ||
    text.includes(DISMISS_CONVERSATION_REPLY_REFERENCE_PREFIX)
  );
}

function legacyIsInlineDismissalReply(body: string): boolean {
  const text = body || '';
  return (
    text.includes(DISMISS_INLINE_REPLY_MARKER) ||
    text.includes(DISMISS_INLINE_REPLY_SIGNATURE) ||
    legacyIsDismissalReply(text)
  );
}

const SUMMARY_BODY = '## Critique AI Review Run Summary\n\nNo findings.';
const HUMAN_BODY = 'Please fix the nil dereference in resolve-subagent.ts';
const INLINE_REPLY_BODY = `Reviewed.\n\n${DISMISS_INLINE_REPLY_MARKER}`;
const CONVERSATION_REPLY_BODY = `Reviewed.\n\n${DISMISS_CONVERSATION_REPLY_FOOTER}\n> Please fix the nil dereference`;

describe('PR feedback classification (issue #269)', () => {
  test('TF1: a plain human review comment is actionable', () => {
    const classified = classifyPrFeedback([{ author: 'reviewer', body: HUMAN_BODY }]);
    assert.strictEqual(classified.actionable.length, 1);
    assert.strictEqual(classified.statusPosts.length, 0);
    assert.strictEqual(classified.ownReplies.length, 0);
    assert.strictEqual(isAutomatedSummaryPost(HUMAN_BODY), false);
  });

  test('TF2: an automated summary is a status post, not actionable', () => {
    const classified = classifyPrFeedback([{ author: 'github-actions[bot]', body: SUMMARY_BODY }]);
    assert.strictEqual(classified.actionable.length, 0);
    assert.strictEqual(classified.statusPosts.length, 1);
    assert.strictEqual(classified.ownReplies.length, 0);
    assert.strictEqual(isAutomatedSummaryPost(SUMMARY_BODY), true);

    // The marker match is case-insensitive.
    assert.strictEqual(
      isAutomatedSummaryPost('## critique ai review run summary\n\nno findings'),
      true
    );
    assert.strictEqual(isAutomatedSummaryPost('## CodeLoop AI Review Run Summary'), true);
    assert.strictEqual(isAutomatedSummaryPost('## Critique Review Summary'), true);
  });

  test('TF3: an inline dismissal marker makes a comment an own reply', () => {
    const classified = classifyPrFeedback([
      { author: 'me', body: INLINE_REPLY_BODY, surface: 'inline' }
    ]);
    assert.strictEqual(classified.ownReplies.length, 1);
    assert.strictEqual(classified.actionable.length, 0);
    assert.strictEqual(isToolOwnedPrReply(INLINE_REPLY_BODY, 'inline'), true);
  });

  test('TF4: a conversation dismissal footer makes a comment an own reply', () => {
    const classified = classifyPrFeedback([
      { author: 'me', body: CONVERSATION_REPLY_BODY, surface: 'conversation' }
    ]);
    assert.strictEqual(classified.ownReplies.length, 1);
    assert.strictEqual(classified.actionable.length, 0);
    assert.strictEqual(isToolOwnedPrReply(CONVERSATION_REPLY_BODY, 'conversation'), true);
  });

  test('TF5: classifyPrFeedback partitions a mixed list, own replies first', () => {
    const classified = classifyPrFeedback([
      { id: 101, author: 'reviewer', body: HUMAN_BODY },
      { id: 102, author: 'github-actions[bot]', body: SUMMARY_BODY },
      { id: 103, author: 'me', body: INLINE_REPLY_BODY, surface: 'inline' },
      { id: 104, author: 'me', body: CONVERSATION_REPLY_BODY, surface: 'conversation' }
    ]);

    assert.deepStrictEqual(
      classified.actionable.map((c: any) => c.id),
      [101]
    );
    assert.deepStrictEqual(
      classified.statusPosts.map((c: any) => c.id),
      [102]
    );
    assert.deepStrictEqual(
      classified.ownReplies.map((c: any) => c.id),
      [103, 104]
    );

    // The tool's OWN reply wins over the summary test: a dismissal reply that
    // quotes a summary title is still the tool's own reply.
    const ownReplyQuotingASummary = classifyPrFeedback([
      { id: 105, author: 'me', body: `${INLINE_REPLY_BODY}\n\n${SUMMARY_BODY}` }
    ]);
    assert.strictEqual(ownReplyQuotingASummary.ownReplies.length, 1);
    assert.strictEqual(ownReplyQuotingASummary.statusPosts.length, 0);
    assert.strictEqual(ownReplyQuotingASummary.actionable.length, 0);
  });

  test('TF6: feedbackKeyOf returns id:<n> for a comment with an id and a content key otherwise', () => {
    assert.strictEqual(feedbackKeyOf({ id: 101, body: HUMAN_BODY }), 'id:101');
    assert.strictEqual(
      feedbackKeyOf({ body: HUMAN_BODY }),
      `body:${legacyPrFeedbackKey(HUMAN_BODY)}`
    );
    // The body key is NORMALISED: whitespace and case do not change it.
    assert.strictEqual(
      feedbackKeyOf({ body: '  Please   FIX\nthe nil dereference ' }),
      feedbackKeyOf({ body: 'please fix the nil dereference' })
    );
  });

  test('TF7: feedbackKeysOf de-duplicates', () => {
    const keys = feedbackKeysOf([
      { id: 101, body: HUMAN_BODY },
      { id: 101, body: HUMAN_BODY },
      { id: 102, body: HUMAN_BODY },
      { body: HUMAN_BODY }
    ]);
    assert.deepStrictEqual(keys, ['id:101', 'id:102', `body:${legacyPrFeedbackKey(HUMAN_BODY)}`]);
  });

  test('TF8: the three moved helpers behave IDENTICALLY to their pre-move bodies', () => {
    const bodies = [
      '',
      HUMAN_BODY,
      SUMMARY_BODY,
      INLINE_REPLY_BODY,
      CONVERSATION_REPLY_BODY,
      `**Review feedback on \`src/app.ts\` (Line 42):** please fix this\n*Powered by review-bot*`,
      'Dismissing this inline review thread: something',
      'Answering PR conversation comment: https://example.invalid/pr/7#issuecomment-3'
    ];

    for (const body of bodies) {
      assert.strictEqual(
        prFeedbackKey(body),
        legacyPrFeedbackKey(body),
        `prFeedbackKey drifted for: ${JSON.stringify(body)}`
      );
      assert.strictEqual(
        isDismissalReply(body),
        legacyIsDismissalReply(body),
        `isDismissalReply drifted for: ${JSON.stringify(body)}`
      );
      assert.strictEqual(
        isInlineDismissalReply(body),
        legacyIsInlineDismissalReply(body),
        `isInlineDismissalReply drifted for: ${JSON.stringify(body)}`
      );
    }
  });

  test('TF9: actionableReviewFeedback is the ONE selector (issue #397)', () => {
    const actionableOne = { id: 4427630468, author: 'critique', body: HUMAN_BODY };
    const summary = { id: 6531579688, author: 'github-actions[bot]', body: SUMMARY_BODY };
    const ownReply = { id: 4427630609, author: 'me', body: INLINE_REPLY_BODY };
    const actionableTwo = { id: 4427630608, author: 'critique', body: 'Please rename this.' };
    const comments = [actionableOne, summary, ownReply, actionableTwo];

    const selected = actionableReviewFeedback(comments);

    // Identity, not a copy: the callers rely on membership tests.
    assert.deepStrictEqual(selected.map((c: any) => c.id), [4427630468, 4427630608]);
    assert.strictEqual(selected[0], actionableOne);
    assert.strictEqual(selected[1], actionableTwo);
    assert.strictEqual(
      selected.length,
      classifyPrFeedback(comments).actionable.length,
      'the selector diverged from classifyPrFeedback'
    );

    assert.deepStrictEqual(
      actionableReviewFeedback([summary, { id: 4, body: SUMMARY_BODY }]),
      []
    );
  });
});
