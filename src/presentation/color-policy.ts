/**
 * agyloop - ONE colour policy for the whole process (issue #341 in #339)
 *
 * Before this module every renderer built its own escapes: `formatStageBadge`
 * hard-coded them, the release renderer checked `isTTY` alone, and the commit
 * highlighters never checked anything — so a piped report carried `ESC` bytes
 * and neither `NO_COLOR` (the de-facto standard) nor `TERM=dumb` was honoured.
 *
 * The policy, decided per call from `(stream, env)`:
 *   - colour only when stdout is a TTY (piped/redirected output is plain),
 *   - `NO_COLOR` present (any value, including empty) disables colour,
 *   - `TERM=dumb` disables colour.
 *
 * Per-call rather than memoised on purpose: process env/stdout are stable in
 * production, and in-process tests flip `process.stdout.isTTY` / `env.NO_COLOR`
 * between runs (issue #341, AC-3.1). When colour is disabled NO byte of the
 * sequence is produced — not even the reset.
 *
 * This is the ONLY file under `src/` allowed to contain a literal `\x1b`;
 * `tests/architecture/color-policy.test.ts` is the tripwire.
 */

/** The structural shape the policy needs — `process.stdout` satisfies it. */
export interface ColorStream {
  readonly isTTY?: boolean;
}

/**
 * True when this output may carry ANSI escapes.
 *
 * @param stream - The destination stream (default `process.stdout`).
 * @param env - The environment to honour (default `process.env`).
 */
export function shouldColorize(
  stream: ColorStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!stream.isTTY) {
    return false;
  }
  // NO_COLOR is presence-based: present with ANY value (including '') means off.
  if (Object.prototype.hasOwnProperty.call(env, 'NO_COLOR')) {
    return false;
  }
  if (env.TERM === 'dumb') {
    return false;
  }
  return true;
}

/**
 * Wraps `text` in `code` when colour is enabled, else returns it untouched.
 *
 * @param code - The SGR parameter, e.g. `'32'`, `'32;1'`.
 * @param text - The text to paint.
 * @param stream - Optional stream override (default `process.stdout`).
 * @param env - Optional env override (default `process.env`).
 */
export function paint(
  code: string,
  text: string,
  stream?: ColorStream,
  env?: NodeJS.ProcessEnv
): string {
  return shouldColorize(stream, env) ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** SGR codes for every lifecycle stage badge. Single source of the palette. */
export const STAGE_COLOR_CODES: Readonly<Record<string, string>> = Object.freeze({
  INITIALIZED: '36',      // Cyan
  DISCOVERY: '34',        // Blue
  PLAN: '35',             // Magenta
  APPROVAL: '33',         // Yellow
  IMPLEMENT: '32',        // Green
  QUALITY_GATE: '36',     // Cyan
  REVIEW: '34',           // Blue
  COMMIT: '32',           // Green
  COMPLETED: '32;1',      // Bold Green
  TRIAGE: '33;1'          // Bold Yellow
});
