/**
 * agyloop - Subject truncation grammar (issue #376, Defect 2)
 *
 * ONE pure trim helper for every bounded head the tool derives from a title:
 * the conventional-commit SUBJECT (`CommitMessage.toSingleLine()`) and the plan
 * artifact FILENAME (`planArtifactFileName()`).
 *
 * The defect this module exists to stop: both surfaces cut at the last space
 * that fitted, so a bounded head ended on a stopword (`… APPROVAL: a`), on a
 * possessive (`… on its`), on label punctuation (`… two different cwds:`), or
 * inside an unclosed quote (`… tell “nothing`). The cut had no notion of a
 * clause boundary (the last `': '` / `' — '` / `'; '`) and no notion of a
 * dangling tail.
 *
 * Rules, in order (see `truncateSubjectDescription`):
 *
 * 1. a description that fits is returned UNTOUCHED (short-message identity);
 * 2. a cut that lands exactly on a space keeps the whole fitting word (the
 *    #408 underfill: the word fitted, and rewinding threw it away);
 * 3. otherwise the last clause separator inside the budget wins when it
 *    retains at least {@link CLAUSE_RETENTION_RATIO} of the budget;
 * 4. otherwise the last space;
 * 5. then `trimDanglingTail()` removes trailing label punctuation, dangling
 *    function words and an unmatched opening quote/bracket.
 *
 * Purity note: this module imports NOTHING — no Node built-in, no external
 * package, no sibling module. The repository's architecture fitness test
 * (`tests/architecture/hexagonal-boundaries.test.ts`) requires it.
 */

/**
 * The minimum share of the budget a clause-boundary cut must retain.
 *
 * A `': '` at 10 % of the budget would throw away almost the whole head just
 * because it is a separator; 60 % keeps the cut readable AND informative.
 */
export const CLAUSE_RETENTION_RATIO = 0.6;

/** The clause separators a bounded head prefers to end on. */
const CLAUSE_SEPARATORS: readonly string[] = [': ', ' — ', ' - ', '; ', '? ', '! ', ', '];

/** Trailing label punctuation a bounded head must never end on. */
const TRAILING_LABEL_PUNCTUATION = /[,;:/\u2014.\s-]+$/u;

/**
 * Function words a bounded head must never end on (issue #376, AC6).
 *
 * Deliberately EXCLUDES `only` and `merely`: they postmodify the preceding
 * word, so dropping them does not remove a dangling token — it inverts the
 * claim (`… is syntactic only` → `… is syntactic`, #413).
 */
export const SUBJECT_DANGLING_TOKENS: ReadonlySet<string> = new Set<string>([
  // Articles
  'a',
  'an',
  'the',
  // Prepositions
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'from',
  'as',
  'into',
  'onto',
  'over',
  'under',
  'about',
  'after',
  'before',
  'between',
  'through',
  'during',
  'without',
  'within',
  'against',
  'upon',
  'via',
  'per',
  // Conjunctions
  'and',
  'or',
  'but',
  'nor',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'plus',
  '&',
  // Determiners / pronouns / possessives
  'its',
  'their',
  'your',
  'our',
  'my',
  'his',
  'her',
  'this',
  'that',
  'these',
  'those',
  'it',
  'they',
  'we',
  'you',
  'i',
  // Copulas / auxiliaries
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'am',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  // Dangling modifiers
  'not',
  'still',
  'also',
  'even',
  'too',
  'very',
  'quite',
  'rather',
  'almost',
  'nearly',
  'always',
  'often',
  'already',
  'again',
  'then',
  'thus',
  'hence',
  'therefore',
  'however',
  'moreover',
  'furthermore'
]);

/** Opening marks and the closing mark each has to be balanced against. */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ['\u201c', '\u201d'],
  ['`', '`'],
  ['(', ')']
];

/**
 * True when `head` leaves an opening quote/bracket unclosed (issue #426).
 *
 * `… tell “nothing` is a content-word tail by the stopword rule, yet it is
 * dangling: the opening curly quote has no partner. The same holds for `"`,
 * `` ` `` and `(`.
 */
export function hasUnclosedQuote(head: string): boolean {
  if (!head || typeof head !== 'string') return false;
  for (const [open, close] of QUOTE_PAIRS) {
    const opens = head.split(open).length - 1;
    const closes = head.split(close).length - 1;
    // AUTO-CLOSING PAIRS: for `"` and `` ` `` the same mark is both opener and
    // closer, so an ODD count is the unclosed state.
    if (open === close) {
      if (opens % 2 === 1) return true;
    } else if (opens > closes) {
      return true;
    }
  }
  return false;
}

/** The last whitespace token of `head`, lowercased and de-punctuated. */
function lastToken(head: string): string {
  const tokens = head.trim().split(/\s+/);
  const last = tokens.length > 0 ? tokens[tokens.length - 1] : '';
  return last.toLowerCase().replace(/[^a-z0-9&]+/g, '');
}

/**
 * Removes a dangling tail from a bounded head (issue #376, AC6).
 *
 * Loops: trailing whitespace and label punctuation (`: , ; - / — .`) are
 * trimmed first, then — while the head still has two or more whitespace tokens
 * AND its last token is a {@link SUBJECT_DANGLING_TOKENS} entry or the head
 * leaves a quote/bracket unclosed — the last token is dropped.
 *
 * Never returns `''`: a drop that would empty the head is refused, so the
 * caller keeps the pre-drop head instead of an empty subject.
 */
export function trimDanglingTail(head: string): string {
  if (!head || typeof head !== 'string') return '';
  let current = head.replace(TRAILING_LABEL_PUNCTUATION, '');
  // The loop is bounded by the token count: each iteration removes one token.
  for (;;) {
    const tokens = current.trim().split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length < 2) return current.trim();
    const dangling = SUBJECT_DANGLING_TOKENS.has(lastToken(current)) || hasUnclosedQuote(current);
    if (!dangling) return current.trim();
    const withoutLast = tokens.slice(0, -1).join(' ').replace(TRAILING_LABEL_PUNCTUATION, '');
    if (withoutLast.length === 0) return current.trim();
    current = withoutLast;
  }
}

/**
 * Bounds a description to `budget` characters at a boundary that reads.
 *
 * - `budget <= 0` or a description that already fits: returned unchanged.
 * - `description[budget] === ' '`: the exact boundary is kept, so the whole
 *   word that fitted is not thrown away (the #408 11-character underfill).
 * - otherwise the rightmost clause separator fully inside the budget that
 *   retains at least {@link CLAUSE_RETENTION_RATIO} of it.
 * - otherwise the last space; and when there is none, a hard cut.
 * - finally {@link trimDanglingTail}.
 *
 * @param description - The already-normalised description.
 * @param budget - The maximum number of characters the head may occupy.
 */
export function truncateSubjectDescription(description: string, budget: number): string {
  if (!description || typeof description !== 'string') return '';
  if (!Number.isFinite(budget) || budget <= 0) return description;
  if (description.length <= budget) return description;

  let head: string;
  if (description.charAt(budget) === ' ') {
    head = description.slice(0, budget);
  } else {
    const minimum = Math.ceil(budget * CLAUSE_RETENTION_RATIO);
    let cutIndex = -1;
    for (const separator of CLAUSE_SEPARATORS) {
      let fromIndex = 0;
      for (;;) {
        const index = description.indexOf(separator, fromIndex);
        if (index === -1 || index + separator.length > budget) break;
        if (index >= minimum && index > cutIndex) {
          cutIndex = index;
        }
        fromIndex = index + 1;
      }
    }
    if (cutIndex >= 0) {
      head = description.slice(0, cutIndex);
    } else {
      const lastSpace = description.lastIndexOf(' ', budget);
      head = lastSpace > 0 ? description.slice(0, lastSpace) : description.slice(0, budget);
    }
  }

  return trimDanglingTail(head);
}

import { escapeRegExp as escapeRegExpImpl } from './markdown';
/**
 * Removes THIS issue's own token from a description (issue #376, AC8/AC9).
 *
 * An explicit `-m` message that already carries `(#400)` reached
 * `toSingleLine()` with the token inside the description, so no budget was
 * reserved for the suffix and the word-boundary cut sliced `(#400)` off the
 * tail. Stripping it here lets the caller append exactly one suffix and always
 * reserve its budget.
 *
 * Boundary-aware by construction: only a WHOLE `(#N)` token and a single
 * trailing standalone `#N` are removed. `#40` is not this issue's token for
 * issue 4, and another issue's `#400` mention survives.
 *
 * @param description - The raw description.
 * @param issueNumber - This message's issue number, or `null`.
 */
export function stripOwnIssueToken(description: string, issueNumber: number | null): string {
  if (!description || typeof description !== 'string') return '';
  if (issueNumber === null || issueNumber === undefined) return description;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return description;

  const token = `#${issueNumber}`;
  const parenPattern = new RegExp(
    `(^|\\s)\\(${escapeRegExpImpl(token)}\\)(?=\\s|$)`,
    'g'
  );
  const barePattern = new RegExp(`(^|\\s)${escapeRegExpImpl(token)}$`);

  let stripped = description.replace(parenPattern, '$1');
  stripped = stripped.replace(barePattern, '$1');
  return stripped.replace(/\s+/g, ' ').trim();
}
