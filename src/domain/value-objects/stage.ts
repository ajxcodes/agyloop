/**
 * agyloop - Stage Value Object
 *
 * Self-validating, immutable value object representing a lifecycle stage.
 */

import {
  STAGES,
  StageName,
  ALLOWED_TRANSITIONS,
  LIFECYCLE_STAGE_ORDER,
  STAGE_PLAN,
  STAGE_IMPLEMENT,
  MODE_STANDARD,
  MODE_YOLO,
  formatTransitionCommand
} from '../constants';
import { ValidationError } from '../errors';

/**
 * The ONE legality predicate (issue #327).
 *
 * `Stage.canTransitionTo` delegates here, so the PLAN -> IMPLEMENT YOLO rule
 * cannot drift between the value object and the recovery-path search.
 */
export function isLegalTransition(from: string, to: string, mode: string): boolean {
  const allowed = (ALLOWED_TRANSITIONS as Readonly<Record<string, readonly string[]>>)[from] || [];

  // In non-yolo mode, jumping directly from PLAN to IMPLEMENT without APPROVAL is forbidden
  if (from === STAGE_PLAN && to === STAGE_IMPLEMENT && mode !== MODE_YOLO) {
    return false;
  }

  return allowed.includes(to);
}

/**
 * The shortest LEGAL walk from one stage to another (issue #327).
 *
 * Returns the stages AFTER `from`, ending at `to`; `[]` when `from === to` and
 * `null` when no path exists. Equally short paths are ordered by
 * `LIFECYCLE_STAGE_ORDER` ascending, so a recovery prefers walking BACK to an
 * earlier stage (`REVIEW -> IMPLEMENT -> QUALITY_GATE`) over a forward detour
 * through an unverified stage (`REVIEW -> COMMIT -> QUALITY_GATE`).
 */
export function findLegalTransitionPath(
  from: string,
  to: string,
  mode: string = MODE_STANDARD
): StageName[] | null {
  if (from === to) {
    return [];
  }
  if (!(from in ALLOWED_TRANSITIONS)) {
    return null;
  }

  const rank = (stage: string): number => {
    const index = LIFECYCLE_STAGE_ORDER.indexOf(stage as StageName);
    return index === -1 ? LIFECYCLE_STAGE_ORDER.length : index;
  };

  const visited = new Set<string>([from]);
  const queue: StageName[][] = [[]];

  while (queue.length > 0) {
    const path = queue.shift() as StageName[];
    const current = path.length === 0 ? from : path[path.length - 1];
    const targets = [...(ALLOWED_TRANSITIONS[current as StageName] || [])].sort(
      (left, right) => rank(left) - rank(right)
    );

    for (const target of targets) {
      if (target === from || visited.has(target)) continue;
      if (!isLegalTransition(current, target, mode)) continue;

      const next = [...path, target];
      if (target === to) {
        return next;
      }
      visited.add(target);
      queue.push(next);
    }
  }

  return null;
}

/**
 * Renders the legal recovery walk as paste-ready commands (issue #327).
 *
 * `null` when no path exists (no checkpoint), `''` when already at the target.
 */
export function formatTransitionRecoveryCommands(
  from: string | null | undefined,
  to: string,
  issue?: number | string | null,
  mode: string = MODE_STANDARD
): string | null {
  if (from === null || from === undefined) {
    return null;
  }

  const path = findLegalTransitionPath(from, to, mode);
  if (path === null) {
    return null;
  }

  return path.map((stage) => formatTransitionCommand(stage, issue)).join(', then ');
}

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
    return isLegalTransition(this.value, target.value, mode);
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
