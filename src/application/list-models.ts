/**
 * agyloop - ListModelsUseCase
 *
 * Queries ModelCatalogPort to retrieve discovered Gemini models and their tier mappings.
 */

import { ModelCatalogPort, DiscoveredModel, FetchModelsOptions } from '../ports';

export class ListModelsUseCase {
  private readonly modelCatalog: ModelCatalogPort;

  constructor(modelCatalog: ModelCatalogPort) {
    this.modelCatalog = modelCatalog;
  }

  public async execute(options: FetchModelsOptions = {}): Promise<readonly DiscoveredModel[]> {
    return this.modelCatalog.fetchModels(options);
  }
}
