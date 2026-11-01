/**
 * agyloop - FileSourceReader (issue #432)
 *
 * Filesystem adapter for `SourceFileReaderPort`: fs + path, traversal-guarded.
 * A path that resolves outside the workspace root is `null`, never read.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SourceFileReaderPort } from '../ports/source-file-reader';

export class FileSourceReader implements SourceFileReaderPort {
  public read(relativePath: string, workspaceRoot: string): string | null {
    const raw = String(relativePath ?? '').trim();
    const root = String(workspaceRoot ?? '').trim();
    if (raw.length === 0 || root.length === 0) return null;

    const resolvedRoot = path.resolve(root);
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(resolvedRoot, raw);
    const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
    if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
      return null;
    }

    try {
      if (!fs.statSync(resolved).isFile()) return null;
      return fs.readFileSync(resolved, 'utf8');
    } catch {
      return null;
    }
  }
}
