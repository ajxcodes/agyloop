/**
 * agyloop - PlanDeviation value object (issue #432)
 *
 * The implementer's structured channel for "the approved plan literal is
 * wrong". Before this existed the correction lived only in the implementer's
 * chat response, which no downstream stage reads: a wrong plan literal, a
 * silently corrected one and one never implemented were indistinguishable to
 * the gate and the reviewer.
 *
 * Pure domain: no I/O, no clock in parsing. `recordedAt` is assigned by the
 * caller (the state machine), never invented here.
 */

import { ValidationError } from '../errors';
import { PLAN_DEVIATION_MARKER } from '../constants';
import { jsObjectLiteralToJson, sliceBalancedObject } from './json-block';

/** One changed plan literal, as the implementer emitted it. */
export interface PlanDeviationProps {
  /** The plan section/row the literal belongs to. */
  readonly planSection: string;
  /** The literal the approved plan specified. */
  readonly planLiteral: string;
  /** The assertion the implementation actually wrote. */
  readonly implementedAssertion: string;
  /** Why the new literal is right. */
  readonly reason: string;
  /** `file:line` cites for the written assertion. Optional. */
  readonly files: readonly string[];
}

/** A filed deviation, carrying its identity and acknowledgement state. */
export interface RecordedPlanDeviation extends PlanDeviationProps {
  readonly id: string;
  readonly recordedAt: string;
  readonly acknowledged: boolean;
  readonly acknowledgedAt: string | null;
  readonly acknowledgementReason: string | null;
}

/** The physical fields a deviation block must carry, in message order. */
const REQUIRED_FIELDS: readonly (keyof PlanDeviationProps)[] = [
  'planSection',
  'planLiteral',
  'implementedAssertion',
  'reason'
];

/** True when the line is prose/comment rather than a real block marker. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('<!--')
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(
      field,
      value,
      `Plan deviation block #${index + 1} is missing a non-empty "${field}" string`
    );
  }
  return value.trim();
}

/** Validates one decoded object (`{ … }`) into a `PlanDeviationProps`. */
export function planDeviationFromJSON(value: unknown, index = 0): PlanDeviationProps {
  if (!isPlainObject(value)) {
    throw new ValidationError(
      'planDeviation',
      value,
      `Plan deviation block #${index + 1} must be a JSON object`
    );
  }

  const planSection = readNonEmptyString(value.planSection, 'planSection', index);
  const planLiteral = readNonEmptyString(value.planLiteral, 'planLiteral', index);
  const implementedAssertion = readNonEmptyString(
    value.implementedAssertion,
    'implementedAssertion',
    index
  );
  const reason = readNonEmptyString(value.reason, 'reason', index);

  let files: readonly string[] = Object.freeze([]);
  if (value.files !== undefined && value.files !== null) {
    if (!Array.isArray(value.files)) {
      throw new ValidationError(
        'files',
        value.files,
        `Plan deviation block #${index + 1} "files" must be an array of "file:line" strings`
      );
    }
    const parsed: string[] = [];
    for (const entry of value.files) {
      if (typeof entry !== 'string' || entry.trim().length === 0 || !entry.includes('/')) {
        throw new ValidationError(
          'files',
          entry,
          `Plan deviation block #${index + 1} "files" entries must be "file:line" cites containing "/"`
        );
      }
      parsed.push(entry.trim());
    }
    files = Object.freeze(parsed);
  }

  return Object.freeze({ planSection, planLiteral, implementedAssertion, reason, files });
}

/**
 * Parses every balanced object after a `PLAN_DEVIATION:` marker on a
 * non-comment line. A malformed block refuses the whole input: a deviation
 * channel that silently drops a record is the defect it exists to close.
 */
export function parseBlocks(text: string): readonly PlanDeviationProps[] {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ValidationError(
      'planDeviation',
      text,
      `the deviation text is empty; expected at least one ${PLAN_DEVIATION_MARKER} block`
    );
  }

  const blocks: PlanDeviationProps[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const markerOffset = text.indexOf(PLAN_DEVIATION_MARKER, searchFrom);
    if (markerOffset === -1) break;
    const lineStart = text.lastIndexOf('\n', markerOffset - 1) + 1;
    const lineEnd = text.indexOf('\n', markerOffset);
    const markerLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (isCommentLine(markerLine)) {
      searchFrom = markerOffset + PLAN_DEVIATION_MARKER.length;
      continue;
    }

    const sliced = sliceBalancedObject(text, markerOffset + PLAN_DEVIATION_MARKER.length);
    if (sliced === null) {
      throw new ValidationError(
        'planDeviation',
        text.slice(markerOffset, markerOffset + 80),
        `the ${PLAN_DEVIATION_MARKER} block #${blocks.length + 1} has no balanced object`
      );
    }
    searchFrom = sliced.end;

    let decoded: unknown;
    try {
      decoded = JSON.parse(sliced.text);
    } catch {
      const normalised = jsObjectLiteralToJson(sliced.text);
      if (normalised === null) {
        throw new ValidationError(
          'planDeviation',
          sliced.text,
          `the ${PLAN_DEVIATION_MARKER} block #${blocks.length + 1} is not valid JSON`
        );
      }
      try {
        decoded = JSON.parse(normalised);
      } catch {
        throw new ValidationError(
          'planDeviation',
          sliced.text,
          `the ${PLAN_DEVIATION_MARKER} block #${blocks.length + 1} is not valid JSON`
        );
      }
    }

    blocks.push(planDeviationFromJSON(decoded, blocks.length));
  }

  if (blocks.length === 0) {
    throw new ValidationError(
      'planDeviation',
      text,
      `no ${PLAN_DEVIATION_MARKER} block was found; a deviation must be machine-readable`
    );
  }

  return Object.freeze(blocks);
}

/** Normalises one identity component so whitespace cannot inflate the record. */
function normaliseIdentityPart(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The dedupe identity: whitespace-normalized section|literal|assertion.
 *
 * A re-dispatched implementer that reports the same correction twice must not
 * inflate the checkpoint.
 */
export function planDeviationIdentity(props: PlanDeviationProps): string {
  return [
    normaliseIdentityPart(props.planSection),
    normaliseIdentityPart(props.planLiteral),
    normaliseIdentityPart(props.implementedAssertion)
  ].join('|');
}

/** True when the record still blocks a REVIEW certification (invariant D-2). */
export function isUnacknowledged(record: RecordedPlanDeviation): boolean {
  return record.acknowledged !== true;
}

/** True when the value carries every required field of a recorded deviation. */
export function isRecordedPlanDeviation(value: unknown): value is RecordedPlanDeviation {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== 'string' || value.id.trim().length === 0) return false;
  for (const field of REQUIRED_FIELDS) {
    if (typeof value[field] !== 'string' || (value[field] as string).trim().length === 0) {
      return false;
    }
  }
  if (value.files !== undefined && !Array.isArray(value.files)) return false;
  return typeof value.acknowledged === 'boolean';
}

/** Defensive hydration: a legacy or malformed snapshot loads as no deviations. */
export function hydrateRecordedPlanDeviations(value: unknown): RecordedPlanDeviation[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecordedPlanDeviation).map((record) =>
    Object.freeze({
      id: record.id,
      planSection: record.planSection,
      planLiteral: record.planLiteral,
      implementedAssertion: record.implementedAssertion,
      reason: record.reason,
      files: Object.freeze(Array.isArray(record.files) ? [...record.files] : []),
      recordedAt: record.recordedAt,
      acknowledged: record.acknowledged === true,
      acknowledgedAt: record.acknowledgedAt ?? null,
      acknowledgementReason: record.acknowledgementReason ?? null
    })
  );
}
