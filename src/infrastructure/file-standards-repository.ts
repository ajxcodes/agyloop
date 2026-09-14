/**
 * agyloop - FileStandardsRepository Infrastructure Adapter
 *
 * Implements StandardsRepository port to discover and load repository-level
 * standards, guidelines, and quality rules from disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { StandardsRepository, StandardsLoadOptions } from '../ports';
import { STANDARD_CANDIDATE_PATHS } from '../domain';

export class FileStandardsRepository implements StandardsRepository {
  private readonly candidatePaths: readonly string[];

  constructor(options: { candidatePaths?: readonly string[] } = {}) {
    this.candidatePaths = options.candidatePaths || STANDARD_CANDIDATE_PATHS;
  }

  public findStandardsPath(options: StandardsLoadOptions = {}): string | null {
    const cwd = options.cwd || process.cwd();

    if (options.customPath) {
      const customResolved = path.isAbsolute(options.customPath)
        ? options.customPath
        : path.resolve(cwd, options.customPath);

      if (fs.existsSync(customResolved)) {
        try {
          const stat = fs.statSync(customResolved);
          if (stat.isFile()) {
            return customResolved;
          }
        } catch {
          // Stat failed
        }
      }
    }

    for (const candidate of this.candidatePaths) {
      const candidateResolved = path.resolve(cwd, candidate);
      if (fs.existsSync(candidateResolved)) {
        try {
          const stat = fs.statSync(candidateResolved);
          if (stat.isFile()) {
            return candidateResolved;
          }
        } catch {
          // Stat failed, check next candidate
        }
      }
    }

    return null;
  }

  public loadStandards(options: StandardsLoadOptions = {}): string | null {
    const resolvedPath = this.findStandardsPath(options);
    if (!resolvedPath) {
      return null;
    }

    try {
      return fs.readFileSync(resolvedPath, 'utf8');
    } catch {
      return null;
    }
  }
}
