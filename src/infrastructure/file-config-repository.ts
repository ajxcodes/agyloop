/**
 * agyloop - FileConfigRepository Infrastructure Adapter
 *
 * Implements ConfigRepository with hierarchical configuration resolution and model routing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ConfigRepository,
  AgyLoopConfig,
  ConfigLoadOptions
} from '../ports';
import {
  ModelTierName,
  MODEL_TIERS,
  SubagentRoleName,
  ROLE_PLANNER,
  ROLE_IMPLEMENTER,
  ROLE_GATE,
  ROLE_REVIEWER,
  TIER_PRO,
  TIER_INHERIT,
  TIER_FLASH_LITE,
  TIER_FLASH,
  STATIC_MODELS,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  ConfigResolutionError
} from '../domain';

export const DEFAULT_CONFIG: AgyLoopConfig = Object.freeze({
  models: Object.freeze({
    [ROLE_PLANNER]: TIER_PRO,
    [ROLE_IMPLEMENTER]: TIER_INHERIT,
    [ROLE_GATE]: TIER_FLASH_LITE,
    [ROLE_REVIEWER]: TIER_FLASH
  }),
  options: Object.freeze({
    commitAfter: false,
    gateTimeoutSeconds: DEFAULT_GATE_TIMEOUT_SECONDS,
    autoApproveInYolo: true,
    enableMcpInPlanner: true
  })
});

export function deepMerge<T extends Record<string, unknown>>(target: T, source: unknown): T {
  const output: Record<string, unknown> = { ...target };
  if (!source || typeof source !== 'object') {
    return output as T;
  }

  const srcObj = source as Record<string, unknown>;
  for (const key of Object.keys(srcObj)) {
    const srcVal = srcObj[key];
    const targetVal = output[key];

    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      output[key] = deepMerge(
        targetVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      );
    } else if (srcVal !== undefined) {
      output[key] = srcVal;
    }
  }

  return output as T;
}

export class FileConfigRepository implements ConfigRepository {
  private readonly defaultPluginConfigPath: string;

  constructor(options: { defaultPluginConfigPath?: string } = {}) {
    this.defaultPluginConfigPath =
      options.defaultPluginConfigPath ||
      path.resolve(__dirname, '..', '..', 'config.default.json');
  }

  public loadConfig(options: ConfigLoadOptions & { workspaceDir?: string } = {}): AgyLoopConfig {
    let resolved: AgyLoopConfig = {
      models: { ...DEFAULT_CONFIG.models },
      options: { ...DEFAULT_CONFIG.options }
    };

    // 1. Plugin default config file
    if (fs.existsSync(this.defaultPluginConfigPath)) {
      try {
        const raw = fs.readFileSync(this.defaultPluginConfigPath, 'utf8');
        const parsed = JSON.parse(raw);
        resolved = deepMerge(resolved as unknown as Record<string, unknown>, parsed) as unknown as AgyLoopConfig;
      } catch {
        // Fall back to embedded DEFAULT_CONFIG
      }
    }

    // 2. Global user configuration (~/.gemini/config/agyloop.json)
    const globalPath = path.join(os.homedir(), '.gemini', 'config', 'agyloop.json');
    if (fs.existsSync(globalPath)) {
      try {
        const raw = fs.readFileSync(globalPath, 'utf8');
        resolved = deepMerge(resolved as unknown as Record<string, unknown>, JSON.parse(raw)) as unknown as AgyLoopConfig;
      } catch {
        // Ignore read error
      }
    }

    // 3. Workspace configuration (.agyloop.json or .agyloop/config.json)
    const cwd = options.workspaceDir || options.cwd || process.cwd();
    const wsCandidates = [
      path.join(cwd, '.agyloop.json'),
      path.join(cwd, '.agyloop', 'config.json')
    ];

    for (const wsPath of wsCandidates) {
      if (fs.existsSync(wsPath)) {
        try {
          const raw = fs.readFileSync(wsPath, 'utf8');
          resolved = deepMerge(resolved as unknown as Record<string, unknown>, JSON.parse(raw)) as unknown as AgyLoopConfig;
          break;
        } catch {
          // Ignore read error
        }
      }
    }

    // 4. Custom configuration path if provided (--config <path>)
    if (options.customPath) {
      const resolvedCustomPath = path.isAbsolute(options.customPath)
        ? options.customPath
        : path.resolve(cwd, options.customPath);

      if (!fs.existsSync(resolvedCustomPath)) {
        throw new ConfigResolutionError(
          options.customPath,
          `Custom config file not found: ${resolvedCustomPath}`
        );
      }

      try {
        const raw = fs.readFileSync(resolvedCustomPath, 'utf8');
        resolved = deepMerge(resolved as unknown as Record<string, unknown>, JSON.parse(raw)) as unknown as AgyLoopConfig;
      } catch (err: unknown) {
        throw new ConfigResolutionError(
          options.customPath,
          `Failed to parse custom config file: ${resolvedCustomPath}`,
          { cause: err instanceof Error ? err.message : String(err) }
        );
      }
    }

    return resolved;
  }

  public mapModelToTier(inputModel: string): ModelTierName {
    if (!inputModel || typeof inputModel !== 'string') {
      return TIER_INHERIT;
    }

    let norm = inputModel.toLowerCase().trim();
    if (norm.startsWith('models/')) {
      norm = norm.substring(7);
    }

    // Check direct tier matches
    if (norm === TIER_PRO) return TIER_PRO;
    if (norm === TIER_FLASH) return TIER_FLASH;
    if (norm === TIER_FLASH_LITE) return TIER_FLASH_LITE;
    if (norm === TIER_INHERIT) return TIER_INHERIT;

    // Check candidate lists
    for (const [tier, meta] of Object.entries(STATIC_MODELS)) {
      if (meta.candidates.includes(norm as never)) {
        return tier as ModelTierName;
      }
    }

    // Fallback heuristic by string matching
    if (norm.includes('flash-lite')) return TIER_FLASH_LITE;
    if (norm.includes('flash')) return TIER_FLASH;
    if (norm.includes('pro')) return TIER_PRO;

    return TIER_INHERIT;
  }

  public resolveModel(
    role: SubagentRoleName | string,
    config: AgyLoopConfig
  ): {
    role: string;
    configured: string;
    tier: ModelTierName;
    apiModel: string;
  } {
    const rawConfigured =
      (config.models && config.models[role]) || DEFAULT_CONFIG.models[role] || TIER_INHERIT;
    const tier = this.mapModelToTier(rawConfigured);
    const isDirectTier = (MODEL_TIERS as readonly string[]).includes(
      rawConfigured.toLowerCase().trim()
    );
    const apiModel = isDirectTier
      ? STATIC_MODELS[tier]?.default || rawConfigured
      : rawConfigured;

    return {
      role,
      configured: rawConfigured,
      tier,
      apiModel
    };
  }
}
