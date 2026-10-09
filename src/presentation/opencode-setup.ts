/**
 * agyloop - OpenCode Setup & Integration Installer
 *
 * Implements installation/symlinking of CodeLoop assets into OpenCode configuration directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface OpenCodeInstallOptions {
  readonly global?: boolean;
  readonly targetDir?: string;
  readonly force?: boolean;
  readonly baseDir?: string;
}

export interface OpenCodeInstallResult {
  readonly success: boolean;
  readonly installedPath: string;
  readonly sourcePath: string;
  readonly isSymlink: boolean;
}

export function installOpenCodeIntegration(options: OpenCodeInstallOptions = {}): OpenCodeInstallResult {
  const baseDir = options.baseDir || path.resolve(__dirname, '..', '..');
  const sourcePath = path.join(baseDir, 'integrations', 'opencode', 'codeloop-skill.md');

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`OpenCode integration asset not found at source path: ${sourcePath}`);
  }

  // Determine target directory
  const targetSkillsDir = options.targetDir
    ? options.targetDir
    : options.global !== false
      ? path.join(os.homedir(), '.opencode', 'skills')
      : path.join(process.cwd(), '.opencode', 'skills');

  if (!fs.existsSync(targetSkillsDir)) {
    fs.mkdirSync(targetSkillsDir, { recursive: true });
  }

  const installedPath = path.join(targetSkillsDir, 'codeloop.md');

  if (fs.existsSync(installedPath)) {
    if (!options.force) {
      // Remove existing symlink or file if force or safely overwrite
      fs.unlinkSync(installedPath);
    } else {
      fs.unlinkSync(installedPath);
    }
  }

  // Create symlink
  try {
    fs.symlinkSync(sourcePath, installedPath);
    return {
      success: true,
      installedPath,
      sourcePath,
      isSymlink: true
    };
  } catch {
    // If symlinking fails (e.g. cross-drive or Windows permission), copy file as fallback
    fs.copyFileSync(sourcePath, installedPath);
    return {
      success: true,
      installedPath,
      sourcePath,
      isSymlink: false
    };
  }
}
