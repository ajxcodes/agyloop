/**
 * agyloop - Configuration Loader & Model Routing Engine
 *
 * Hierarchically loads and resolves configuration:
 * 1. CLI options
 * 2. Custom config file (--config <path>)
 * 3. Workspace config (.agyloop.json or .agyloop/config.json)
 * 4. Global user config (~/.gemini/config/agyloop.json)
 * 5. Plugin defaults (config.default.json)
 *
 * Supports bidirectional model routing:
 * - Antigravity subagent tier enums: 'inherit', 'flash_lite', 'flash', 'pro'
 * - Full canonical Gemini API model names: 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-pro'
 * - Dynamic model discovery via Gemini API with local caching.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL_TIERS = Object.freeze(['inherit', 'flash_lite', 'flash', 'pro']);

const STATIC_MODELS = Object.freeze({
  pro: {
    default: 'gemini-2.5-pro',
    candidates: ['gemini-2.5-pro', 'gemini-3.5-pro']
  },
  flash: {
    default: 'gemini-3.5-flash',
    candidates: ['gemini-3.5-flash', 'gemini-2.5-flash']
  },
  flash_lite: {
    default: 'gemini-3.5-flash-lite',
    candidates: ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite']
  },
  inherit: {
    default: 'inherit',
    candidates: ['inherit']
  }
});

const DEFAULT_CONFIG = Object.freeze({
  models: {
    planner: 'pro',
    implementer: 'inherit',
    gate: 'flash_lite',
    reviewer: 'flash'
  },
  options: {
    commitAfter: false,
    gateTimeoutSeconds: 300,
    autoApproveInYolo: true,
    enableMcpInPlanner: true
  }
});

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Loads environment variables from ~/.env and ./.env without external dependencies.
 */
function loadEnv() {
  const envPaths = [
    path.join(os.homedir(), '.env'),
    path.join(process.cwd(), '.env')
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        content.split('\n').forEach((line) => {
          const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
          if (match) {
            const key = match[1];
            let val = match[2] || '';
            if (val.length > 0 && val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
              val = val.replace(/\\n/gm, '\n');
            }
            val = val.replace(/(^['"]|['"]$)/g, '').trim();
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        });
      } catch (err) {
        // Ignore read errors
      }
    }
  }
}

/**
 * Deeply merges two objects, with source properties overriding target.
 */
function deepMerge(target, source) {
  const output = { ...target };
  if (!source || typeof source !== 'object') {
    return output;
  }
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      output[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      output[key] = source[key];
    }
  }
  return output;
}

/**
 * Maps a full model name string to its corresponding Antigravity tier enum.
 * @param {string} modelName
 * @returns {string} One of 'pro', 'flash', 'flash_lite', 'inherit'
 */
function mapModelToTier(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return 'inherit';
  }
  const clean = modelName.trim().toLowerCase().replace(/^models\//, '');

  if (MODEL_TIERS.includes(clean)) {
    return clean;
  }

  if (clean.includes('pro')) {
    return 'pro';
  }
  if (clean.includes('flash-lite') || clean.includes('flash_lite')) {
    return 'flash_lite';
  }
  if (clean.includes('flash')) {
    return 'flash';
  }

  return 'inherit';
}

/**
 * Fetches available Gemini models supporting generateContent from the Gemini API.
 * Uses local file caching with a 24h TTL.
 *
 * @param {Object} [options]
 * @param {string} [options.apiKey]
 * @param {string} [options.cachePath]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {Promise<Array<{ id: string, displayName: string, tier: string }>>}
 */
async function fetchAvailableModels(options = {}) {
  loadEnv();
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  const cachePath =
    options.cachePath ||
    path.join(process.cwd(), '.agyloop', 'models_cache.json');
  const forceRefresh = options.forceRefresh || false;

  // 1. Check local cache
  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const age = Date.now() - (cached.timestamp || 0);
      if (age < CACHE_TTL_MS && Array.isArray(cached.models)) {
        return cached.models;
      }
    } catch (e) {
      // Ignore corrupted cache
    }
  }

  // 2. Fetch live from Gemini API if key is available
  if (apiKey && typeof fetch === 'function') {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        const models = (data.models || [])
          .filter((m) =>
            m.supportedGenerationMethods &&
            m.supportedGenerationMethods.includes('generateContent')
          )
          .map((m) => {
            const id = (m.name || '').replace(/^models\//, '');
            return {
              id,
              displayName: m.displayName || id,
              tier: mapModelToTier(id)
            };
          });

        if (models.length > 0) {
          // Write cache
          try {
            const dir = path.dirname(cachePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(
              cachePath,
              JSON.stringify(
                { timestamp: Date.now(), models },
                null,
                2
              ) + '\n',
              'utf8'
            );
          } catch (e) {
            // Ignore cache write errors
          }
          return models;
        }
      }
    } catch (err) {
      // Graceful fallback to static list
    }
  }

  // 3. Fallback to static catalog
  const staticList = [];
  for (const [tier, info] of Object.entries(STATIC_MODELS)) {
    for (const id of info.candidates) {
      if (id !== 'inherit') {
        staticList.push({
          id,
          displayName: id,
          tier
        });
      }
    }
  }
  return staticList;
}

/**
 * Loads configuration hierarchically.
 * @param {Object} [options]
 * @param {string} [options.workspaceDir]
 * @param {string} [options.customPath]
 * @returns {Object} Merged configuration
 */
function loadConfig(options = {}) {
  const workspaceDir = options.workspaceDir || process.cwd();
  let merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // 1. Global config candidate locations
  const globalPaths = [
    path.join(os.homedir(), '.gemini', 'config', 'agyloop.json'),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'agyloop.json')
  ];

  for (const gp of globalPaths) {
    if (fs.existsSync(gp)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(gp, 'utf8'));
        merged = deepMerge(merged, parsed);
        break;
      } catch (err) {
        console.warn(`Warning: Could not parse global config at ${gp}:`, err.message);
      }
    }
  }

  // 2. Workspace config candidate locations
  const workspacePaths = [
    path.join(workspaceDir, '.agyloop.json'),
    path.join(workspaceDir, '.agyloop', 'config.json')
  ];

  for (const wp of workspacePaths) {
    if (fs.existsSync(wp)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(wp, 'utf8'));
        merged = deepMerge(merged, parsed);
        break;
      } catch (err) {
        console.warn(`Warning: Could not parse workspace config at ${wp}:`, err.message);
      }
    }
  }

  // 3. Custom path if supplied
  if (options.customPath) {
    const cp = path.resolve(workspaceDir, options.customPath);
    if (fs.existsSync(cp)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cp, 'utf8'));
        merged = deepMerge(merged, parsed);
      } catch (err) {
        console.error(`Error: Could not parse custom config file at ${cp}:`, err.message);
      }
    } else {
      console.warn(`Warning: Custom config file not found at ${cp}`);
    }
  }

  return merged;
}

/**
 * Resolves model parameters for a specific subagent role.
 *
 * @param {string} role - 'planner' | 'implementer' | 'gate' | 'reviewer'
 * @param {Object} [config] - Loaded configuration object
 * @param {Array} [availableModels] - Optional list from fetchAvailableModels
 * @returns {{ role: string, tier: string, apiModel: string, configured: string }}
 */
function resolveModel(role, config = DEFAULT_CONFIG, availableModels = []) {
  const configured =
    (config && config.models && config.models[role]) ||
    DEFAULT_CONFIG.models[role] ||
    'inherit';

  let tier = 'inherit';
  let apiModel = 'inherit';

  if (MODEL_TIERS.includes(configured)) {
    tier = configured;
    apiModel = (STATIC_MODELS[tier] && STATIC_MODELS[tier].default) || 'inherit';
  } else {
    // It's an explicit model name (e.g. 'gemini-3.5-flash-lite')
    tier = mapModelToTier(configured);
    apiModel = configured;

    // Validate against available models if provided
    if (availableModels.length > 0) {
      const match = availableModels.find(
        (m) => m.id.toLowerCase() === configured.toLowerCase()
      );
      if (match) {
        tier = match.tier;
        apiModel = match.id;
      }
    }
  }

  // Ensure tier is valid Antigravity subagent tier
  if (!MODEL_TIERS.includes(tier)) {
    console.warn(
      `Warning: Resolved tier '${tier}' for role '${role}' is invalid. Falling back to 'inherit'.`
    );
    tier = 'inherit';
    apiModel = 'inherit';
  }

  return {
    role,
    tier,
    apiModel,
    configured
  };
}

module.exports = {
  MODEL_TIERS,
  STATIC_MODELS,
  DEFAULT_CONFIG,
  loadEnv,
  deepMerge,
  mapModelToTier,
  fetchAvailableModels,
  loadConfig,
  resolveModel
};
