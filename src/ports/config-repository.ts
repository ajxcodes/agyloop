/**
 * agyloop - ConfigRepository Port Interface
 *
 * Inversion of control contract for multi-source hierarchical configuration loading.
 */

import { ModelTierName, SubagentRoleName } from '../domain';

export interface ModelRoutingConfig {
  readonly planner: string;
  readonly implementer: string;
  readonly gate: string;
  readonly reviewer: string;
  readonly [role: string]: string;
}

export interface PipelineOptionsConfig {
  readonly commitAfter: boolean;
  readonly gateTimeoutSeconds: number;
  readonly autoApproveInYolo: boolean;
  readonly enableMcpInPlanner: boolean;
  readonly gateCommands?: readonly string[] | readonly unknown[];
  readonly [option: string]: unknown;
}


export interface IssueMigrationConfig {
  readonly mode?: 'per_task' | 'milestone_only' | string;
  readonly trackerRepo?: string;
  readonly hookCommand?: string;
}

export interface VersioningConfig {
  readonly strategy?: 'package_json' | 'git_tag_only' | 'none' | string;
  readonly file?: string;
  readonly autoCreate?: boolean;
  readonly initialVersion?: string;
}

export interface AgyLoopConfig {
  readonly models: ModelRoutingConfig;
  readonly options: PipelineOptionsConfig;
  readonly migration?: IssueMigrationConfig;
  readonly versioning?: VersioningConfig;
}

export interface ConfigLoadOptions {
  readonly customPath?: string | null;
  readonly cwd?: string;
}

export interface ConfigRepository {
  /**
   * Loads hierarchical configuration.
   */
  loadConfig(options?: ConfigLoadOptions): AgyLoopConfig;

  /**
   * Resolves model tier and API model for a specific role.
   */
  resolveModel(
    role: SubagentRoleName | string,
    config: AgyLoopConfig
  ): {
    configured: string;
    tier: ModelTierName;
    apiModel: string;
  };

  /**
   * Maps an arbitrary model name or tier string to canonical ModelTierName.
   */
  mapModelToTier(inputModel: string): ModelTierName;
}
