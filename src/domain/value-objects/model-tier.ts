/**
 * agyloop - ModelTier Value Object
 *
 * Self-validating value object representing Antigravity subagent model tiers.
 */

import {
  MODEL_TIERS,
  ModelTierName,
  STATIC_MODELS,
  TIER_INHERIT,
  TIER_FLASH_LITE,
  TIER_FLASH,
  TIER_PRO
} from '../constants';
import { ValidationError } from '../errors';

export class ModelTier {
  public readonly value: ModelTierName;

  constructor(rawTier: string) {
    if (!rawTier || typeof rawTier !== 'string') {
      throw new ValidationError('modelTier', rawTier, 'Model tier cannot be empty and must be a string.');
    }

    const normalized = rawTier.toLowerCase().trim() as ModelTierName;
    if (!MODEL_TIERS.includes(normalized)) {
      throw new ValidationError(
        'modelTier',
        rawTier,
        `Invalid model tier '${rawTier}'. Valid tiers are: ${MODEL_TIERS.join(', ')}.`
      );
    }

    this.value = normalized;
    Object.freeze(this);
  }

  public getDefaultApiModel(): string {
    return STATIC_MODELS[this.value]?.default || this.value;
  }

  public equals(other: ModelTier | null | undefined): boolean {
    if (!other) return false;
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }

  public static from(value: string): ModelTier {
    return new ModelTier(value);
  }

  public static inherit(): ModelTier {
    return new ModelTier(TIER_INHERIT);
  }

  public static flashLite(): ModelTier {
    return new ModelTier(TIER_FLASH_LITE);
  }

  public static flash(): ModelTier {
    return new ModelTier(TIER_FLASH);
  }

  public static pro(): ModelTier {
    return new ModelTier(TIER_PRO);
  }
}
