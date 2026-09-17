/**
 * agyloop - ManageCritiqueUseCase (Application Layer)
 *
 * Coordinates critique binary lifecycle management:
 * 1. Resolves binary location and installed version.
 * 2. Queries cached/remote release metadata for update detection.
 * 3. Installs or updates critique executable into user environment.
 *
 * Strict Hexagonal Boundary: Interacts only with ports and domain entities.
 */

import {
  CritiqueVersionInfo,
  CritiqueInstallResult
} from '../domain';
import {
  CritiquePort,
  CritiqueResolution,
  CritiqueInstallerPort,
  CritiqueInstallOptions,
  CritiqueUpdateOptions
} from '../ports';

export interface CritiqueStatusResult {
  readonly resolution: CritiqueResolution;
  readonly versionInfo: CritiqueVersionInfo;
}

export class ManageCritiqueUseCase {
  private readonly critiquePort: CritiquePort;
  private readonly installerPort: CritiqueInstallerPort;

  constructor(
    critiquePort: CritiquePort,
    installerPort: CritiqueInstallerPort
  ) {
    this.critiquePort = critiquePort;
    this.installerPort = installerPort;
  }

  /**
   * Retrieves comprehensive critique status, including binary resolution,
   * installed version, latest release version, and update availability.
   */
  public async getStatus(cwd: string = process.cwd()): Promise<CritiqueStatusResult> {
    const resolution = await Promise.resolve(this.critiquePort.resolveReviewer(cwd));

    let currentVersion: string | null = null;
    if (resolution.isAvailable && resolution.path) {
      if (typeof this.critiquePort.getVersion === 'function') {
        currentVersion = await this.critiquePort.getVersion(resolution.path);
      }
    }

    const versionInfo = await this.installerPort.checkUpdateAvailable(currentVersion, {
      resolvedPath: resolution.path
    });

    return {
      resolution,
      versionInfo
    };
  }

  /**
   * Downloads and installs the latest critique executable.
   */
  public async install(options: CritiqueInstallOptions = {}): Promise<CritiqueInstallResult> {
    return this.installerPort.install(options);
  }

  /**
   * Updates existing critique installation to the latest available release.
   */
  public async update(options: CritiqueUpdateOptions = {}): Promise<CritiqueInstallResult> {
    return this.installerPort.update(options);
  }
}
