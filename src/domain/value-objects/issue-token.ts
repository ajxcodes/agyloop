/**
 * agyloop - IssueToken Value Object
 *
 * ONE grammar for the `--issue` token (issue #250).
 *
 * Before this module existed, FOUR different parsers read the same token and
 * disagreed about what it meant:
 *
 *   1. `IssueNumber.tryFrom()` (domain/value-objects/issue-number.ts) — digits
 *      only, and a failure was swallowed into `null`, so the caller degraded to
 *      the root checkpoint.
 *   2. `Number.parseInt()` (application/resolve-task-checkpoint.ts) — took the
 *      LEADING digits, so `999abc` silently became issue 999.
 *   3. `Number()` (presentation/cli.ts, `branch-info`) — `999abc` became `NaN`
 *      and was ignored.
 *   4. a bare template (`` `${issue}.json` ``) in the file adapter — `999abc`
 *      became a literal FILE, `tasks/999abc.json`.
 *
 * The four answers to one token are the defect this module removes. The policy
 * here is STRICT-FAIL-LOUD: a token that is not a positive integer is REJECTED,
 * never clamped to a number that "looks close". Clamping is indistinguishable
 * from a deliberate `999`, and it is exactly what made `status` read
 * `tasks/999.json` while `halt` wrote `.agyloop/state.json`.
 *
 * This module is pure (no I/O), so the presentation layer and the application
 * layer may both import it without violating the hexagonal fitness test
 * (`tests/architecture/hexagonal-boundaries.test.ts`).
 */

import { ISSUE_TOKEN_INVALID_MESSAGE } from '../constants';

/**
 * The outcome of parsing an explicit `--issue` token.
 *
 * - `absent`  — the operator named nothing (`null`, `undefined`, `''`, blanks).
 * - `valid`   — a positive integer issue number.
 * - `invalid` — anything else; `message` is the canonical rejection text.
 */
export type IssueTokenResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly issue: number }
  | { readonly kind: 'invalid'; readonly raw: string; readonly message: string };

/**
 * Builds the canonical rejection message.
 *
 * The template lives in `src/domain/constants.ts` so the CLI, the resolver and
 * the adapters all quote the operator the SAME sentence — a hand-typed copy per
 * call site is how the four parsers drifted apart in the first place.
 */
export function invalidIssueTokenMessage(raw: unknown): string {
  return ISSUE_TOKEN_INVALID_MESSAGE.replace('{raw}', String(raw));
}

/**
 * Parses an explicit `--issue` token under the STRICT policy.
 *
 * - absent  : `null | undefined | '' | whitespace-only` — the operator named
 *             nothing, which routes the caller into the scan-based resolution.
 * - valid   : `/^\d+$/` after trimming, optionally with a leading `#`. The
 *             positional form `codeloop #250` already accepted that shape
 *             (`REGEX_POSITIONAL_ISSUE_ID`, `src/domain/constants.ts`), so the
 *             flag form accepts it too and the two entry points agree.
 * - invalid : everything else — `999abc`, `abc`, `25 0`, `2.5`, `-1`, `0`,
 *             `1e3`, `NaN`, `Infinity`.
 *
 * A numeric input must be a SAFE POSITIVE INTEGER; `0`, a negative, a
 * fractional, `NaN` and `Infinity` are all rejected.
 */
export function parseIssueToken(raw: string | number | null | undefined): IssueTokenResult {
  if (raw === null || raw === undefined) {
    return { kind: 'absent' };
  }

  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      return { kind: 'invalid', raw: String(raw), message: invalidIssueTokenMessage(raw) };
    }
    return { kind: 'valid', issue: raw };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { kind: 'absent' };
  }

  const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^\d+$/.test(digits)) {
    return { kind: 'invalid', raw, message: invalidIssueTokenMessage(raw) };
  }

  const parsed = Number(digits);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { kind: 'invalid', raw, message: invalidIssueTokenMessage(raw) };
  }

  return { kind: 'valid', issue: parsed };
}
