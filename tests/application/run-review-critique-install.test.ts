/**
 * Tests for RunReviewUseCase critique installation and update integration
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { RunReviewUseCase } = require('../../dist/application');
const {
  STAGE_QUALITY_GATE,
  RESOLVER_SOURCE_NONE,
  RESOLVER_SOURCE_USER_DATA,
  AiReviewReport,
  StateMachine
} = require('../../dist/domain');

import type { CritiqueInstallResult } from '../../src/domain';
import type {
  StateRepository,
  ConfigRepository,
  PlanGeneratorPort,
  CritiquePort,
  CritiqueInstallerPort,
  ConfirmationPromptPort,
  CritiqueResolution
} from '../../src/ports';

class MockStateRepo implements StateRepository {
  public snapshot: any = null;

  constructor(initialStage: string = STAGE_QUALITY_GATE) {
    const sm = new StateMachine();
    if (initialStage !== 'INITIALIZED') {
      sm.transition('DISCOVERY', { note: 'test' });
      sm.transition('PLAN', { note: 'test' });
      sm.transition('APPROVAL', { note: 'test' });
      sm.transition('IMPLEMENT', { note: 'test' });
      sm.transition('QUALITY_GATE', { note: 'test' });
    }
    this.snapshot = sm.toSnapshot();
  }

  async load(): Promise<any> {
    return this.snapshot;
  }

  async save(snapshot: any): Promise<void> {
    this.snapshot = snapshot;
  }

  async reset(): Promise<void> {
    this.snapshot = null;
  }

  getStateFilePath(): string {
    return '/fake/state.json';
  }
}

class MockConfigRepo implements ConfigRepository {
  loadConfig(): any {
    return {};
  }
  resolveModel(role: string): any {
    return {
      role,
      configured: 'flash',
      tier: 'flash',
      apiModel: 'gemini-3.5-flash'
    };
  }
  mapModelToTier(input: string): any {
    return 'flash';
  }
}

class MockPlanGenerator implements PlanGeneratorPort {
  resolvePlanFile(): any {
    return null;
  }
  readPlanDocument(): string {
    return '';
  }
  updateSummaryLog(): boolean {
    return true;
  }
  scaffoldPlanDirectory(): any {
    return null;
  }
  generatePlan(): any {
    return null;
  }
  generateSummaryLog(): any {
    return '';
  }
  findPlanDirectory(): any {
    return null;
  }
}

describe('RunReviewUseCase Critique Auto-Install & Update Detection', () => {
  it('prompts user and installs critique when absent if confirmation is confirmed', async () => {
    let promptAsked = false;
    let installCalled = false;
    let isAvailable = false;

    const mockPrompt: ConfirmationPromptPort = {
      async confirm(message: string): Promise<boolean> {
        promptAsked = true;
        assert.ok(message.includes('Critique CLI is not installed'));
        return true;
      }
    };

    const mockInstaller: CritiqueInstallerPort = {
      async fetchLatestVersion(): Promise<string | null> {
        return '0.2.0';
      },
      async install(): Promise<CritiqueInstallResult> {
        installCalled = true;
        isAvailable = true;
        return { success: true, version: '0.2.0', targetPath: '/mock/bin/critique.js', error: null };
      },
      async update(): Promise<CritiqueInstallResult> {
        return { success: true, version: '0.2.0', targetPath: '/mock/bin/critique.js', error: null };
      },
      async checkUpdateAvailable(): Promise<any> {
        return { currentVersion: '0.2.0', latestVersion: '0.2.0', lastCheckedAt: Date.now(), isOutdated: false, isInstalled: true, resolvedPath: '/mock/bin/critique.js' };
      },
      async getCachedVersionInfo(): Promise<any> {
        return null;
      }
    };

    const mockCritique: CritiquePort = {
      resolveReviewer(): CritiqueResolution {
        return {
          source: isAvailable ? RESOLVER_SOURCE_USER_DATA : RESOLVER_SOURCE_NONE,
          path: isAvailable ? '/mock/bin/critique.js' : null,
          isAvailable
        };
      },
      async review(): Promise<any> {
        return AiReviewReport.empty();
      },
      async getVersion(): Promise<string | null> {
        return '0.2.0';
      }
    };

    const useCase = new RunReviewUseCase(
      new MockStateRepo(),
      new MockConfigRepo(),
      new MockPlanGenerator(),
      undefined,
      mockCritique,
      undefined,
      undefined,
      mockInstaller,
      mockPrompt
    );

    const result = await useCase.execute({ dryRun: true });

    assert.strictEqual(promptAsked, true);
    assert.strictEqual(installCalled, true);
    assert.strictEqual(result.autoInstalled, true);
    assert.strictEqual(result.passed, true);
  });

  it('bypasses critique review when auto-install prompt is rejected', async () => {
    let installCalled = false;

    const mockPrompt: ConfirmationPromptPort = {
      async confirm(): Promise<boolean> {
        return false; // Rejected
      }
    };

    const mockInstaller: CritiqueInstallerPort = {
      async fetchLatestVersion(): Promise<string | null> {
        return '0.2.0';
      },
      async install(): Promise<CritiqueInstallResult> {
        installCalled = true;
        return { success: false, version: null, targetPath: null, error: 'User declined' };
      },
      async update(): Promise<CritiqueInstallResult> {
        return { success: false, version: null, targetPath: null, error: 'User declined' };
      },
      async checkUpdateAvailable(): Promise<any> {
        return { currentVersion: null, latestVersion: '0.2.0', lastCheckedAt: Date.now(), isOutdated: false, isInstalled: false, resolvedPath: null };
      },
      async getCachedVersionInfo(): Promise<any> {
        return null;
      }
    };

    const mockCritique: CritiquePort = {
      resolveReviewer(): CritiqueResolution {
        return {
          source: RESOLVER_SOURCE_NONE,
          path: null,
          isAvailable: false
        };
      },
      async review(): Promise<any> {
        return AiReviewReport.bypassed('Critique CLI binary not found.');
      }
    };

    const useCase = new RunReviewUseCase(
      new MockStateRepo(),
      new MockConfigRepo(),
      new MockPlanGenerator(),
      undefined,
      mockCritique,
      undefined,
      undefined,
      mockInstaller,
      mockPrompt
    );

    const result = await useCase.execute({ dryRun: true });

    assert.strictEqual(installCalled, false);
    assert.strictEqual(result.autoInstalled, false);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.verdict.status, 'CHANGES_REQUESTED');
  });

  it('detects outdated version and populates updateNotification banner', async () => {
    const mockInstaller: CritiqueInstallerPort = {
      async fetchLatestVersion(): Promise<string | null> {
        return '0.2.0';
      },
      async install(): Promise<CritiqueInstallResult> {
        return { success: true, version: '0.2.0', targetPath: '/mock/bin/critique.js', error: null };
      },
      async update(): Promise<CritiqueInstallResult> {
        return { success: true, version: '0.2.0', targetPath: '/mock/bin/critique.js', error: null };
      },
      async checkUpdateAvailable(currentVersion: string | null): Promise<any> {
        return {
          currentVersion: '0.1.6',
          latestVersion: '0.2.0',
          lastCheckedAt: Date.now(),
          isOutdated: true,
          isInstalled: true,
          resolvedPath: '/mock/bin/critique.js'
        };
      },
      async getCachedVersionInfo(): Promise<any> {
        return null;
      }
    };

    const mockCritique: CritiquePort = {
      resolveReviewer(): CritiqueResolution {
        return {
          source: RESOLVER_SOURCE_USER_DATA,
          path: '/mock/bin/critique.js',
          isAvailable: true
        };
      },
      async getVersion(): Promise<string | null> {
        return '0.1.6';
      },
      async review(): Promise<any> {
        return AiReviewReport.empty();
      }
    };

    const useCase = new RunReviewUseCase(
      new MockStateRepo(),
      new MockConfigRepo(),
      new MockPlanGenerator(),
      undefined,
      mockCritique,
      undefined,
      undefined,
      mockInstaller
    );

    const result = await useCase.execute({ dryRun: true });

    assert.ok(result.updateNotification);
    assert.ok(result.updateNotification.includes('v0.1.6 -> v0.2.0'));
    assert.ok(result.updateNotification.includes('agyloop critique update'));
  });
});
