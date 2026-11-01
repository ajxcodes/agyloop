/**
 * agyloop - SourceFileReaderPort (issue #432)
 *
 * The Test Register contract resolves a `Pins:` reference against a real test
 * file. The application layer may not touch the filesystem (and may not import
 * `path`), so the read goes through this port.
 */

export interface SourceFileReaderPort {
  /**
   * Reads `relativePath` resolved inside `workspaceRoot`.
   *
   * Returns `null` when the file is missing, unreadable, or lexically escapes
   * the workspace root — the caller reports the unresolvable reference.
   */
  read(relativePath: string, workspaceRoot: string): string | null;
}
