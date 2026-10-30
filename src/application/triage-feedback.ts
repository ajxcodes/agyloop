/**
 * agyloop - PR Feedback Classification (Application Layer)
 *
 * The pure classifier that tells ACTIONABLE review feedback apart from the
 * repository's own automated summaries and from the TOOL's own replies.
 *
 * WHY THIS EXISTS (issue #269, Defect 1)
 *
 * The TRIAGE detector used to count EVERY comment on an OPEN pull request as
 * review feedback. That counted:
 *
 * - the repository's own `critique.yml` status post (a summary that by
 *   construction reports zero findings), and
 * - the tool's OWN dismissal replies — so dismissing feedback INCREASED the
 *   count the detector saw.
 *
 * The classifier partitions the fetched comments into three buckets:
 *
 * | Bucket        | Predicate                                             | Consequence |
 * |---------------|-------------------------------------------------------|-------------|
 * | `ownReplies`  | carries one of the tool's dismissal markers           | NEVER counted |
 * | `statusPosts` | body contains an automated-summary marker             | NOT actionable |
 * | `actionable`  | everything else                                       | counted |
 *
 * The classification is deliberately NARROW: the summary test is an explicit
 * marker list, not a "bot authored it" heuristic. A bot's INLINE findings are
 * actionable and must still route — the critique workflow posts inline
 * comments for every real finding.
 *
 * The three helpers that used to live in `triage-pr-comments.ts` were MOVED
 * here verbatim (`prFeedbackKey`, `isDismissalReply`, `isInlineDismissalReply`);
 * `triage-pr-comments.ts` re-exports them so the public API is unchanged.
 *
 * The selector is shared by the DISPATCHERS and the TRIAGE COMMAND (issue
 * #397): one predicate decides what the subagent evaluates and what the
 * command answers, so the two can never drift.
 */

import {
  DISMISS_CONVERSATION_REPLY_FOOTER,
  DISMISS_CONVERSATION_REPLY_REFERENCE_PREFIX,
  DISMISS_INLINE_REPLY_MARKER,
  DISMISS_INLINE_REPLY_SIGNATURE,
  PR_AUTOMATED_SUMMARY_MARKERS,
  REGEX_PR_FEEDBACK_FOOTER,
  REGEX_PR_FEEDBACK_HEADER
} from '../domain';

/**
 * The shape of a pull-request feedback item the classifier understands.
 *
 * It is deliberately WIDER than the port's `PullRequestReviewComment`: the
 * gateway's comments carry an `author` and a `category`, but the classifier
 * only needs the id, the surface, the author and the body.
 */
export interface PrFeedbackLike {
  readonly id?: number;
  readonly surface?: string;
  readonly author?: string;
  readonly body: string;
}

/**
 * The partition of a pull request's comments.
 */
export interface PrFeedbackClassification {
  /** The feedback that can route the pipeline to TRIAGE. */
  readonly actionable: readonly PrFeedbackLike[];
  /** The repository's own automated summaries — status posts, not feedback. */
  readonly statusPosts: readonly PrFeedbackLike[];
  /** The tool's own replies — evidence, never feedback. */
  readonly ownReplies: readonly PrFeedbackLike[];
}

/**
 * The identity of a piece of review feedback.
 *
 * The review bot posts the SAME feedback twice: once as an inline review
 * comment and once as a PR conversation summary (the conversation body carries
 * an extra `**Review feedback on ...**` header). Both bodies must therefore
 * reduce to the same key, otherwise the dismissal answers the same feedback
 * twice.
 */
export function prFeedbackKey(body: string): string {
  const withoutHeader = (body || '').replace(REGEX_PR_FEEDBACK_HEADER, '');
  const withoutFooter = withoutHeader.replace(REGEX_PR_FEEDBACK_FOOTER, '');
  return withoutFooter.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Whether a comment is a reply the TOOL posted.
 *
 * The tool posts as the same account as the human operator, so the AUTHOR
 * cannot tell the tool's own replies from the operator's own notes — only the
 * tool's marker can. The marker is either the footer or the id-bearing
 * reference; both are posted by the tool and by nothing else.
 */
export function isDismissalReply(body: string): boolean {
  const text = body || '';
  return (
    text.includes(DISMISS_CONVERSATION_REPLY_FOOTER) ||
    text.includes(DISMISS_CONVERSATION_REPLY_REFERENCE_PREFIX)
  );
}

/**
 * Whether an INLINE comment is a reply the TOOL posted.
 *
 * The tool posts as the same account as the human operator, so the AUTHOR
 * cannot tell the tool's own replies from the operator's own notes — only the
 * tool's marker can. Three forms count as the tool's own mark:
 *
 * - the marker the tool appends to every inline reply it posts;
 * - the conversation markers, for a reply that quotes one;
 * - the tool's historic signature, which is the only tool-owned signal the
 *   replies already posted on PR #261 carry.
 */
export function isInlineDismissalReply(body: string): boolean {
  const text = body || '';
  return (
    text.includes(DISMISS_INLINE_REPLY_MARKER) ||
    text.includes(DISMISS_INLINE_REPLY_SIGNATURE) ||
    isDismissalReply(text)
  );
}

/**
 * Whether a comment is one the TOOL posted.
 *
 * A conversation comment is recognised by the conversation markers; an inline
 * comment by the (wider) inline markers, which are a superset of the
 * conversation ones.
 */
export function isToolOwnedPrReply(body: string, surface?: string): boolean {
  if (surface === 'conversation') {
    return isDismissalReply(body);
  }
  return isInlineDismissalReply(body);
}

/**
 * Whether a comment is one of the repository's OWN automated summaries.
 *
 * A case-insensitive substring match against the explicit marker list. A
 * status post reports what the review found; it is not itself review
 * feedback.
 */
export function isAutomatedSummaryPost(body: string): boolean {
  const text = (body || '').toLowerCase();
  if (!text) {
    return false;
  }
  return PR_AUTOMATED_SUMMARY_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

/**
 * The key that identifies a feedback item across runs.
 *
 * `id:<n>` when the comment carries a numeric REST id (an EDITED comment keeps
 * its id, so it is the SAME feedback and is not re-triaged); otherwise
 * `body:<normalized body>`.
 */
export function feedbackKeyOf(comment: PrFeedbackLike): string {
  if (typeof comment.id === 'number' && Number.isFinite(comment.id)) {
    return `id:${comment.id}`;
  }
  return `body:${prFeedbackKey(comment.body || '')}`;
}

/**
 * The keys of a list of feedback items, de-duplicated, in insertion order.
 */
export function feedbackKeysOf(comments: readonly PrFeedbackLike[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const comment of comments) {
    const key = feedbackKeyOf(comment);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }

  return keys;
}

/**
 * Partitions a pull request's comments into the three buckets.
 *
 * The order matters: the tool's OWN replies are recognised FIRST (a dismissal
 * reply that quotes a summary title is still the tool's own reply), then the
 * repository's automated summaries, then everything else is actionable.
 */
export function classifyPrFeedback(
  comments: readonly PrFeedbackLike[]
): PrFeedbackClassification {
  const actionable: PrFeedbackLike[] = [];
  const statusPosts: PrFeedbackLike[] = [];
  const ownReplies: PrFeedbackLike[] = [];

  for (const comment of comments) {
    if (isToolOwnedPrReply(comment.body || '', comment.surface)) {
      ownReplies.push(comment);
      continue;
    }
    if (isAutomatedSummaryPost(comment.body || '')) {
      statusPosts.push(comment);
      continue;
    }
    actionable.push(comment);
  }

  return {
    actionable: Object.freeze(actionable),
    statusPosts: Object.freeze(statusPosts),
    ownReplies: Object.freeze(ownReplies)
  };
}

/**
 * The ACTIONABLE subset of a PR's comments — the ONE selector (issue #397).
 *
 * `classifyPrFeedback` already partitions correctly; the defect was that only
 * the DISPATCHER called it. The command re-derived its own set from the raw
 * port response, so the subagent evaluated N items and the dismissal answered
 * N+M. Every consumer now comes through here, so a fourth call site cannot
 * re-derive the set.
 *
 * The elements are the SAME object references as `comments`: callers rely on
 * identity for membership tests and on `id`/`author`/`body` for rendering.
 */
export function actionableReviewFeedback<T extends PrFeedbackLike>(comments: readonly T[]): T[] {
  const selected = new Set<PrFeedbackLike>(classifyPrFeedback(comments).actionable);
  return comments.filter((comment) => selected.has(comment));
}
