/**
 * agyloop - Stage Value Object
 *
 * Self-validating, immutable value object representing a lifecycle stage.
 */

import {
  STAGES,
  StageName,
  ALLOWED_TRANSITIONS,
  STAGE_PLAN,
  STAGE_IMPLEMENT,
  MODE_YOLO
} from '../constants';
import { ValidationError } from '../errors';

export class Stage {
  public readonly value: StageName;

  constructor(rawStage: string) {
    if (!rawStage || typeof rawStage !== 'string') {
      throw new ValidationError('stage', rawStage, 'Stage cannot be empty and must be a string.');
    }

    const normalized = rawStage.toUpperCase().trim() as StageName;
    if (!(normalized in STAGES)) {
      const validStages = Object.keys(STAGES).join(', ');
      throw new ValidationError(
        'stage',
        rawStage,
        `Invalid stage '${rawStage}'. Valid stages are: ${validStages}.`
      );
    }

    this.value = normalized;
    Object.freeze(this);
  }

  public canTransitionTo(target: Stage, mode: string): boolean {
    const allowed = ALLOWED_TRANSITIONS[this.value] || [];

    // In non-yolo mode, jumping directly from PLAN to IMPLEMENT without APPROVAL is forbidden
    if (this.value === STAGE_PLAN && target.value === STAGE_IMPLEMENT && mode !== MODE_YOLO) {
      return false;
    }

    return (allowed as readonly string[]).includes(target.value);
  }

  public equals(other: Stage | null | undefined): boolean {
    if (!other) return false;
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }

  public static from(value: string): Stage {
    return new Stage(value);
  }
}
