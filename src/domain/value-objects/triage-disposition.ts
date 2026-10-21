/**
 * agyloop - TriageDisposition Value Object
 *
 * The record of a triage disposition: "the feedback on PR #7 was triaged at
 * <instant> and routed to <action>".
 *
 * WHY THIS EXISTS (issue #269, Defect 1)
 *
 * `codeloop next` routed a COMPLETED checkpoint back into the TRIAGE gate
 * whenever the task's pull request was OPEN and carried ANY comment. The
 * triage subagent routed it back to COMPLETED — the sanctioned disposition for
 * "nothing actionable here" — and the NEXT `codeloop next` routed it to TRIAGE
 * again. The checkpoint had no vocabulary for "this feedback was handled", so
 * the loop was deterministic and infinite until the PR was merged or closed.
 *
 * The disposition is the load-bearing part of the fix. Suppressing the route
 * WITHOUT recording it would hide genuine review feedback; recording it turns
 * a livelock into a ONE-SHOT gate.
 *
 * The dispositioned feedback is identified by a KEY SET, not by a timestamp:
 *
 * - `id:<n>` when the comment carries a numeric REST id;
 * - `body:<normalized body>` otherwise.
 *
 * A key set is sound where a timestamp is not: a triage that ran offline saw
 * nothing, and a timestamp would then claim that unseen feedback had been
 * dispositioned.
 *
 * Pure domain value object: 100% free of filesystem, child processes, or
 * network I/O.
 */

import {
  MAX_TRIAGE_DISPOSITION_FEEDBACK_KEYS,
  TRIAGE_DISPOSITION_ACTIONS,
  TRIAGE_DISPOSITION_LINE_TEMPLATES,
  LABEL_TRIAGE_DISPOSITION,
  TriageDispositionAction,
  TriageDispositionSurface
} from '../constants';
import { ValidationError } from '../errors';

export interface TriageDispositionProps {
  /** The pull request the disposition applies to. */
  readonly prNumber: number;
  /** The triage action that was taken. */
  readonly action: TriageDispositionAction;
  /** ISO-8601 instant the disposition was recorded. */
  readonly recordedAt: string;
  /** The keys of the actionable feedback items that were dispositioned. */
  readonly feedbackKeys: readonly string[];
}

export interface TriageDispositionSerialized {
  readonly prNumber: number;
  readonly action: TriageDispositionAction;
  readonly recordedAt: string;
  readonly feedbackKeys: readonly string[];
}

/**
 * The facts a disposition line renders.
 *
 * Both the `TriageDisposition` value object and its serialized form satisfy
 * it, so the ONE renderer serves every surface without converting between
 * representations.
 */
export interface TriageDispositionFacts {
  readonly prNumber: number;
  readonly action: TriageDispositionAction;
  readonly recordedAt: string;
  readonly feedbackKeys: readonly string[];
}

/**
 * Renders the operator-facing disposition line (issue #269, R5).
 *
 * ONE renderer, THREE surfaces. The CLI's triage output, the idle report and
 * the checkpoint history note used to hand-render the same four facts in
 * three different places, so the wording could drift and the operator could
 * be shown two different stories about the same disposition. Every surface
 * now renders through this function, and the frames themselves live in
 * `TRIAGE_DISPOSITION_LINE_TEMPLATES` (domain constants — no magic strings).
 *
 * The rendered wording is UNCHANGED: this is a de-duplication, not a
 * re-wording.
 */
export function formatTriageDispositionLine(
  disposition: TriageDispositionFacts,
  surface: TriageDispositionSurface
): string {
  const template = TRIAGE_DISPOSITION_LINE_TEMPLATES[surface];
  const values: Record<string, string> = {
    action: disposition.action,
    actionUpper: disposition.action.toUpperCase(),
    prNumber: String(disposition.prNumber),
    count: String(disposition.feedbackKeys.length),
    recordedAt: disposition.recordedAt,
    label: LABEL_TRIAGE_DISPOSITION
  };

  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '');
}

/**
 * De-duplicates the keys, preserving insertion order, and caps the set at
 * `MAX_TRIAGE_DISPOSITION_FEEDBACK_KEYS` (oldest dropped first).
 */
function normalizeFeedbackKeys(keys: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const key of keys) {
    if (typeof key !== 'string') {
      continue;
    }
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }

  if (unique.length <= MAX_TRIAGE_DISPOSITION_FEEDBACK_KEYS) {
    return Object.freeze(unique);
  }

  return Object.freeze(unique.slice(unique.length - MAX_TRIAGE_DISPOSITION_FEEDBACK_KEYS));
}

function isTriageDispositionAction(value: unknown): value is TriageDispositionAction {
  return (
    typeof value === 'string' &&
    (TRIAGE_DISPOSITION_ACTIONS as readonly string[]).includes(value)
  );
}

export class TriageDisposition {
  public readonly prNumber: number;
  public readonly action: TriageDispositionAction;
  public readonly recordedAt: string;
  public readonly feedbackKeys: readonly string[];

  constructor(props: TriageDispositionProps) {
    if (!props || typeof props !== 'object') {
      throw new ValidationError('props', props, 'TriageDisposition props must be an object.');
    }

    if (
      typeof props.prNumber !== 'number' ||
      !Number.isInteger(props.prNumber) ||
      props.prNumber <= 0
    ) {
      throw new ValidationError(
        'prNumber',
        props.prNumber,
        'Triage disposition PR number must be a positive integer.'
      );
    }

    if (!isTriageDispositionAction(props.action)) {
      throw new ValidationError(
        'action',
        props.action,
        `Invalid triage disposition action '${String(props.action)}'. Must be one of: ${TRIAGE_DISPOSITION_ACTIONS.join(', ')}.`
      );
    }

    if (typeof props.recordedAt !== 'string' || props.recordedAt.trim().length === 0) {
      throw new ValidationError(
        'recordedAt',
        props.recordedAt,
        'Triage disposition timestamp must be a non-empty ISO-8601 string.'
      );
    }

    if (Number.isNaN(Date.parse(props.recordedAt))) {
      throw new ValidationError(
        'recordedAt',
        props.recordedAt,
        'Triage disposition timestamp must be a parseable date.'
      );
    }

    const rawKeys = Array.isArray(props.feedbackKeys) ? props.feedbackKeys : [];
    for (const key of rawKeys) {
      if (typeof key !== 'string' || key.trim().length === 0) {
        throw new ValidationError(
          'feedbackKeys',
          key,
          'Triage disposition feedback keys must be non-empty strings.'
        );
      }
    }

    this.prNumber = props.prNumber;
    this.action = props.action;
    this.recordedAt = props.recordedAt.trim();
    this.feedbackKeys = normalizeFeedbackKeys(rawKeys);

    Object.freeze(this);
  }

  /**
   * Whether this disposition already covers the given feedback key.
   */
  public covers(key: string): boolean {
    if (typeof key !== 'string') {
      return false;
    }
    return this.feedbackKeys.includes(key);
  }

  /**
   * Whether EVERY key is covered.
   *
   * An EMPTY key list is NOT covered: "nothing was dispositioned" must never
   * be read as "everything was dispositioned".
   */
  public coversAll(keys: readonly string[]): boolean {
    if (!Array.isArray(keys) || keys.length === 0) {
      return false;
    }
    return keys.every((key) => this.covers(key));
  }

  public toJSON(): TriageDispositionSerialized {
    return {
      prNumber: this.prNumber,
      action: this.action,
      recordedAt: this.recordedAt,
      feedbackKeys: this.feedbackKeys
    };
  }

  /**
   * Rebuilds a disposition from a snapshot field.
   *
   * NEVER throws: a legacy checkpoint (no `triageDisposition` key) and a
   * hand-edited one (a malformed field) both load as `null`, so a corrupt
   * checkpoint can never take the pipeline down.
   */
  public static fromJSON(json: unknown): TriageDisposition | null {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return null;
    }

    const candidate = json as Partial<TriageDispositionSerialized>;

    try {
      if (!Array.isArray(candidate.feedbackKeys)) {
        return null;
      }
      return new TriageDisposition({
        prNumber: candidate.prNumber as number,
        action: candidate.action as TriageDispositionAction,
        recordedAt: candidate.recordedAt as string,
        feedbackKeys: candidate.feedbackKeys
      });
    } catch {
      return null;
    }
  }

  /**
   * Merges a NEW disposition into the recorded one.
   *
   * - No existing disposition → the new one.
   * - A DIFFERENT PR → REPLACE: a different pull request is a different
   *   subject, and the old subject's keys must not mask the new one's.
   * - The SAME PR → the UNION of the key sets (insertion-ordered, capped), with
   *   the new action and timestamp winning: the latest triage wins.
   */
  public static merge(
    existing: TriageDisposition | null,
    next: {
      readonly prNumber: number;
      readonly action: TriageDispositionAction;
      readonly recordedAt: string;
      readonly feedbackKeys: readonly string[];
    }
  ): TriageDisposition {
    if (!existing || existing.prNumber !== next.prNumber) {
      return new TriageDisposition(next);
    }

    return new TriageDisposition({
      prNumber: next.prNumber,
      action: next.action,
      recordedAt: next.recordedAt,
      feedbackKeys: [...existing.feedbackKeys, ...next.feedbackKeys]
    });
  }
}
