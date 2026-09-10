/**
 * agyloop - GeminiModelCatalog Infrastructure Adapter
 *
 * Implements ModelCatalogPort to discover Gemini models and map them
 * to Antigravity subagent tiers, with local caching and static fallback catalog.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ModelCatalogPort, DiscoveredModel, FetchModelsOptions } from '../ports';
import {
  ModelTierName,
  STATIC_MODELS,
  TIER_PRO,
  TIER_FLASH,
  TIER_FLASH_LITE,
  MODEL_CACHE_TTL_MS
} from '../domain';
import { FileConfigRepository } from './file-config-repository';

interface CachedCatalog {
  timestamp: number;
  models: DiscoveredModel[];
}

export class GeminiModelCatalog implements ModelCatalogPort {
  private readonly cacheFilePath: string;
  private readonly configRepo: FileConfigRepository;

  constructor(options: { cacheFilePath?: string; configRepo?: FileConfigRepository } = {}) {
    this.cacheFilePath =
      options.cacheFilePath ||
      path.join(os.homedir(), '.gemini', 'cache', 'agyloop-models.json');
    this.configRepo = options.configRepo || new FileConfigRepository();
  }

  public getStaticModels(): readonly DiscoveredModel[] {
    const list: DiscoveredModel[] = [];
    const descriptions: Record<string, string> = {
      [TIER_PRO]: 'High-reasoning, architectural planning, and deep analysis model tier',
      [TIER_FLASH]: 'Fast, balanced general execution and review model tier',
      [TIER_FLASH_LITE]: 'Ultra-lightweight, rapid diagnostic, linting, and gate checking model tier'
    };

    for (const [tier, meta] of Object.entries(STATIC_MODELS)) {
      if (tier === 'inherit') continue;
      const modelTier = tier as ModelTierName;
      meta.candidates.forEach((cand) => {
        list.push({
          id: cand,
          displayName: cand,
          description: descriptions[tier] || `${tier} tier candidate`,
          tier: modelTier
        });
      });
    }

    return Object.freeze(list);
  }

  private readCache(cachePath: string = this.cacheFilePath): CachedCatalog | null {
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(content) as CachedCatalog;
      if (Date.now() - parsed.timestamp < MODEL_CACHE_TTL_MS) {
        return parsed;
      }
    } catch {
      // Ignore cache read errors
    }
    return null;
  }

  private writeCache(models: readonly DiscoveredModel[], cachePath: string = this.cacheFilePath): void {
    try {
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: CachedCatalog = {
        timestamp: Date.now(),
        models: [...models]
      };
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Ignore cache write errors
    }
  }

  public async fetchModels(options: FetchModelsOptions = {}): Promise<readonly DiscoveredModel[]> {
    const targetCachePath = options.cachePath || this.cacheFilePath;

    if (!options.forceRefresh) {
      const cached = this.readCache(targetCachePath);
      if (cached && Array.isArray(cached.models) && cached.models.length > 0) {
        return cached.models;
      }
    }

    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.ok) {
          interface GeminiApiResponse {
            models?: Array<{
              name?: string;
              displayName?: string;
              description?: string;
              supportedGenerationMethods?: string[];
            }>;
          }

          const data = (await res.json()) as GeminiApiResponse;
          if (Array.isArray(data.models)) {
            const discovered: DiscoveredModel[] = [];
            data.models.forEach((m) => {
              const rawId = (m.name || '').replace(/^models\//, '');
              const methods = m.supportedGenerationMethods || [];
              if (methods.includes('generateContent') && rawId.includes('gemini')) {
                const tier = this.configRepo.mapModelToTier(rawId);
                discovered.push({
                  id: rawId,
                  displayName: m.displayName || rawId,
                  description: m.description || '',
                  tier
                });
              }
            });

            if (discovered.length > 0) {
              this.writeCache(discovered);
              return discovered;
            }
          }
        }
      } catch {
        // Fallback to static catalog on fetch failure or timeout
      }
    }

    const fallback = this.getStaticModels();
    this.writeCache(fallback);
    return fallback;
  }
}
