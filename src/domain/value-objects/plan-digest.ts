/**
 * agyloop - Plan digest normalization (issue #298)
 *
 * The approved plan is immutable during QUALITY_GATE, but two edits are NOT
 * content edits:
 *   - an implementer ticking a checklist box (`- [x]` -> `- [ ]`);
 *   - line endings / trailing whitespace written by an editor.
 *
 * Normalising BEFORE hashing is what lets a legitimate tick keep the digest
 * valid while any prose or command change still invalidates approval.
 *
 * Pure domain: string operations only.
 */

const CHECKBOX_PATTERN = /^(\s*[-*]\s+)\[[xX]\]/;
const TRAILING_WHITESPACE = /[ \t]+$/;
const CRLF = /\r\n?/g;

export function normalizePlanForDigest(markdown: string): string {
  const normalizedLines = (markdown ?? '')
    .replace(CRLF, '\n')
    .split('\n')
    .map((line) => line.replace(TRAILING_WHITESPACE, '').replace(CHECKBOX_PATTERN, '$1[ ]'));

  while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1].length === 0) {
    normalizedLines.pop();
  }

  return `${normalizedLines.join('\n')}\n`;
}
