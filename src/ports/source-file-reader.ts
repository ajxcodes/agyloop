/**
 * agyloop - SourceFileReaderPort (issue #432, extended by issue #489)
 *
 * The Test Register contract resolves a `Pins:` reference against a real test
 * file, and a `New test:` row against the BASE revision. The application layer
 * may not touch the filesystem (and may not import `path`), so both reads go
 * through this port.
 */

/** The outcome of reading a path at a specific revision (issue #489). */
export type RevisionReadResult =
  /** The revision resolved and the path exists in it. */
  | { readonly status: 'found'; readonly content: string }
  /** The revision resolved and the path does NOT exist in it. */
  | { readonly status: 'absent' }
  /** No honest answer: not a repository, unknown revision, unreadable object. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface SourceFileReaderPort {
  /**
   * Reads `relativePath` resolved inside `workspaceRoot`.
   *
   * Returns `null` when the file is missing, unreadable, or lexically escapes
   * the workspace root — the caller reports the unresolvable reference.
   */
  read(relativePath: string, workspaceRoot: string): string | null;

  /**
   * Reads `relativePath` as it exists at `revision` (issue #489).
   *
   * `found` carries the revision's bytes, `absent` is a VERDICT (the revision
   * resolved and the path is not in it), and `unavailable` is ignorance (no
   * honest answer) — the caller falls back to `read` only for `unavailable`.
   *
   * Optional, like the other capability methods on this project's ports: a
   * reader that cannot resolve a revision keeps `read`'s behaviour, so the
   * caller's fallback stays reachable and testable.
   */
  readAtRevision?(
    relativePath: string,
    workspaceRoot: string,
    revision: string
  ): RevisionReadResult;
}
