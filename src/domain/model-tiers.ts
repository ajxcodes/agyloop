/* eslint-disable @typescript-eslint/no-unused-vars */


export const TIER_INHERIT = 'inherit' as const;

export const TIER_FLASH_LITE = 'flash_lite' as const;

export const TIER_FLASH = 'flash' as const;

export const TIER_PRO = 'pro' as const;


export const MODEL_TIERS = Object.freeze([
  TIER_INHERIT,
  TIER_FLASH_LITE,
  TIER_FLASH,
  TIER_PRO
] as const);


export type ModelTierName = typeof MODEL_TIERS[number];


export const MODEL_GEMINI_2_5_PRO = 'gemini-2.5-pro' as const;

export const MODEL_GEMINI_3_5_PRO = 'gemini-3.5-pro' as const;

export const MODEL_GEMINI_3_5_FLASH = 'gemini-3.5-flash' as const;

export const MODEL_GEMINI_2_5_FLASH = 'gemini-2.5-flash' as const;

export const MODEL_GEMINI_3_5_FLASH_LITE = 'gemini-3.5-flash-lite' as const;

export const MODEL_GEMINI_2_5_FLASH_LITE = 'gemini-2.5-flash-lite' as const;

export const DEFAULT_OPENCODE_MODEL = 'ollama/ornith:9b-128k' as const;


export const STATIC_MODELS = Object.freeze({
  [TIER_PRO]: Object.freeze({
    default: MODEL_GEMINI_2_5_PRO,
    candidates: Object.freeze([MODEL_GEMINI_2_5_PRO, MODEL_GEMINI_3_5_PRO])
  }),
  [TIER_FLASH]: Object.freeze({
    default: MODEL_GEMINI_3_5_FLASH,
    candidates: Object.freeze([MODEL_GEMINI_3_5_FLASH, MODEL_GEMINI_2_5_FLASH])
  }),
  [TIER_FLASH_LITE]: Object.freeze({
    default: MODEL_GEMINI_3_5_FLASH_LITE,
    candidates: Object.freeze([MODEL_GEMINI_3_5_FLASH_LITE, MODEL_GEMINI_2_5_FLASH_LITE])
  }),
  [TIER_INHERIT]: Object.freeze({
    default: TIER_INHERIT,
    candidates: Object.freeze([TIER_INHERIT])
  })
});

export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms (24 hours)
