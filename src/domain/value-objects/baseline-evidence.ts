/**
 * agyloop - BaselineEvidence Value Object (issue #388)
 *
 * A plan may declare baseline numbers its later tests and smoke checks compare
 * against. Until #388 nothing compared those numbers with measurement: the
 * declared value travelled through APPROVAL as normative and the first actor
 * asked to satisfy it was the implementer. On the #382 run `DA-METRICS-1`
 * declared `{ additions: 3, deletions: 0 }` while the fixture measured four
 * additions, so an implementer following the plan would have changed a correct
 * metric to a wrong one.
 *
 * This value object is the PURE parser behind the application guard:
 *
 *   - `claimedReproduction` is armed only from the DOCUMENT HEADER (the lines
 *     before the first level-2 heading), so a problem statement in §1 cannot
 *     silently arm the rule.
 *   - `### Baseline Evidence` carries one `#### <claim-id>` per declared number,
 *     each with `- **Declared:**`, `- **Command:**` and `- **Output:**`. The
 *     template's own untouched `<claim-id>` stub, with no label filled in,
 *     declares no number and is therefore not a claim (issue #392).
 *   - Fenced blocks (``` / ~~~) are DATA: a plan fixture embedded in a smoke
 *     block is never parsed as evidence.
 *   - A declared number appearing in the body without an evidence carrier is a
 *     finding, and a body line that names a claim id but restates a different
 *     value is a finding without executing anything.
 *
 * `baselineValuesMatch` is the ONE comparator the application guard and the
 * tests share.
 *
 * `Declared:`/`Output:` contract (issue #402, D1). The relationship between the
 * two authored value fields is defined HERE and stated verbatim by
 * `BASELINE_DECLARED_SHAPE_SENTENCE`; the guard maps the pure verdict this
 * module returns to a refusal message:
 *
 * | `Declared` vs measured | `Output` vs measured | `isProseDeclaration(Declared)` | Verdict |
 * |---|---|---|---|
 * | matches | matches | either | accept (`measured`) |
 * | matches | does not match | either | refuse (`output-mismatch`) |
 * | does not match | matches | true | accept (`prose-output-verified`) |
 * | does not match | matches | false | refuse (`declared-mismatch`) |
 * | does not match | does not match | either | refuse (`declared-mismatch`) |
 *
 * A prose `Declared` is never normative: the verified `Output` is. A
 * value-shaped `Declared` (`{…}`, `[…]`, JSON, a number, or any text carrying a
 * digit) is still compared with the measurement, so the #382/#388 guarantee
 * survives.
 *
 * No I/O, no external imports.
 */

import {
  BASELINE_RULE_BODY_MISMATCH,
  BASELINE_RULE_MISSING_COMMAND,
  BASELINE_RULE_MISSING_EVIDENCE,
  BASELINE_RULE_MISSING_OUTPUT,
  BASELINE_RULE_MISSING_VALUE,
  HEADING_BASELINE_EVIDENCE
} from '../constants';

export interface BaselineClaim {
  readonly id: string;
  readonly declared: string;
  readonly command: string;
  readonly output: string;
  /** 1-based plan line of the claim heading. */
  readonly line: number;
}

export interface BaselineFinding {
  readonly rule: string;
  /** The claim id the finding belongs to, or `null` for a document-level finding. */
  readonly claim: string | null;
  /** 1-based plan line of the offending text. */
  readonly line: number;
  readonly excerpt: string;
  /** For a body mismatch: the value carried by the evidence section. */
  readonly declared?: string;
  /** For a body mismatch: the value(s) restated in the plan body. */
  readonly restated?: string;
}

export interface BaselineEvidenceResult {
  /** True when the document HEADER claims its baselines were reproduced. */
  readonly claimedReproduction: boolean;
  readonly found: boolean;
  readonly headingLine: number;
  readonly claims: readonly BaselineClaim[];
  readonly findings: readonly BaselineFinding[];
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const LEVEL_TWO_HEADING = /^##(?!#)/;
const HEADING_NUMBER_PREFIX = /^\d+[.)]\s*/;
const FENCE_TOKEN = /^\s*(`{3,}|~{3,})/;
const MAX_EXCERPT_LENGTH = 160;
/** A body line carries at most this many candidate value spans. */
const MAX_VALUE_SPANS = 8;

/** The narrow reproduction-claim family (issue #388 §2.1). */
const REPRODUCTION_CLAIM = /baseline values? (?:was|were) reproduced/i;
/** The `through dist/` spelling that also arms the header claim. */
const DIST_ANCHOR = /\bthrough\s+`?dist\//i;
const BASELINE_WORD = /\bbaseline\b/i;
const DIGIT = /\d/;
/**
 * A candidate declared value on a body line. Matches one `{…}` or `[…]` span
 * at a time (never greedily across two spans), so a row quoting both the
 * declared and the measured value is compared span by span. This is what lets
 * `declared { additions: 3 }, measured { additions: 4 }` agree with a claim of
 * `{ additions: 3 }` instead of collapsing into one unparseable value.
 */
const VALUE_SPAN = /\{[^{}]*\}|\[[^[\]]*\]/g;

/** `- **Declared:** value`, `- **Command:** value`, `- **Output:** value`. */
const LABEL_PATTERN = /^\s*[-*]\s*\*\*(Declared|Command|Output):?\s*\*\*\s*:?\s*(.*)$/i;

/**
 * The literal placeholder id seeded by `templates/implementation-plan.md`
 * (issue #392). An untouched stub declares no number.
 */
const SCAFFOLD_STUB_CLAIM_ID = '<claim-id>';

interface Heading {
  readonly level: number;
  readonly title: string;
}

function detectHeading(line: string): Heading | null {
  const match = HEADING_PATTERN.exec(line.trim());
  if (!match) return null;
  return { level: match[1].length, title: match[2].replace(/#+\s*$/, '').trim() };
}

function normaliseHeadingTitle(title: string): string {
  return title.replace(HEADING_NUMBER_PREFIX, '').replace(/:\s*$/, '').trim();
}

function isBaselineSectionHeading(heading: Heading): boolean {
  // A level-1 heading is the document TITLE by construction, never a section
  // (mirrors `isSmokeSectionHeading`).
  return (
    heading.level > 1 &&
    normaliseHeadingTitle(heading.title).toLowerCase() === HEADING_BASELINE_EVIDENCE.toLowerCase()
  );
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_EXCERPT_LENGTH
    ? `${trimmed.slice(0, MAX_EXCERPT_LENGTH)}…`
    : trimmed;
}

/** Unwraps a single inline code span; anything else is returned trimmed. */
function unwrapValue(raw: string): string {
  const trimmed = raw.trim();
  const span = /^`([^`]*)`$/.exec(trimmed);
  return span ? span[1].trim() : trimmed;
}

/** Strips backticks and collapses whitespace for a value comparison. */
function collapseValue(value: string): string {
  return String(value ?? '')
    .replace(/`/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Recursively sorts object keys so JSON key order is not a mismatch. */
function canonicaliseJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicaliseJson);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicaliseJson(record[key]);
    }
    return sorted;
  }
  return value;
}

function tryParseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * The ONE declared-vs-measured comparator shared by the guard and the tests.
 *
 * Backticks/whitespace are stripped first; when BOTH sides parse as JSON the
 * canonicalised values are compared (key order is not a mismatch); otherwise
 * the collapsed text is compared, then numeric equality.
 */
export function baselineValuesMatch(declared: string, measured: string): boolean {
  const left = collapseValue(declared);
  const right = collapseValue(measured);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;

  const leftJson = tryParseJson(left);
  const rightJson = tryParseJson(right);
  if (leftJson.ok && rightJson.ok) {
    return (
      JSON.stringify(canonicaliseJson(leftJson.value)) ===
      JSON.stringify(canonicaliseJson(rightJson.value))
    );
  }

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return (
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber) &&
    leftNumber === rightNumber
  );
}

/**
 * The ONE output comparator shared by the guard and the tests (issue #402).
 *
 * True when the authored value matches the WHOLE stdout or one of its non-empty
 * trimmed lines; every comparison goes through `baselineValuesMatch`.
 */
export function baselineOutputMatches(value: string, stdout: string): boolean {
  if (baselineValuesMatch(value, stdout)) return true;
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .some((line) => baselineValuesMatch(value, line));
}

/** The verdict reasons of the `Declared`/`Output` matrix (issue #402, D1). */
export const BASELINE_VERDICT_MEASURED = 'measured';
export const BASELINE_VERDICT_PROSE_OUTPUT_VERIFIED = 'prose-output-verified';
export const BASELINE_VERDICT_DECLARED_MISMATCH = 'declared-mismatch';
export const BASELINE_VERDICT_OUTPUT_MISMATCH = 'output-mismatch';

export type BaselineVerdictReason =
  | typeof BASELINE_VERDICT_MEASURED
  | typeof BASELINE_VERDICT_PROSE_OUTPUT_VERIFIED
  | typeof BASELINE_VERDICT_DECLARED_MISMATCH
  | typeof BASELINE_VERDICT_OUTPUT_MISMATCH;

export interface BaselineClaimVerdict {
  readonly reason: BaselineVerdictReason;
  readonly accepted: boolean;
  readonly declaredMatchesMeasured: boolean;
  readonly outputMatchesMeasured: boolean;
  /** `result.stdout.trim()`. */
  readonly measured: string;
}

/** A `{…}`/`[…]` span, one at a time (never greedy across two spans). */
const VALUE_SPAN_TEST = /\{[^{}]*\}|\[[^[\]]*\]/;

/**
 * True only when `Declared` reads as a human sentence rather than a value.
 *
 * Deliberately narrow: no JSON, no number, no `{…}`/`[…]` span, and no digit at
 * all, and at least two whitespace-separated tokens. Anything value-shaped is
 * still machine-compared against the measurement.
 */
export function isProseDeclaration(declared: string): boolean {
  const collapsed = collapseValue(declared);
  if (collapsed.length === 0) return false;
  if (collapsed.split(/\s+/).filter((token) => token.length > 0).length < 2) return false;
  if (VALUE_SPAN_TEST.test(collapsed)) return false;
  if (tryParseJson(collapsed).ok) return false;
  if (Number.isFinite(Number(collapsed))) return false;
  if (/\d/.test(collapsed)) return false;
  return true;
}

/**
 * The ONE pure verdict of the `Declared`/`Output` contract (issue #402, D1).
 *
 * The measured stdout is the only normative value; `Declared` is compared with
 * it, `Output` is the attested measurement, and both must agree with the fresh
 * execution unless `Declared` is prose and `Output` verifies.
 */
export function evaluateBaselineClaim(
  claim: { readonly declared: string; readonly output: string },
  measured: string
): BaselineClaimVerdict {
  const trimmedMeasured = String(measured ?? '').trim();
  const declaredMatchesMeasured = baselineOutputMatches(claim.declared, measured);
  const outputMatchesMeasured = baselineOutputMatches(claim.output, measured);

  const verdict = (
    reason: BaselineVerdictReason,
    accepted: boolean
  ): BaselineClaimVerdict => ({
    reason,
    accepted,
    declaredMatchesMeasured,
    outputMatchesMeasured,
    measured: trimmedMeasured
  });

  if (declaredMatchesMeasured) {
    return outputMatchesMeasured
      ? verdict(BASELINE_VERDICT_MEASURED, true)
      : verdict(BASELINE_VERDICT_OUTPUT_MISMATCH, false);
  }

  if (outputMatchesMeasured && isProseDeclaration(claim.declared)) {
    return verdict(BASELINE_VERDICT_PROSE_OUTPUT_VERIFIED, true);
  }

  return verdict(BASELINE_VERDICT_DECLARED_MISMATCH, false);
}

interface ParsedRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * Marks every line that is a fence delimiter or lies inside a fenced block.
 *
 * A plan may embed a whole plan fixture inside a `cat > … <<'PLAN'` sample in
 * its smoke protocol (the #388 plan does exactly that). Those sample headings
 * are DATA, not evidence: without this mask the sample's `### Baseline
 * Evidence` became the parsed section and its sample values produced phantom
 * `baseline-body-mismatch` findings, refusing a genuinely true plan.
 */
function computeFenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = new Array<boolean>(lines.length).fill(false);
  let open: { readonly char: string; readonly length: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const match = FENCE_TOKEN.exec(lines[index]);
    if (!match) {
      mask[index] = open !== null;
      continue;
    }

    const marker = match[1];
    if (open === null) {
      open = { char: marker[0], length: marker.length };
      mask[index] = true;
      continue;
    }
    if (marker[0] === open.char && marker.length >= open.length) {
      open = null;
    }
    mask[index] = true;
  }
  return mask;
}

/**
 * Every `{…}`/`[…]` candidate on a body line, one span at a time. A greedy
 * match across two values would compare a joined string that can never equal
 * a declared value; a per-span comparison lets a row that documents both the
 * declared and the measured value agree with either one.
 */
function extractValueSpans(line: string): string[] {
  const spans: string[] = [];
  VALUE_SPAN.lastIndex = 0;
  let match = VALUE_SPAN.exec(line);
  while (match !== null && spans.length < MAX_VALUE_SPANS) {
    spans.push(match[0]);
    match = VALUE_SPAN.exec(line);
  }
  return spans;
}

/** Finds the `### Baseline Evidence` section, if any. */
function findSection(lines: readonly string[], fenceMask: readonly boolean[]): ParsedRegion | null {
  const candidates: Array<{ readonly index: number; readonly level: number }> = [];

  for (let index = 0; index < lines.length; index++) {
    if (fenceMask[index]) continue;
    const heading = detectHeading(lines[index]);
    if (!heading || !isBaselineSectionHeading(heading)) continue;
    candidates.push({ index, level: heading.level });
  }
  if (candidates.length === 0) return null;

  // Prefer the DEEPEST matching heading. A document outline may carry a
  // numbered chapter heading (`## 4. Baseline Evidence`) above the real
  // `### Baseline Evidence` section; the innermost exact heading is the
  // evidence carrier, and the outer one is outline prose.
  const chosen = candidates.reduce((best, candidate) =>
    candidate.level > best.level ? candidate : best
  );

  for (let cursor = chosen.index + 1; cursor < lines.length; cursor++) {
    if (fenceMask[cursor]) continue;
    const inner = detectHeading(lines[cursor]);
    if (inner && inner.level <= chosen.level) {
      return { start: chosen.index, end: cursor };
    }
  }
  return { start: chosen.index, end: lines.length };
}

/** The claim regions inside the evidence section, in document order. */
function claimRegions(
  lines: readonly string[],
  section: ParsedRegion,
  fenceMask: readonly boolean[]
): ParsedRegion[] {
  const regionLines: ParsedRegion[] = [];
  for (let index = section.start + 1; index < section.end; index++) {
    if (fenceMask[index]) continue;
    const heading = detectHeading(lines[index]);
    if (heading) {
      regionLines.push({ start: index, end: section.end });
    }
  }

  // Each claim ends at the next claim heading.
  return regionLines.map((region, position) => ({
    start: region.start,
    end: position + 1 < regionLines.length ? regionLines[position + 1].start : section.end
  }));
}

/**
 * Reads a label's value: inline rest-of-line, or the next fenced block when the
 * label carries no inline value.
 */
function readLabelValue(
  lines: readonly string[],
  start: number,
  end: number,
  inline: string
): string {
  const value = unwrapValue(inline);
  if (value.length > 0) return value;

  for (let index = start + 1; index < end; index++) {
    const trimmed = lines[index].trim();
    if (trimmed.length === 0) continue;
    const opening = FENCE_TOKEN.exec(trimmed);
    if (!opening) return '';
    const marker = opening[1];
    const body: string[] = [];
    for (let cursor = index + 1; cursor < end; cursor++) {
      const closing = FENCE_TOKEN.exec(lines[cursor].trim());
      if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) break;
      body.push(lines[cursor]);
    }
    return body.join('\n').trim();
  }
  return '';
}

export class BaselineEvidence implements BaselineEvidenceResult {
  public readonly claimedReproduction: boolean;
  public readonly found: boolean;
  public readonly headingLine: number;
  public readonly claims: readonly BaselineClaim[];
  public readonly findings: readonly BaselineFinding[];

  private constructor(
    claimedReproduction: boolean,
    found: boolean,
    headingLine: number,
    claims: readonly BaselineClaim[],
    findings: readonly BaselineFinding[]
  ) {
    this.claimedReproduction = claimedReproduction;
    this.found = found;
    this.headingLine = headingLine;
    this.claims = Object.freeze([...claims]);
    this.findings = Object.freeze([...findings]);
  }

  public static fromPlan(markdown: string): BaselineEvidence {
    const lines = String(markdown ?? '').split('\n');
    const fenceMask = computeFenceMask(lines);
    const findings: BaselineFinding[] = [];

    // Header scan: only the lines BEFORE the first level-2 heading can arm the
    // reproduction claim, so a §1 problem statement cannot arm it. Fenced lines
    // are samples, never the document header.
    let headerEnd = lines.length;
    for (let index = 0; index < lines.length; index++) {
      if (fenceMask[index]) continue;
      if (LEVEL_TWO_HEADING.test(lines[index].trim())) {
        headerEnd = index;
        break;
      }
    }

    let claimedReproduction = false;
    let claimLine = 1;
    let claimExcerpt = '';
    for (let index = 0; index < headerEnd; index++) {
      if (fenceMask[index]) continue;
      const line = lines[index];
      const armed = REPRODUCTION_CLAIM.test(line) || (BASELINE_WORD.test(line) && DIST_ANCHOR.test(line));
      if (!armed) continue;
      claimedReproduction = true;
      claimLine = index + 1;
      claimExcerpt = truncate(line);
      break;
    }

    const section = findSection(lines, fenceMask);
    const claims: BaselineClaim[] = [];

    if (section !== null) {
      for (const region of claimRegions(lines, section, fenceMask)) {
        const heading = detectHeading(lines[region.start]);
        if (!heading) continue;
        const id = normaliseHeadingTitle(heading.title);
        if (id.length === 0) continue;

        let declared = '';
        let command = '';
        let output = '';

        for (let index = region.start + 1; index < region.end; index++) {
          if (fenceMask[index]) continue;
          const match = LABEL_PATTERN.exec(lines[index]);
          if (!match) continue;
          const key = match[1].toLowerCase();
          const value = readLabelValue(lines, index, region.end, match[2]);
          if (key === 'declared') declared = value;
          else if (key === 'command') command = value;
          else output = value;
        }

        // The untouched scaffold stub: the template's own `<claim-id>` heading
        // with no label filled in declares no number, so it is not a claim and
        // must not refuse every plan that declares no baseline. Any real id, or
        // any single filled label, keeps the strict validation below.
        const untouchedStub =
          id === SCAFFOLD_STUB_CLAIM_ID &&
          declared.length === 0 &&
          command.length === 0 &&
          output.length === 0;
        if (untouchedStub) continue;

        const claim: BaselineClaim = {
          id,
          declared,
          command,
          output,
          line: region.start + 1
        };
        claims.push(claim);

        if (claim.declared.length === 0) {
          findings.push({
            rule: BASELINE_RULE_MISSING_VALUE,
            claim: claim.id,
            line: claim.line,
            excerpt: truncate(heading.title)
          });
        }
        if (claim.command.length === 0) {
          findings.push({
            rule: BASELINE_RULE_MISSING_COMMAND,
            claim: claim.id,
            line: claim.line,
            excerpt: truncate(heading.title)
          });
        }
        if (claim.output.length === 0) {
          findings.push({
            rule: BASELINE_RULE_MISSING_OUTPUT,
            claim: claim.id,
            line: claim.line,
            excerpt: truncate(heading.title)
          });
        }
      }
    }

    if (claimedReproduction && (section === null || claims.length === 0)) {
      findings.push({
        rule: BASELINE_RULE_MISSING_EVIDENCE,
        claim: null,
        line: claimLine,
        excerpt:
          claimExcerpt.length > 0
            ? claimExcerpt
            : `the header claims reproduction but no ${HEADING_BASELINE_EVIDENCE} section carries a claim`
      });
    }

    // Body cross-check: a declared number outside the evidence section either
    // rides an evidence carrier (the claim id) or is an unbacked declaration.
    const claimIds = new Set(claims.map((claim) => claim.id));
    const inSection = (index: number): boolean =>
      section !== null && index >= section.start && index < section.end;

    for (let index = headerEnd; index < lines.length; index++) {
      if (fenceMask[index]) continue;
      const line = lines[index];
      if (inSection(index)) continue;
      if (detectHeading(line)) continue;

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const namedClaim = [...claimIds].find((id) => trimmed.includes(id)) ?? null;
      if (namedClaim === null) {
        if (claimedReproduction && BASELINE_WORD.test(line) && DIGIT.test(line)) {
          findings.push({
            rule: BASELINE_RULE_MISSING_EVIDENCE,
            claim: null,
            line: index + 1,
            excerpt: truncate(line)
          });
        }
        continue;
      }

      const claim = claims.find((candidate) => candidate.id === namedClaim);
      const values = extractValueSpans(trimmed);
      if (!claim || values.length === 0 || claim.declared.length === 0) continue;
      // A row may document BOTH the declared and the measured value ("declared
      // X, measured Y"). It agrees with the evidence when ANY span matches;
      // only a line with no matching span is a drift.
      if (values.some((value) => baselineValuesMatch(claim.declared, value))) continue;

      findings.push({
        rule: BASELINE_RULE_BODY_MISMATCH,
        claim: claim.id,
        line: index + 1,
        excerpt: truncate(line),
        declared: claim.declared,
        restated: values.join(' / ')
      });
    }

    return new BaselineEvidence(
      claimedReproduction,
      section !== null,
      section === null ? 0 : section.start + 1,
      claims,
      findings
    );
  }
}
