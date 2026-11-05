/**
 * codeloop - ONE canonical ConfigRepository double (issue #544 / AC2)
 *
 * Retires `ConfigRepositoryDouble` / `ConfigRepositoryDouble` / `ConfigRepositoryDouble`.
 * The canonical fake IS the recording surface: `calls` per port method, plus
 * the `config` field the local copies asserted on. Config values come from the
 * ONE `tests/helpers/config.ts` defaults; divergences are explicit options.
 */

import type { CodeLoopConfig, ConfigRepository } from '../../../src/ports';

const { makeMockConfig } = require('../config.ts');

interface FakeConfigRepositoryOptions {
  /** Config overrides (models/options) identical to `tests/helpers/config.ts`. */
  config?: Partial<CodeLoopConfig>;
  mapModelToTier?: (inputModel: string) => string;
  /** Throw from loadConfig (corrupt-config fixtures). */
  loadConfigError?: Error | (() => never);
}


class FakeConfigRepository implements ConfigRepository {
  public calls: Record<string, unknown[]> = {
    loadConfig: [],
    resolveModel: [],
    mapModelToTier: []
  };

  public readonly config: CodeLoopConfig;
  private readonly behaviour: {
    mapModelToTier: (inputModel: string) => string;
  };
  public loadConfigError: FakeConfigRepositoryOptions['loadConfigError'];

  constructor(options: FakeConfigRepositoryOptions = {}) {
    this.loadConfigError = options.loadConfigError;
    const base = makeMockConfig({ config: options.config, mapModelToTier: options.mapModelToTier });
    this.config = base.loadConfig();
    this.behaviour = { mapModelToTier: options.mapModelToTier ?? defaultTierMapper };
  }

  public loadConfig(): CodeLoopConfig {
    this.calls.loadConfig.push([]);
    if (typeof this.loadConfigError === 'function') {
      return (this.loadConfigError as () => never)();
    }
    if (this.loadConfigError instanceof Error) {
      throw this.loadConfigError;
    }
    return this.config;
  }

  public resolveModel(role: string, provided?: CodeLoopConfig) {
    this.calls.resolveModel.push([role]);
    const source = provided ?? this.config;
    const models = source.models as Record<string, string | undefined>;
    const configured = models[String(role)] ?? 'inherit';
    return {
      configured,
      tier: this.behaviour.mapModelToTier(configured) as never,
      apiModel: configured
    };
  }

  public mapModelToTier(inputModel: string) {
    this.calls.mapModelToTier.push([inputModel]);
    return this.behaviour.mapModelToTier(inputModel) as never;
  }
}

function defaultTierMapper(inputModel: string): string {
  const norm = String(inputModel || '').toLowerCase().trim();
  if (norm === 'pro' || norm.includes('pro')) return 'pro';
  if (norm.includes('flash_lite')) return 'flash_lite';
  if (norm.includes('flash')) return 'flash';
  return 'inherit';
}

function createFakeConfigRepository(options?: FakeConfigRepositoryOptions): FakeConfigRepository {
  return new FakeConfigRepository(options ?? {});
}

module.exports = { FakeConfigRepository, createFakeConfigRepository };
