/**
 * codeloop - canonical mock config (issue #544)
 *
 * ONE definition of the `makeMockConfig` family (10 measured local copies in
 * tests/application). The defaults are the dominant variant's config:
 *
 *   models  : { planner: 'pro', implementer: 'inherit', gate: 'flash_lite', reviewer: 'flash' }
 *   options : { commitAfter: false, gateTimeoutSeconds: 300, autoApproveInYolo: true, enableMcpInPlanner: true }
 *
 * The measured divergences (gate `flash` vs `flash_lite`, toggle booleans)
 * arrive as explicit `overrides.config`. The `mapModelToTier` behaviour is the
 * REAL port semantic (tier names resolve to themselves, everything else falls
 * back to `inherit`); suites that pinned a constant tier pass their own
 * behaviour via `overrides.mapModelToTier` so the divergence stays explicit at
 * their call site instead of drifting further copies.
 *
 * Erasable-TS-only: no parameter properties, no enum, no namespace.
 */

import type { CodeLoopConfig, ConfigRepository } from '../../src/ports';

const DEFAULT_MODELS = {
  planner: 'pro',
  implementer: 'inherit',
  gate: 'flash_lite',
  reviewer: 'flash'
};

const DEFAULT_OPTIONS = {
  commitAfter: false,
  gateTimeoutSeconds: 300,
  autoApproveInYolo: true,
  enableMcpInPlanner: true
};

interface MockConfigOverrides {
  /** Overrides merged over the default config (models/options deep-merged). */
  config?: Partial<CodeLoopConfig>;
  /** Override the tier resolution behaviour. Default: real port semantics. */
  mapModelToTier?: (inputModel: string) => string;
}

function makeMockConfig(overrides?: MockConfigOverrides): ConfigRepository {
  const config: CodeLoopConfig = {
    models: { ...(overrides?.config?.models ?? DEFAULT_MODELS) } as never,
    options: { ...(overrides?.config?.options ?? DEFAULT_OPTIONS) } as never,
    ...(overrides?.config as Record<string, unknown> | undefined)
  };

  const mapModelToTier =
    overrides?.mapModelToTier ??
    ((inputModel: string): string => {
      const norm = String(inputModel || '').toLowerCase().trim();
      if (norm === 'pro' || norm.includes('pro')) return 'pro';
      if (norm.includes('flash_lite')) return 'flash_lite';
      if (norm.includes('flash')) return 'flash';
      return 'inherit';
    });

  const repo: ConfigRepository = {
    loadConfig(): CodeLoopConfig {
      return config;
    },
    resolveModel(role: string, provided?: CodeLoopConfig) {
      const source = provided ?? config;
      const models = source.models as Record<string, string | undefined>;
      const configured = models[String(role)] ?? 'inherit';
      return {
        configured,
        tier: mapModelToTier(configured) as never,
        apiModel: mappedApiModel(configured)
      };
    },
    mapModelToTier(inputModel: string) {
      return mapModelToTier(inputModel) as never;
    }
  };
  return repo;
}

/** Keep the apiModel where a suite pinned it: tier strings map to themselves. */
function mappedApiModel(configured: string): string {
  return configured;
}

module.exports = { makeMockConfig };
