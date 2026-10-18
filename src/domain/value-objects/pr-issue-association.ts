/**
 * agyloop - Pull-request ↔ issue association rules (Domain Layer)
 *
 * Pure: no I/O. Decides whether a merged PR is evidence that it DELIVERED an
 * issue, as opposed to merely having been *developed on a branch named after* it.
 *
 * The distinction matters because the two are routinely conflated in this repo's
 * own history: PR #228 (`fix(tests): narrow git branch mock … (#226)`, head
 * `task/226`) changed one line of a test file and mentions #226 nowhere in its
 * body, yet a head-branch regex bound it to the OPEN, unimplemented issue #226
 * and the pre-flight halted, making the issue unstartable (#226).
 */

/** GitHub's auto-close keywords: close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved. */
const CLOSING_KEYWORD = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;

/**
 * `Closes #244`, `Fixes #244.`, `fixes 244`, `Resolved: #244`.
 * The keyword and the number may be separated by at most 3 non-alphanumeric
 * characters, which is what makes `Fixes Alpine CI failure in …` (#228's body)
 * correctly NOT match issue 226 while `Fixes #244.` does.
 */
export function closingKeywordPattern(issueNumber: number | string): RegExp {
  const num = String(issueNumber).trim();
  const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    String.raw`\b${CLOSING_KEYWORD}\b[^A-Za-z0-9]{0,3}(?:issue\s+)?#?${escaped}\b`,
    'i'
  );
}

/** True when `body` asserts delivery of `issueNumber` via a GitHub closing keyword. */
export function prAssertsIssueDelivery(
  pr: { readonly title?: string | null; readonly body?: string | null },
  issueNumber: number | string
): boolean {
  return closingKeywordPattern(issueNumber).test(pr.body ?? '');
}

/**
 * True when `headRefName` merely *names* the issue (`task/<n>`, `fix/<n>`, …).
 * Kept as an exported predicate so the warning text and any future callers share
 * one definition rather than re-inlining the regex.
 */
export function branchNameReferencesIssue(headRefName: string | null | undefined, issueNumber: number | string): boolean {
  const name = (headRefName ?? '').trim();
  if (!name) return false;
  const escaped = String(issueNumber).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`^(?:task|fix)/${escaped}(?:[-_/]|$)`, 'i').test(name);
}