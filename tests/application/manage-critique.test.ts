/**
 * Tests for ManageCritiqueUseCase (Application Layer)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { ManageCritiqueUseCase } = require('../../dist/application');
const {
  RESOLVER_SOURCE_USER_DATA,
  RESOLVER_SOURCE_NONE
} = require('../../dist/domain');

import type { CritiqueInstallResult } from '../../src/domain';
import type {
  CritiquePort,
  CritiqueResolution,
  CritiqueInstallerPort,
  CritiqueCheckOptions,
  CritiqueInstallOptions,
  CritiqueUpdateOptions
} from '../../src/ports';

class MockCritiquePort implements CritiquePort {
  public resolution: CritiqueResolution;
  public version: string | null;

  constructor(options: { resolution?: CritiqueResolution; version?: string | null } = {}) {
    this.resolution = options.resolution || {
      source: RESOLVER_SOURCE_NONE,
      path: null,
      isAvailable: false
    };
    this.version = options.version !== undefined ? options.version : null;
  }

  resolveReviewer(): CritiqueResolution {
    return this.resolution;
  }

  async getVersion(resolvedPath: string): Promise<string | null> {
    return this.version;
  }

  async review(): Promise<any> {
    return {} as any;
  }
}

class MockCritiqueInstallerPort implements CritiqueInstallerPort {
  public latestVersion: string | null;
  public installResult: CritiqueInstallResult;

  constructor(options: { latestVersion?: string | null; installResult?: CritiqueInstallResult } = {}) {
    this.latestVersion = options.latestVersion !== undefined ? options.latestVersion : '0.2.0';
    this.installResult = options.installResult || {
      success: true,
      version: '0.2.0',
      targetPath: '/mock/user/critique/bin/critique.js',
      error: null
    };
  }

  async fetchLatestVersion(): Promise<string | null> {
    return this.latestVersion;
  }

  async checkUpdateAvailable(currentVersion: string | null, options: CritiqueCheckOptions = {}): Promise<any> {
    const isOutdated = Boolean(currentVersion && this.latestVersion && currentVersion !== this.latestVersion);
    return {
      currentVersion,
      latestVersion: this.latestVersion,
      lastCheckedAt: Date.now(),
      isOutdated,
      isInstalled: Boolean(options.resolvedPath),
      resolvedPath: options.resolvedPath || null
    };
  }

  async install(options?: CritiqueInstallOptions): Promise<CritiqueInstallResult> {
    return this.installResult;
  }

  async update(options?: CritiqueUpdateOptions): Promise<CritiqueInstallResult> {
    return this.installResult;
  }

  async getCachedVersionInfo(): Promise<any> {
    return null;
  }
}

describe('ManageCritiqueUseCase (Application Layer)', () => {
  it('getStatus reports not installed when critique is missing', async () => {
    const critiquePort = new MockCritiquePort({
      resolution: { source: RESOLVER_SOURCE_NONE, path: null, isAvailable: false }
    });
    const installerPort = new MockCritiqueInstallerPort({ latestVersion: '0.2.0' });

    const useCase = new ManageCritiqueUseCase(critiquePort, installerPort);
    const status = await useCase.getStatus();

    assert.strictEqual(status.resolution.isAvailable, false);
    assert.strictEqual(status.versionInfo.isInstalled, false);
    assert.strictEqual(status.versionInfo.currentVersion, null);
    assert.strictEqual(status.versionInfo.latestVersion, '0.2.0');
    assert.strictEqual(status.versionInfo.isOutdated, false);
  });

  it('getStatus reports up to date when current equals latest', async () => {
    const critiquePort = new MockCritiquePort({
      resolution: {
        source: RESOLVER_SOURCE_USER_DATA,
        path: '/mock/user/critique/bin/critique.js',
        isAvailable: true
      },
      version: '0.2.0'
    });
    const installerPort = new MockCritiqueInstallerPort({ latestVersion: '0.2.0' });

    const useCase = new ManageCritiqueUseCase(critiquePort, installerPort);
    const status = await useCase.getStatus();

    assert.strictEqual(status.resolution.isAvailable, true);
    assert.strictEqual(status.versionInfo.isInstalled, true);
    assert.strictEqual(status.versionInfo.currentVersion, '0.2.0');
    assert.strictEqual(status.versionInfo.latestVersion, '0.2.0');
    assert.strictEqual(status.versionInfo.isOutdated, false);
  });

  it('getStatus reports outdated when current is older than latest', async () => {
    const critiquePort = new MockCritiquePort({
      resolution: {
        source: RESOLVER_SOURCE_USER_DATA,
        path: '/mock/user/critique/bin/critique.js',
        isAvailable: true
      },
      version: '0.1.6'
    });
    const installerPort = new MockCritiqueInstallerPort({ latestVersion: '0.2.0' });

    const useCase = new ManageCritiqueUseCase(critiquePort, installerPort);
    const status = await useCase.getStatus();

    assert.strictEqual(status.resolution.isAvailable, true);
    assert.strictEqual(status.versionInfo.isInstalled, true);
    assert.strictEqual(status.versionInfo.currentVersion, '0.1.6');
    assert.strictEqual(status.versionInfo.latestVersion, '0.2.0');
    assert.strictEqual(status.versionInfo.isOutdated, true);
  });

  it('install executes installer and returns result', async () => {
    const critiquePort = new MockCritiquePort();
    const installerPort = new MockCritiqueInstallerPort({
      installResult: {
        success: true,
        version: '0.2.0',
        targetPath: '/path/to/bin/critique.js',
        error: null
      }
    });

    const useCase = new ManageCritiqueUseCase(critiquePort, installerPort);
    const res = await useCase.install({ force: true });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.version, '0.2.0');
    assert.strictEqual(res.targetPath, '/path/to/bin/critique.js');
  });

  it('update executes installer update and returns result', async () => {
    const critiquePort = new MockCritiquePort();
    const installerPort = new MockCritiqueInstallerPort({
      installResult: {
        success: true,
        version: '0.2.1',
        targetPath: '/path/to/bin/critique.js',
        error: null
      }
    });

    const useCase = new ManageCritiqueUseCase(critiquePort, installerPort);
    const res = await useCase.update();

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.version, '0.2.1');
  });

  describe('resolveCritiquePath', () => {
    it('instance method returns resolved path when critique is available', () => {
      const critiquePort = new MockCritiquePort({
        resolution: {
          source: RESOLVER_SOURCE_USER_DATA,
          path: '/custom/bin/critique',
          isAvailable: true
        }
      });
      const installerPort = new MockCritiqueInstallerPort();
      const useCase = new ManageCritiqueUseCase(critiquePort, installerPort);

      const path = useCase.resolveCritiquePath('/workspace');
      assert.strictEqual(path, '/custom/bin/critique');
    });

    it('instance method returns null when critique is unavailable', () => {
      const critiquePort = new MockCritiquePort({
        resolution: {
          source: RESOLVER_SOURCE_NONE,
          path: null,
          isAvailable: false
        }
      });
      const installerPort = new MockCritiqueInstallerPort();
      const useCase = new ManageCritiqueUseCase(critiquePort, installerPort);

      const path = useCase.resolveCritiquePath();
      assert.strictEqual(path, null);
    });

    it('static method safely returns path when critiquePort is available', () => {
      const critiquePort = new MockCritiquePort({
        resolution: {
          source: RESOLVER_SOURCE_USER_DATA,
          path: '/usr/local/bin/critique',
          isAvailable: true
        }
      });

      const path = ManageCritiqueUseCase.resolveCritiquePath(critiquePort, '/workspace');
      assert.strictEqual(path, '/usr/local/bin/critique');
    });

    it('static method safely returns null when critiquePort is undefined or unavailable', () => {
      assert.strictEqual(ManageCritiqueUseCase.resolveCritiquePath(undefined), null);

      const unavailablePort = new MockCritiquePort({
        resolution: {
          source: RESOLVER_SOURCE_NONE,
          path: null,
          isAvailable: false
        }
      });
      assert.strictEqual(ManageCritiqueUseCase.resolveCritiquePath(unavailablePort), null);
    });
  });
});
