/**
 * agyloop - The ONE smoke-heading predicate (issue #364, absorbing #365)
 *
 * The heading that opens a plan's `Manual Smoke Test Protocol` used to be
 * recognised by two private helpers with DIFFERENT contracts:
 *
 *   - `smoke-protocol.ts` took a `Heading` and refused `level <= 1` (the #362
 *     Finding 1 fix: an H1 is the document TITLE by construction, never a
 *     section);
 *   - `quality-gate-targets.ts` took a `title: string` and matched at ANY level.
 *
 * No behaviour diverged only because the targets loop already ends a section at
 * `heading.level <= sectionLevel`, so the level-1 case could not leak through.
 * The risk was a future edit to either helper silently diverging — the #362
 * level fix landed in one copy only. Both now import from here, and the
 * difference between the two contracts is documented and tested.
 *
 * No I/O, no external imports.
 */

import { HEADING_MANUAL_SMOKE_TEST_PROTOCOL } from '../constants';

const SMOKE_TITLE_PHRASE = HEADING_MANUAL_SMOKE_TEST_PROTOCOL.toLowerCase();

/**
 * LEVEL-AGNOSTIC: is this heading title the smoke section?
 *
 * Deliberately ignores the heading level, because the consumer
 * (`quality-gate-targets.ts`) supplies its own level rule — a section ends at
 * the first heading whose level is less than or equal to the opening heading's.
 * Matching every level here is therefore correct for that caller. `.includes()`
 * is kept so an annotated heading (`Manual Smoke Test Protocol — checks`) still
 * matches; losing it would turn a loud finding into a silent "no protocol
 * declared" skip.
 *
 * @param title - The heading title (already normalised by the consumer).
 */
export function isManualSmokeTestProtocolTitle(title: string): boolean {
  return String(title ?? '')
    .toLowerCase()
    .includes(SMOKE_TITLE_PHRASE);
}

/**
 * SECTION SEMANTICS: is this heading the smoke section?
 *
 * A level-1 heading is the document TITLE (`templates/implementation-plan.md`),
 * never a section. Matching it made a plan whose title carries the phrase scope
 * the section at line 1 with `sectionLevel = 1`; nothing could close the section
 * after that, so every later fence — reproduction blocks, ASCII-art diagrams,
 * the Quality Gate Targets list — was frozen as a smoke check. On the #359 plan
 * that turned 3 declared checks into 7 and `toScript()` died at
 * `$: command not found` (exit 127). The title is the only heading that can
 * never be a section, so skipping level 1 is principled, not a special case.
 *
 * @param heading - The detected heading.
 */
export function isSmokeSectionHeading(heading: {
  readonly level: number;
  readonly title: string;
}): boolean {
  return heading.level > 1 && isManualSmokeTestProtocolTitle(heading.title);
}
