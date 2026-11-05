/**
 * codeloop - PlanDeviation value object (issue #432)
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
import { isCommentLine as isCommentLineBase, isPlainObject } from './markdown';
import { MSG_PLAN_DEVIATION_SHAPE } from '../messages';
import { PLAN_DEVIATION_MARKER, PLAN_DEVIATION_PROSE_LABEL_ALIASES, PLAN_DEVIATION_PROSE_LABEL_ENTRIES, PLAN_DEVIATION_REQUIRED_KEYS } from '../plan-contract';
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
const REQUIRED_FIELDS: readonly (keyof PlanDeviationProps)[] = PLAN_DEVIATION_REQUIRED_KEYS;

/** The prose labels the parser also accepts, mapped onto the wire keys. */
type ProseField = 'planSection' | 'planLiteral' | 'implementedAssertion' | 'reason' | 'files';

/**
 * The regexes are derived from the same label table the refusal message
 * renders, so an advertised spelling and a matched spelling cannot drift.
 */
const PROSE_LABELS: ReadonlyArray<{ readonly pattern: RegExp; readonly field: ProseField }> = [
  ...PLAN_DEVIATION_PROSE_LABEL_ENTRIES,
  ...PLAN_DEVIATION_PROSE_LABEL_ALIASES
].map((entry) => ({
  pattern: new RegExp(`^${entry.label.replace(/\s+/g, '\\s+')}\\s*:`, 'i'),
  field: entry.field
}));


function readNonEmptyString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(
      field,
      value,
      `Plan deviation block #${index + 1} is missing a non-empty "${field}" string. ${MSG_PLAN_DEVIATION_SHAPE}`
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
      `Plan deviation block #${index + 1} must be a JSON object. ${MSG_PLAN_DEVIATION_SHAPE}`
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

/** Absolute offset of the first prose label line in [from, to), or null. */
function firstProseLabelOffset(text: string, from: number, to: number): number | null {
  let cursor = from;
  while (cursor < to) {
    const newline = text.indexOf('\n', cursor);
    const lineEnd = newline === -1 || newline > to ? to : newline;
    const line = text.slice(cursor, lineEnd).trim();
    if (PROSE_LABELS.some((entry) => entry.pattern.test(line))) return cursor;
    cursor = lineEnd + 1;
  }
  return null;
}

/** True when [from, to) carries block content: an object brace or a prose label. */
function hasBlockContent(text: string, from: number, to: number): boolean {
  return text.slice(from, to).includes('{') || firstProseLabelOffset(text, from, to) !== null;
}

/** Decodes the four prose labels; null when the block carries none. */
function parseProseBlock(
  text: string,
  from: number,
  to: number,
  index: number
): PlanDeviationProps | null {
  const collected: Record<string, string> = {};
  let current: string | null = null;
  let seen = false;
  for (const line of text.slice(from, to).split('\n')) {
    const trimmed = line.trim();
    const label = PROSE_LABELS.find((entry) => entry.pattern.test(trimmed));
    if (label) {
      seen = true;
      current = label.field;
      collected[current] = trimmed.replace(label.pattern, '').trim();
      continue;
    }
    if (trimmed.length === 0) {
      current = null;
      continue;
    }
    if (current !== null) {
      collected[current] = `${collected[current]} ${trimmed}`.trim();
    }
  }
  if (!seen) return null;

  const value: Record<string, unknown> = {};
  for (const key of REQUIRED_FIELDS) {
    if (collected[key] !== undefined) value[key] = collected[key];
  }
  if (collected.files !== undefined) {
    value.files = collected.files
      .split(/[\s,]+/)
      .map((entry) => entry.replace(/^`|`$/g, '').trim())
      .filter((entry) => entry.length > 0);
  }
  return planDeviationFromJSON(value, index);
}

/**
 * Parses every `PLAN_DEVIATION:` block after a non-comment marker. A block is
 * either the four prose labels the #445/#518 implementers actually wrote or a
 * balanced JSON / JS-object-literal object. A malformed block refuses the whole
 * input with the accepted shape: a deviation channel that silently drops a
 * record is the defect it exists to close.
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
    if (isCommentLineBase(markerLine, ['#', '//', '<!--'])) {
      searchFrom = markerOffset + PLAN_DEVIATION_MARKER.length;
      continue;
    }

    const markerEnd = markerOffset + PLAN_DEVIATION_MARKER.length;
    const nextMarker = text.indexOf(PLAN_DEVIATION_MARKER, markerEnd);
    const blockEnd = nextMarker === -1 ? text.length : nextMarker;
    const labelOffset = firstProseLabelOffset(text, markerEnd, blockEnd);
    const braceOffset = text.indexOf('{', markerEnd);
    const braceInBlock = braceOffset !== -1 && braceOffset < blockEnd ? braceOffset : -1;
    const preferProse = labelOffset !== null && (braceInBlock === -1 || labelOffset < braceInBlock);

    if (preferProse) {
      const prose = parseProseBlock(text, markerEnd, blockEnd, blocks.length);
      if (prose === null) {
        throw new ValidationError(
          'planDeviation',
          text.slice(markerOffset, markerOffset + 80),
          `the ${PLAN_DEVIATION_MARKER} block #${blocks.length + 1} is not a recognised shape. ${MSG_PLAN_DEVIATION_SHAPE}`
        );
      }
      blocks.push(prose);
      searchFrom = nextMarker === -1 ? text.length : nextMarker;
      continue;
    }

    const sliced = sliceBalancedObject(text, markerEnd);
    const usable = sliced !== null && sliced.start < blockEnd ? sliced : null;
    if (usable === null) {
      const prose = parseProseBlock(text, markerEnd, blockEnd, blocks.length);
      if (prose !== null) {
        blocks.push(prose);
        searchFrom = nextMarker === -1 ? text.length : nextMarker;
        continue;
      }
      // A narrative line can name the marker inline ("… I emit one
      // PLAN_DEVIATION: block per changed literal:") before the real block.
      // Such an occurrence owns no block content, so treat it as noise and let
      // the following marker parse. A marker whose own boundary holds
      // undecodable content still refuses the whole input.
      if (nextMarker !== -1 && !hasBlockContent(text, markerEnd, blockEnd)) {
        searchFrom = blockEnd;
        continue;
      }
      throw new ValidationError(
        'planDeviation',
        text.slice(markerOffset, markerOffset + 80),
        `the ${PLAN_DEVIATION_MARKER} block #${blocks.length + 1} is not a recognised shape. ${MSG_PLAN_DEVIATION_SHAPE}`
      );
    }
    searchFrom = usable.end;

    let decoded: unknown;
    try {
      decoded = JSON.parse(usable.text);
    } catch {
      const normalised = jsObjectLiteralToJson(usable.text);
      let decodedFromNormalised: unknown;
      if (normalised !== null) {
        try {
          decodedFromNormalised = JSON.parse(normalised);
        } catch {
          decodedFromNormalised = undefined;
        }
      }
      if (decodedFromNormalised === undefined) {
        throw new ValidationError(
          'planDeviation',
          usable.text,
          `the ${PLAN_DEVIATION_MARKER} block #${blocks.length + 1} is not a recognised shape. ${MSG_PLAN_DEVIATION_SHAPE}`
        );
      }
      decoded = decodedFromNormalised;
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
