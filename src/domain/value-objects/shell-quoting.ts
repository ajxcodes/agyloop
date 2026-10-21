/**
 * agyloop - Shell Quoting (Domain Layer)
 *
 * ONE escaper for every value that reaches a shell command string.
 *
 * A POSIX shell performs four kinds of expansion inside a DOUBLE-QUOTED word:
 * command substitution (`` `cmd` ``, `$(cmd)`), parameter expansion (`$VAR`,
 * `${VAR}`) and backslash escaping. A value interpolated into a double-quoted
 * word is therefore EXECUTED, not quoted.
 *
 * A SINGLE-QUOTED word performs NO expansion at all: every character is
 * literal. Wrapping a value in single quotes — after turning each embedded
 * single quote into `'\''` — delivers the value byte-for-byte.
 *
 * Strict Hexagonal Boundary: pure, zero I/O, zero external dependencies.
 */

/**
 * Escapes a value for embedding inside a single-quoted POSIX shell word.
 *
 * The caller supplies the surrounding single quotes; this function only makes
 * the value safe to place between them.
 */
export function escapeShellQuote(value: string): string {
  return String(value).replace(/'/g, "'\\''");
}

/**
 * Returns a value as a complete, single-quoted POSIX shell word.
 *
 * The result is safe to paste into a command string as one argument.
 */
export function shellQuote(value: string): string {
  return `'${escapeShellQuote(value)}'`;
}
