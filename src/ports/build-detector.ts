/**
 * agyloop - BuildDetectorPort Interface
 *
 * Inversion of control contract for repository ecosystem detection and command resolution.
 */

import { Ecosystem, GateCommandDefinition, GateCommandPlan } from '../domain';
import { AgyLoopConfig } from './config-repository';

export interface ProjectDetectionOptions {
  readonly workspaceDir: string;
  readonly configPath?: string | null;
}

/**
 * Optional inputs to command-plan resolution (issue #298).
 *
 * `planTargets` are the approved plan's Quality Gate Targets, in plan order.
 * They sit BELOW explicit CLI commands and ABOVE config/auto-detection, so an
 * approved plan can widen the gate without letting a plan silently override an
 * operator's explicit command.
 */
export interface GateCommandResolutionOptions {
  readonly explicitCommands?: readonly string[] | readonly GateCommandDefinition[];
  readonly planTargets?: readonly string[];
  readonly planPath?: string | null;
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
   * Resolves the concrete verification commands WITH provenance (issue #298).
   *
   * Precedence: explicit > plan > config > act > auto-detect > default.
   * Detected Node lint is appended when the chosen list omits it.
   */
  resolveCommandPlan(
    workspaceDir: string,
    config?: AgyLoopConfig,
    options?: GateCommandResolutionOptions
  ): Promise<GateCommandPlan>;

  /**
   * Resolves the concrete verification commands following strict precedence:
   * 1. explicitCommands parameter
   * 2. approved plan targets
   * 3. config overrides (gateCommands / quality_gates.commands)
   * 4. act container gate
   * 5. auto-detected ecosystem commands
   * 6. default gate commands fallback
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
