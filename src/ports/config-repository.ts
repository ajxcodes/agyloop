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

export interface ActConfig {
  readonly enabled?: boolean;
  readonly workflow?: string;
  readonly job?: string;
}

export interface PipelineOptionsConfig {
  readonly commitAfter: boolean;
  readonly gateTimeoutSeconds: number;
  readonly autoApproveInYolo: boolean;
  readonly enableMcpInPlanner: boolean;
  readonly gateCommands?: readonly string[] | readonly unknown[];
  readonly containerGates?: boolean;
  readonly act?: ActConfig;
  readonly [option: string]: unknown;
}


export interface IssueMigrationConfig {
  readonly mode?: 'per_task' | 'milestone_only' | string;
  readonly trackerRepo?: string;
  readonly hookCommand?: string;
}

export interface CircuitBreakersConfig {
  readonly maxTurnsPerSubagent?: number;
  readonly maxGateRetries?: number;
  readonly maxConcurrentSubagents?: number;
  readonly maxWallClockDurationSeconds?: number;
  readonly tokenBudgetThreshold?: number;
  readonly actionOnTrip?: 'pause_for_human' | 'abort' | 'warn' | string;
}

export interface VersioningConfig {
  readonly strategy?: 'package_json' | 'git_tag_only' | 'none' | string;
  readonly file?: string;
  readonly autoCreate?: boolean;
  readonly initialVersion?: string;
}

export type RunnerType = 'auto' | 'antigravity' | 'opencode';

export interface OpenCodeConfig {
  readonly model?: string;
  readonly [key: string]: unknown;
}

export interface GitConfig {
  readonly remote?: string;
  readonly baseBranch?: string;
  readonly collectorPrefix?: string;
  readonly taskPrefix?: string;
  readonly forge?: 'github' | 'gitlab' | 'generic' | string;
}

export interface VerificationCommandConfig {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly timeoutSeconds?: number;
}

export interface SmokeSuiteConfig {
  readonly setup?: string;
  readonly teardown?: string;
  readonly timeoutSeconds?: number;
  readonly steps: readonly VerificationCommandConfig[];
}

export interface VerificationConfig {
  readonly ecosystem?: string;
  readonly fastCheck?: readonly VerificationCommandConfig[];
  readonly smoke?: SmokeSuiteConfig;
  readonly gates?: readonly VerificationCommandConfig[];
}

export interface AgyLoopConfig {
  readonly runner?: RunnerType;
  readonly opencode?: OpenCodeConfig;
  readonly models: ModelRoutingConfig;
  readonly options: PipelineOptionsConfig;
  readonly circuitBreakers?: CircuitBreakersConfig;
  readonly migration?: IssueMigrationConfig;
  readonly versioning?: VersioningConfig;
  readonly git?: GitConfig;
  readonly verification?: VerificationConfig;
}

export interface ConfigLoadOptions {
  readonly customPath?: string | null;
  readonly cwd?: string;
  readonly model?: string;
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
