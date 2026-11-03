/**
 * agyloop - FileSourceReader (issue #432, revision reads from issue #489)
 *
 * Filesystem adapter for `SourceFileReaderPort`: fs + path, traversal-guarded,
 * plus a git-backed revision read so the Test Register can ask the BASE
 * revision whether a `New test:` title already exists. A path that resolves
 * outside the workspace root is `unavailable`, never read.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RevisionReadResult, SourceFileReaderPort } from '../ports/source-file-reader';

const GIT_BINARY = 'git';
/** A resolved revision must be a commit SHA; anything else is never interpolated. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const MAX_REVISION_BYTES = 32 * 1024 * 1024;

export class FileSourceReader implements SourceFileReaderPort {
  /**
   * Resolved `<root>\0<revision>` → full commit SHA.
   *
   * Successes only: a commit SHA is immutable, while an unresolved ref may
   * appear later in the same process (a fetch between two plans), so a failure
   * is always retried.
   */
  private readonly commitCache = new Map<string, string>();

  public read(relativePath: string, workspaceRoot: string): string | null {
    const resolved = this.resolveInsideRoot(relativePath, workspaceRoot);
    if (resolved === null) return null;

    try {
      if (!fs.statSync(resolved).isFile()) return null;
      return fs.readFileSync(resolved, 'utf8');
    } catch {
      return null;
    }
  }

  public readAtRevision(
    relativePath: string,
    workspaceRoot: string,
    revision: string
  ): RevisionReadResult {
    const revisionText = String(revision ?? '').trim();
    if (revisionText.length === 0) {
      return { status: 'unavailable', reason: 'the revision is blank' };
    }
    if (revisionText.startsWith('-')) {
      return { status: 'unavailable', reason: 'a revision may not start with "-"' };
    }

    const resolved = this.resolveInsideRoot(relativePath, workspaceRoot);
    if (resolved === null) {
      return {
        status: 'unavailable',
        reason: 'the path is blank, names the workspace root, or escapes it'
      };
    }

    const resolvedRoot = path.resolve(String(workspaceRoot ?? '').trim());
    const commit = this.resolveCommit(resolvedRoot, revisionText);
    if (commit === null) {
      return {
        status: 'unavailable',
        reason: `the revision "${revisionText}" could not be resolved in ${resolvedRoot}`
      };
    }

    // `:./<path>` is relative to the git working directory, so a workspace
    // root that is a SUBDIRECTORY of the repository resolves correctly
    // without a second `rev-parse --show-prefix` probe.
    const repoPath = path.relative(resolvedRoot, resolved).split(path.sep).join('/');
    try {
      const content = childProcess.execFileSync(
        GIT_BINARY,
        ['-C', resolvedRoot, 'show', `${commit}:./${repoPath}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_REVISION_BYTES }
      );
      return { status: 'found', content: String(content) };
    } catch (err: unknown) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ENOBUFS') {
        return {
          status: 'unavailable',
          reason: `${repoPath} at "${revisionText}" exceeds ${MAX_REVISION_BYTES} bytes`
        };
      }
      // The SHA resolved, so a non-zero `git show` means the path is not in
      // that tree (git: "path … does not exist in …"). That is `absent`.
      return { status: 'absent' };
    }
  }

  /** The absolute path when it is a strict, non-root descendant of `workspaceRoot`. */
  private resolveInsideRoot(relativePath: string, workspaceRoot: string): string | null {
    const raw = String(relativePath ?? '').trim();
    const root = String(workspaceRoot ?? '').trim();
    if (raw.length === 0 || root.length === 0) return null;

    const resolvedRoot = path.resolve(root);
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(resolvedRoot, raw);
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    if (resolved === resolvedRoot || !resolved.startsWith(prefix)) return null;
    return resolved;
  }

  /** The full commit SHA for `revision`, or `null` when it does not resolve. */
  private resolveCommit(root: string, revision: string): string | null {
    const key = `${root}\u0000${revision}`;
    const cached = this.commitCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const stdout = childProcess.execFileSync(
        GIT_BINARY,
        ['-C', root, 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const candidate = String(stdout).trim();
      if (!COMMIT_SHA_PATTERN.test(candidate)) return null;
      this.commitCache.set(key, candidate);
      return candidate;
    } catch {
      return null;
    }
  }
}
