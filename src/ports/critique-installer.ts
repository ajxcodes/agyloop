/**
 * agyloop - CritiqueInstallerPort Interface
 *
 * Inversion of Control contract for checking critique releases,
 * detecting version updates, caching release metadata, and installing/updating
 * the Critique CLI binary.
 *
 * Strict Hexagonal Boundary: Depends only on domain models, zero direct I/O.
 */

import { CritiqueVersionInfo, CritiqueInstallResult } from '../domain';

export interface CritiqueCheckOptions {
  readonly force?: boolean;
  readonly timeoutMs?: number;
  readonly resolvedPath?: string | null;
}

export interface CritiqueInstallOptions {
  readonly targetDir?: string;
  readonly force?: boolean;
  readonly timeoutMs?: number;
}

export interface CritiqueUpdateOptions {
  readonly targetDir?: string;
  readonly timeoutMs?: number;
}

export interface CritiqueInstallerPort {
  /**
   * Queries remote source (GitHub Releases or npm) for the latest critique version tag.
   * Degrades gracefully with null if network is unavailable or timed out.
   */
  fetchLatestVersion(options?: { timeoutMs?: number }): Promise<string | null>;

  /**
   * Checks whether a new version of critique is available compared to the current version.
   * Utilizes local cached metadata if within the 24-hour TTL unless `force` is specified.
   */
  checkUpdateAvailable(
    currentVersion: string | null,
    options?: CritiqueCheckOptions
  ): Promise<CritiqueVersionInfo>;

  /**
   * Downloads and installs the latest critique binary/script into the target user directory.
   */
  install(options?: CritiqueInstallOptions): Promise<CritiqueInstallResult>;

  /**
   * Updates an existing critique installation to the latest available release.
   */
  update(options?: CritiqueUpdateOptions): Promise<CritiqueInstallResult>;

  /**
   * Retrieves the currently cached critique version metadata without making a network request.
   */
  getCachedVersionInfo(): Promise<CritiqueVersionInfo | null>;
}
