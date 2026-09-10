/**
 * agyloop - ModelCatalogPort Interface
 *
 * Inversion of control interface for Gemini model discovery and tier mapping.
 */

import { ModelTierName } from '../domain';

export interface DiscoveredModel {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly tier: ModelTierName;
}

export interface FetchModelsOptions {
  readonly forceRefresh?: boolean;
  readonly cachePath?: string;
  readonly apiKey?: string;
}

export interface ModelCatalogPort {
  /**
   * Fetches available candidate models with Antigravity tier mappings.
   */
  fetchModels(options?: FetchModelsOptions): Promise<readonly DiscoveredModel[]>;
}
