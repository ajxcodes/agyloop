/**
 * codeloop - ONE canonical BuildDetectorPort double (issue #544 / AC2)
 * Retires the 6 `BuildDetectorDouble` copies.
 */

import type { BuildDetectorPort } from '../../../src/ports';

interface FakeBuildDetectorOptions {
  detectedProject?: Record<string, unknown>;
  /** workspaceDir -> gate-command arrays for the resolution tests. */
  commandPlan?: Record<string, unknown[]>;
  containerRuntime?: string | null;
  containerSocket?: { socketPath: string; runtime: string } | null;
  containerProbe?: unknown;
}

class FakeBuildDetector implements BuildDetectorPort {
  public calls: Record<string, unknown[]> = {
    detect: [],
    resolveCommands: [],
    resolveCommandPlan: [],
    resolveContainerRuntime: [],
    resolveContainerSocket: [],
    probeContainerRuntime: []
  };

  public detectedProject: Record<string, unknown>;
  public commandPlan: Record<string, unknown[]>;
  public containerRuntime: string | null;
  public containerSocket: { socketPath: string; runtime: string } | null;
  public containerProbe: unknown;

  constructor(options: FakeBuildDetectorOptions = {}) {
    this.detectedProject =
      options.detectedProject ??
      ({
        workspaceDir: '/mock/workspace',
        ecosystems: ['node'],
        primaryEcosystem: 'node',
        commands: []
      } as Record<string, unknown>);
    this.commandPlan = options.commandPlan ?? {};
    this.containerRuntime = options.containerRuntime ?? null;
    this.containerSocket = options.containerSocket ?? null;
    this.containerProbe = options.containerProbe ?? null;
  }

  public async detect(workspaceDir: string, _config?: never): Promise<never> {
    this.calls.detect.push([workspaceDir, _config]);
    return { ...this.detectedProject, workspaceDir } as never;
  }

  public async resolveCommandPlan(workspaceDir: string, _config?: never, _options?: never): Promise<never> {
    this.calls.resolveCommandPlan.push([workspaceDir, _config, _options]);
    return (this.commandPlan[workspaceDir] ?? []) as never;
  }

  public async resolveCommands(workspaceDir: string, _config?: never, _explicit?: never): Promise<never> {
    this.calls.resolveCommands.push([workspaceDir, _config, _explicit]);
    return (this.commandPlan[workspaceDir] ?? []) as never;
  }

  public resolveContainerRuntime(): never {
    return (this.containerRuntime ?? null) as never;
  }

  public resolveContainerSocket(): never {
    return (this.containerSocket as unknown) as never;
  }

  public probeContainerRuntime(): never {
    return (this.containerProbe ?? null) as never;
  }
}

module.exports = { FakeBuildDetector };
