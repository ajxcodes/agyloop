/**
 * agyloop - FileVersionAnchor Infrastructure Adapter
 *
 * Implements version anchor file management:
 * Ensures package.json exists if configured for package_json versioning strategy,
 * maintaining full compatibility with ajxcodes/auto-tag@v1.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VersionAnchor, VersionAnchorConfig } from '../domain';

export interface EnsureVersionAnchorOptions {
  readonly workspaceDir?: string;
  readonly repoName?: string;
  readonly config?: VersionAnchorConfig;
}

export class FileVersionAnchor {
  public static ensureVersionAnchor(options?: EnsureVersionAnchorOptions): {
    created: boolean;
    filePath: string;
    version: string;
  } {
    const workspace = options?.workspaceDir || process.cwd();
    const anchor = new VersionAnchor(options?.config);
    const targetPath = path.join(workspace, anchor.file);
    const exists = fs.existsSync(targetPath);

    if (anchor.shouldAutoCreatePackageJson(exists)) {
      const repoName = options?.repoName || path.basename(workspace);
      const content = anchor.generateMinimalPackageJson(repoName);
      fs.writeFileSync(targetPath, content, 'utf8');
      return {
        created: true,
        filePath: targetPath,
        version: anchor.initialVersion
      };
    }

    let currentVersion = anchor.initialVersion;
    if (exists && anchor.file === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        if (typeof pkg.version === 'string') {
          currentVersion = pkg.version;
        }
      } catch {
        // Fallback
      }
    }

    return {
      created: false,
      filePath: targetPath,
      version: currentVersion
    };
  }
}
