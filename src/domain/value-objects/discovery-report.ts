/**
 * agyloop - DiscoveryReport Value Object
 *
 * Content-based evidence that a root-cause analysis report actually exists.
 *
 * Existence checks are useless for this decision: `FilePlanGenerator`
 * always writes the plan file when it scaffolds a fresh plan directory, and
 * `resolvePlanFile` falls back to "first non-summary `.md` in the plan dir" —
 * so "a discovery file exists" is trivially true for a pristine scaffold. Only
 * *content* separates "an untouched template" from "an RCA ran", which is why
 * the DISCOVERY park (issue #237) consults this value object instead of
 * `fs.existsSync()`.
 *
 * The predicate is calibrated against REAL discovery reports, not against the
 * template, and it accepts TWO shapes because the two authoritative sources
 * disagree about the grammar:
 *
 * 1. The scaffold's `- **Key:** value` bullets, including the #237 nested
 *    sub-list form and the prompt's `- **Key**: value` spelling (colon outside
 *    the bold). `filledKeyCount` / `unfilledPlaceholderKeys` /
 *    `continuationFilledKeys` describe this shape.
 * 2. `##`..`######` sections with substantive prose, which is what the
 *    discovery prompt's own Expected Output Structure asks for (issue #306).
 *    `substantiveSectionHeadings` / `contentUnitCount` / `contentCharCount`
 *    describe this shape.
 *
 * Scoring bullets alone was the #306 defect: a 34–44 KB, empirically verified
 * heading-shaped RCA scored `filledKeyCount = 0` and was called an "unpopulated
 * scaffold". The decision is therefore a CONTENT measure (substantive units and
 * characters) gated by shape evidence from EITHER partition — never a census
 * of one markdown construct.
 *
 * Pure domain object: depends on `../constants` only.
 */

import {
  REGEX_MD_UNFILLED_KEY_BULLET,
  REGEX_MD_FILLED_KEY_BULLET,
  REGEX_MD_FENCED_CODE_BLOCK,
  REGEX_MD_INDENTED_CONTINUATION,
  REGEX_MD_BULLET_PREFIX,
  REGEX_MD_BOLD_KEY,
  REGEX_MD_SECTION_HEADING,
  REGEX_MD_TITLE_HEADING,
  REGEX_MD_TABLE_SEPARATOR,
  REGEX_MD_BLOCKQUOTE_PREFIX,
  REGEX_MD_LINK_SYNTAX,
  REGEX_MD_EMPHASIS,
  REGEX_MD_INLINE_NOISE,
  REGEX_MD_WHITESPACE_RUN,
  REGEX_MD_TRAILING_PUNCTUATION,
  REGEX_MD_HEADING_NUMBERING,
  REGEX_MD_POINTER_ONLY_VALUE,
  REGEX_MD_CRLF,
  DISCOVERY_REPORT_MIN_CHARS,
  DISCOVERY_REPORT_MIN_FILLED_KEYS,
  DISCOVERY_REPORT_MAX_UNFILLED_KEYS,
  DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS,
  DISCOVERY_REPORT_MIN_CONTENT_UNITS,
  DISCOVERY_REPORT_MIN_CONTENT_CHARS,
  DISCOVERY_REPORT_MIN_PROSE_SECTIONS,
  formatDiscoveryMissingEvidence
} from '../constants';
import type { DiscoveryMissingEvidence } from '../constants';

/**
 * Per-line twin of one of the shared key-bullet constants.
 *
 * Derived from the constant's `source` rather than re-typed, so the two can
 * never drift, and rebuilt WITHOUT the `g` flag because it is used with
 * `RegExp.prototype.test()` on individual lines — a `g`-flagged regex carries
 * `lastIndex` between calls and would alternate true/false.
 */
function lineRegex(source: string): RegExp {
  return new RegExp(source);
}

const REGEX_MD_UNFILLED_KEY_BULLET_LINE = lineRegex(REGEX_MD_UNFILLED_KEY_BULLET.source);
const REGEX_MD_FILLED_KEY_BULLET_LINE = lineRegex(REGEX_MD_FILLED_KEY_BULLET.source);

/**
 * How a `- **Key:**` bullet carries its value.
 *
 * - `inline`: text after the closing `:**` on the same line.
 * - `nested`: an indented sub-list on the following lines.
 * - `blank`: neither — the section was never filled in.
 */
type KeyBulletKind = 'inline' | 'nested' | 'blank';

/** One `- **Key:**` bullet and the shape of the value it carries. */
interface KeyBullet {
  readonly key: string;
  readonly kind: KeyBulletKind;
  /** Cleaned character count of the value this bullet carries (0 when blank). */
  readonly valueChars: number;
  /**
   * True when the value is real content: it clears the per-unit floor, is not a
   * pointer (`see above`, `n/a`, …) and does not merely restate its own key or
   * section heading.
   */
  readonly substantive: boolean;
}

/** One `##`..`######` section and the cleaned size of its prose body. */
interface ContentSection {
  readonly heading: string;
  readonly bodyChars: number;
  /**
   * Substantive key-value characters carried INSIDE this section.
   *
   * Diagnostics only: it never feeds `contentUnitCount` / `contentCharCount`
   * (a key value is one unit, never a section's prose), but it keeps
   * `emptySectionHeadings` honest — a section whose only body is a filled
   * bullet is not an empty section.
   */
  readonly keyValueChars: number;
}

/**
 * The single pass over the document: the key-bullet census AND the content
 * partition. Both views come from one scan so they cannot disagree.
 */
interface ReportPartition {
  readonly keyBullets: readonly KeyBullet[];
  readonly sections: readonly ContentSection[];
}

export class DiscoveryReport {
  private readonly markdown: string;

  /**
   * `markdown` with every fenced code block deleted.
   *
   * Computed once, at construction, so the per-key scan reads this view and the
   * regexes never see quoted template text. Kept as a field rather than a
   * getter so every accessor below provably reads the same view.
   */
  private readonly proseMarkdown: string;

  /**
   * The partition is computed once for the same reason: `isPopulated` reads
   * three accessors, and recomputing (or, worse, computing them with subtly
   * different rules) is how the original defect survived review.
   */
  private readonly keyBullets: readonly KeyBullet[];

  /** Sections whose cleaned body clears `DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS`. */
  private readonly substantiveSections: readonly ContentSection[];

  /** Sections with headings but no substantive body, in document order. */
  private readonly emptySections: readonly ContentSection[];

  /** Filled key bullets whose value clears the per-unit character floor. */
  private readonly substantiveKeyValues: readonly KeyBullet[];

  private constructor(markdown: string) {
    // Normalise line endings ONCE, before any partition runs: every section and
    // key rule is `$`-anchored without the `m` flag, so a CRLF line (`## X\r`)
    // never matches and a whole CRLF report collapsed to zero sections, zero
    // units and an evidence-free park. Normalising `markdown` too keeps the
    // length diagnostic identical across the two encodings.
    this.markdown = markdown.replace(REGEX_MD_CRLF, '\n');
    this.proseMarkdown = this.markdown.replace(REGEX_MD_FENCED_CODE_BLOCK, '');

    const partition = partitionReport(this.proseMarkdown);
    this.keyBullets = partition.keyBullets;
    this.substantiveSections = partition.sections.filter(
      (section) => section.bodyChars >= DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS
    );
    this.emptySections = partition.sections.filter(
      (section) =>
        section.bodyChars < DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS && section.keyValueChars === 0
    );
    this.substantiveKeyValues = partition.keyBullets.filter((bullet) => bullet.substantive);
  }

  /**
   * Builds a report from arbitrary on-disk text. A null/undefined/non-string
   * input becomes the empty report (never populated) so a read failure can be
   * represented without throwing.
   */
  public static fromMarkdown(markdown: string | null | undefined): DiscoveryReport {
    if (typeof markdown !== 'string') {
      return new DiscoveryReport('');
    }
    return new DiscoveryReport(markdown);
  }

  /**
   * Bold-key bullets the template leaves unfilled: `- **Key:**` with nothing
   * after the closing colon and no indented continuation on the next
   * non-blank line.
   *
   * Returns the *keys*, not the raw lines, so callers can report exactly which
   * sections a subagent skipped.
   *
   * Derived from the same partition as `filledKeyCount`, so the two can never
   * disagree about a bullet — the original defect was exactly such a
   * disagreement, where a nested sub-list was counted as filled by neither.
   */
  public get unfilledPlaceholderKeys(): readonly string[] {
    return this.keyBullets.filter((b) => b.kind === 'blank').map((b) => b.key);
  }

  /**
   * Bold-key bullets that carry content, however the author wrote the value:
   * `- **Key:** <something>` inline, or `- **Key:**` with the value as an
   * indented sub-list on the following lines.
   */
  public get filledKeyCount(): number {
    return this.keyBullets.filter((b) => b.kind !== 'blank').length;
  }

  /**
   * Keys whose value is an indented continuation of the `- **Key:**` line
   * rather than trailing text on it.
   *
   * Exposed separately (instead of being folded into the key regexes) so the
   * numbers stay legible — a reviewer of the DISCOVERY park wants to see
   * "9 inline + 1 nested", not a magic 10 — and so a test can pin this shape
   * directly, which is the shape the original predicate got wrong.
   */
  public get continuationFilledKeys(): readonly string[] {
    return this.keyBullets.filter((b) => b.kind === 'nested').map((b) => b.key);
  }

  /**
   * `##`..`######` headings whose cleaned prose body clears the per-unit
   * character floor (issue #306).
   *
   * Headings are NOT content by themselves: the pristine scaffold has the same
   * four headings and zero body, and stays parked.
   */
  public get substantiveSectionHeadings(): readonly string[] {
    return this.substantiveSections.map((section) => section.heading);
  }

  /**
   * Headings whose body does not clear the substantive-prose floor, in
   * document order.
   *
   * Not "empty": a section carrying 1–19 characters of prose, or no prose but a
   * substantive `- **Key:**` value, is reported as lacking substantive prose
   * rather than as blank (the pre-review formatter called the latter empty and
   * named it in the park even though it carried the analysis). Used only for
   * diagnostics.
   */
  public get emptySectionHeadings(): readonly string[] {
    return this.emptySections.map((section) => section.heading);
  }

  /**
   * Substantive sections plus substantive key values (issue #306).
   *
   * This is the count the gate floors on — shape-agnostic, so a heading report
   * and a bullet report with the same content score the same.
   */
  public get contentUnitCount(): number {
    return this.substantiveSections.length + this.substantiveKeyValues.length;
  }

  /**
   * Sum of the substantive unit bodies only — heading text, front matter,
   * blank bullets and structural table rows contribute nothing.
   */
  public get contentCharCount(): number {
    const sectionChars = this.substantiveSections.reduce((sum, section) => sum + section.bodyChars, 0);
    const keyChars = this.substantiveKeyValues.reduce((sum, bullet) => sum + bullet.valueChars, 0);
    return sectionChars + keyChars;
  }

  /**
   * Heading-shaped evidence: enough substantive `##` sections.
   *
   * One getter for the predicate AND the diagnostic, so the two cannot drift
   * (issue #306 review).
   */
  private get proseEvidence(): boolean {
    return this.substantiveSectionHeadings.length >= DISCOVERY_REPORT_MIN_PROSE_SECTIONS;
  }

  /**
   * Key-bullet-shaped evidence: enough filled keys, with the blank-key cap
   * applied only when the report has no substantive prose (invariant 5).
   *
   * Shares `proseEvidence` with `isPopulated` for the same no-drift reason.
   */
  private get bulletEvidence(): boolean {
    return (
      this.filledKeyCount >= DISCOVERY_REPORT_MIN_FILLED_KEYS &&
      (this.proseEvidence ||
        this.unfilledPlaceholderKeys.length <= DISCOVERY_REPORT_MAX_UNFILLED_KEYS)
    );
  }

  /**
   * True when the document is long enough to be a real report AND carries
   * enough substantive content AND that content has evidence from at least one
   * accepted shape (prose sections, or bounded key bullets).
   *
   * Fail-closed by design: if anything is ambiguous the park holds, and
   * `--skip-discovery` is the explicit, audited escape hatch. The blank-key
   * allowance is bounded (`DISCOVERY_REPORT_MAX_UNFILLED_KEYS`) rather than
   * zero — a hard zero rejected genuine reports and neutralised the gate — but
   * it vetoes only the BULLET branch: a report with substantive prose sections
   * is not a scaffold, so retaining copied blank bullets cannot park it
   * (issue #306 invariant 5).
   */
  public get isPopulated(): boolean {
    return (
      this.markdown.trim().length >= DISCOVERY_REPORT_MIN_CHARS &&
      this.contentUnitCount >= DISCOVERY_REPORT_MIN_CONTENT_UNITS &&
      this.contentCharCount >= DISCOVERY_REPORT_MIN_CONTENT_CHARS &&
      (this.proseEvidence || this.bulletEvidence)
    );
  }

  /**
   * The measured gaps, for the parked operator (issue #306, AC3).
   *
   * Returns `''` when the report is populated. Otherwise hands the measurements
   * to `formatDiscoveryMissingEvidence`, which owns the wording and emits one
   * clause per FAILING condition only — including the document-length floor and
   * the shape-evidence requirement; omitting either left a parked operator with
   * no diagnostic at all (issue #306 review, AC3).
   */
  public describeMissingEvidence(): string {
    if (this.isPopulated) {
      return '';
    }

    const evidence: DiscoveryMissingEvidence = {
      markdownChars: this.markdown.trim().length,
      contentUnitCount: this.contentUnitCount,
      contentCharCount: this.contentCharCount,
      hasShapeEvidence: this.proseEvidence || this.bulletEvidence,
      blankKeys: this.unfilledPlaceholderKeys,
      sectionsWithoutSubstantiveProse: this.emptySectionHeadings
    };

    return formatDiscoveryMissingEvidence(evidence);
  }
}

/**
 * One pass over the fence-free document, in document order, producing the
 * key-bullet census and the section content partition.
 *
 * Keeping both in one scan is deliberate: `filledKeyCount` and
 * `unfilledPlaceholderKeys` have always been two views of one partition, and
 * the content measure must read exactly the same lines — a second scan with its
 * own rules is how the shape-blind predicate survived review.
 *
 * Section rules (issue #306):
 * - a `##`..`######` heading opens a section and contributes no characters;
 * - a single `#` title line is preamble and contributes nothing;
 * - a key bullet's line and its indented continuations belong to the KEY unit,
 *   never to the enclosing section's prose body (but a substantive key value is
 *   remembered on the section, so diagnostics do not call that section empty);
 * - everything else contributes its cleaned length to the current section —
 *   and nothing before the first `##` heading counts at all.
 */
function partitionReport(proseMarkdown: string): ReportPartition {
  const lines = proseMarkdown.split('\n');
  const bullets: KeyBullet[] = [];
  const sections: ContentSection[] = [];

  let heading: string | null = null;
  let bodyChars = 0;
  let keyValueChars = 0;

  const closeSection = (): void => {
    if (heading !== null) {
      sections.push({ heading, bodyChars, keyValueChars });
    }
    heading = null;
    bodyChars = 0;
    keyValueChars = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const sectionMatch = REGEX_MD_SECTION_HEADING.exec(line);
    if (sectionMatch) {
      closeSection();
      heading = sectionMatch[2].trim();
      continue;
    }

    if (REGEX_MD_TITLE_HEADING.test(line)) {
      // The document title (and, with it, the front matter) is preamble.
      continue;
    }

    let kind: KeyBulletKind | null = null;
    if (REGEX_MD_FILLED_KEY_BULLET_LINE.test(line)) {
      kind = 'inline';
    } else if (REGEX_MD_UNFILLED_KEY_BULLET_LINE.test(line)) {
      kind = hasIndentedContinuation(lines, i) ? 'nested' : 'blank';
    }

    if (kind !== null) {
      const key = extractKey(line);
      const value = collectKeyValue(lines, i, kind === 'inline');
      const substantive = isSubstantiveKeyValue(value.text, key, heading);
      bullets.push({ key, kind, valueChars: value.chars, substantive });
      // Diagnostics only: a filled bullet means its section is not empty, even
      // though its characters belong to the KEY unit, never the section's prose.
      if (substantive && heading !== null) {
        keyValueChars += value.chars;
      }
      i = value.endIndex;
      continue;
    }

    if (heading !== null) {
      bodyChars += cleanProseLine(line).length;
    }
  }

  closeSection();

  return { keyBullets: bullets, sections };
}

/**
 * The cleaned text of a key bullet's value, its size, and the last line it
 * occupies.
 *
 * Inline values come from the text after the bold key; nested values come from
 * the indented continuation lines. Blank lines inside the continuation are
 * skipped but do not end it, and a deeper-indented KEY bullet is not a
 * continuation — it is its own section, so it is classified separately.
 */
function collectKeyValue(
  lines: readonly string[],
  index: number,
  includeInline: boolean
): { text: string; chars: number; endIndex: number } {
  const parts: string[] = [];
  if (includeInline) {
    const withoutBullet = (lines[index] ?? '').trim().replace(REGEX_MD_BULLET_PREFIX, '');
    parts.push(withoutBullet.replace(REGEX_MD_BOLD_KEY, ''));
  }

  const bulletIndent = leadingWhitespaceLength(lines[index] ?? '');
  let endIndex = index;

  for (let i = index + 1; i < lines.length; i++) {
    const candidate = lines[i];
    if (candidate.trim() === '') {
      continue;
    }
    if (
      leadingWhitespaceLength(candidate) <= bulletIndent ||
      !REGEX_MD_INDENTED_CONTINUATION.test(candidate)
    ) {
      break;
    }
    if (
      REGEX_MD_FILLED_KEY_BULLET_LINE.test(candidate) ||
      REGEX_MD_UNFILLED_KEY_BULLET_LINE.test(candidate)
    ) {
      break;
    }
    parts.push(candidate);
    endIndex = i;
  }

  const text = parts
    .map((part) => cleanProseLine(part))
    .join(' ')
    .replace(REGEX_MD_WHITESPACE_RUN, ' ')
    .trim();

  return { text, chars: text.length, endIndex };
}

/**
 * True when a key value is real evidence rather than shape: it clears the
 * per-unit floor, is not a pointer (`see above`, `see the … section above for
 * details`, `n/a`, `TODO`, …) and does not merely restate its own key or its
 * section heading.
 *
 * Why the extra checks: the character floor alone could be cleared by long
 * pointer filler, so four content-free bullets scored four units and released a
 * skeleton (issue #306 review, AC2). A cross-reference and a restated heading
 * carry no analysis however long they are.
 */
function isSubstantiveKeyValue(value: string, key: string, heading: string | null): boolean {
  if (value.length < DISCOVERY_REPORT_MIN_CONTENT_UNIT_CHARS) {
    return false;
  }

  const normalised = normaliseEvidenceText(value);
  if (normalised.length === 0 || REGEX_MD_POINTER_ONLY_VALUE.test(normalised)) {
    return false;
  }
  if (normalised === normaliseEvidenceText(key)) {
    return false;
  }
  if (heading !== null && normalised === normaliseEvidenceText(heading.replace(REGEX_MD_HEADING_NUMBERING, ''))) {
    return false;
  }

  return true;
}

/** Lowercase, de-markdown, collapse and de-punctuate, for value comparisons. */
function normaliseEvidenceText(text: string): string {
  return text
    .toLowerCase()
    .replace(REGEX_MD_EMPHASIS, '')
    .replace(REGEX_MD_INLINE_NOISE, ' ')
    .replace(REGEX_MD_WHITESPACE_RUN, ' ')
    .trim()
    .replace(REGEX_MD_TRAILING_PUNCTUATION, '');
}

/**
 * Drops markdown noise from a prose line so the content measure counts words,
 * not punctuation: the bullet marker, a leading `**Label:**` / `**Label**:`,
 * blockquote markers, table pipes, backticks, `**`/`__`, and link syntax (the
 * link TEXT is kept).
 *
 * A table separator row is structural, not evidence, and returns `''`.
 */
function cleanProseLine(line: string): string {
  if (REGEX_MD_TABLE_SEPARATOR.test(line)) {
    return '';
  }

  let text = line.trim();
  text = text.replace(REGEX_MD_BULLET_PREFIX, '');
  text = text.replace(REGEX_MD_BLOCKQUOTE_PREFIX, '');
  text = text.replace(REGEX_MD_BOLD_KEY, '');
  text = text.replace(REGEX_MD_LINK_SYNTAX, '$1');
  text = text.replace(REGEX_MD_EMPHASIS, '');
  text = text.replace(REGEX_MD_INLINE_NOISE, ' ');
  text = text.replace(REGEX_MD_WHITESPACE_RUN, ' ').trim();
  return text;
}

/**
 * True when `lines[index + 1]`, skipping blank lines, is indented deeper than
 * the bullet at `lines[index]`.
 */
function hasIndentedContinuation(lines: readonly string[], index: number): boolean {
  const bulletIndent = leadingWhitespaceLength(lines[index] ?? '');

  for (let i = index + 1; i < lines.length; i++) {
    const candidate = lines[i];
    if (candidate.trim() === '') {
      continue;
    }
    return (
      leadingWhitespaceLength(candidate) > bulletIndent && REGEX_MD_INDENTED_CONTINUATION.test(candidate)
    );
  }
  return false;
}

/** Count of leading whitespace characters on `line`. */
function leadingWhitespaceLength(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Pulls the human-readable key out of a matched bullet line, e.g. the line
 * `- **Identified Failure Mode:**` yields `Identified Failure Mode`.
 *
 * Anchored and therefore capture-only: a `String.replace` with `'$1'` was
 * wrong here because `REGEX_MD_BOLD_KEY` is anchored at the start of the
 * already-stripped line, so it leaves any inline value glued onto the key
 * (`- **Foo:** bar` yielded `Foo bar`). Nothing reads the key today except the
 * blank/nested accessors, so that was latent — but the partition is the
 * predicate's ground truth and a future accessor would have surfaced it.
 *
 * Both spellings (`**Foo:**` and `**Foo**:`) yield the same bare key: the
 * trailing colon is part of the delimiter, never the name.
 */
function extractKey(line: string): string {
  const withoutBullet = line.trim().replace(REGEX_MD_BULLET_PREFIX, '');
  return REGEX_MD_BOLD_KEY.exec(withoutBullet)?.[1]?.trim() ?? withoutBullet;
}
