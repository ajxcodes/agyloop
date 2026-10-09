/**
 * agyloop - BuildDetectorPort Interface
 *
 * Inversion of control contract for repository ecosystem detection and command resolution.
 */

import { Ecosystem, GateCommandDefinition } from '../domain';
import { AgyLoopConfig } from './config-repository';

export interface ProjectDetectionOptions {
  readonly workspaceDir: string;
  readonly configPath?: string | null;
}

export interface DetectedProject {
  readonly workspaceDir: string;
  readonly ecosystems: readonly Ecosystem[];
  readonly primaryEcosystem: Ecosystem;
  readonly commands: readonly GateCommandDefinition[];
  readonly hasOverrides: boolean;
}

export interface BuildDetectorPort {
  /**
   * Inspects workspace markers and lockfiles to detect ecosystems and verification commands.
   */
  detect(workspaceDir: string, config?: AgyLoopConfig): Promise<DetectedProject>;

  /**
   * Resolves the concrete verification commands following strict precedence:
   * 1. explicitCommands parameter
   * 2. config overrides (gateCommands / quality_gates.commands)
   * 3. auto-detected ecosystem commands
   * 4. default gate commands fallback
   */
  resolveCommands(
    workspaceDir: string,
    config?: AgyLoopConfig,
    explicitCommands?: readonly string[] | readonly GateCommandDefinition[]
  ): Promise<readonly GateCommandDefinition[]>;

  /**
   * Resolves the available container runtime CLI ('podman' | 'docker' | null).
   */
  resolveContainerRuntime?(): 'podman' | 'docker' | null;

  /**
   * Resolves the container daemon socket path and runtime type.
   */
  resolveContainerSocket?(): { socketPath: string; runtime: 'podman' | 'docker' } | null;
}
