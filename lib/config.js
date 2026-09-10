/**
 * agyloop - Configuration & Model Routing Engine (Legacy Bridge)
 *
 * Bridges legacy calls to the compiled TypeScript infrastructure adapters.
 */

const {
  FileConfigRepository,
  DEFAULT_CONFIG,
  deepMerge
} = require('../dist/infrastructure/file-config-repository');
const { GeminiModelCatalog } = require('../dist/infrastructure/gemini-model-catalog');

const defaultRepo = new FileConfigRepository();
const defaultCatalog = new GeminiModelCatalog({ configRepo: defaultRepo });

function loadConfig(options = {}) {
  return defaultRepo.loadConfig(options);
}

function mapModelToTier(inputModel) {
  return defaultRepo.mapModelToTier(inputModel);
}

function resolveModel(role, config) {
  return defaultRepo.resolveModel(role, config);
}

function fetchAvailableModels(options = {}) {
  return defaultCatalog.fetchModels(options);
}

module.exports = {
  DEFAULT_CONFIG,
  deepMerge,
  mapModelToTier,
  loadConfig,
  resolveModel,
  fetchAvailableModels
};
