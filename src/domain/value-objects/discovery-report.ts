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
 * template. Its first version matched only the scaffold's own
 * `- **Key:** value` shape and so rejected 80% of this repository's genuine
 * RCA reports, whose subagents nest the value as an indented sub-list on the
 * lines below the key, and quote the empty template inside fences while
 * explaining what they replaced. Both shapes are handled here — see
 * `proseMarkdown` and `REGEX_MD_INDENTED_CONTINUATION`.
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
  DISCOVERY_REPORT_MIN_CHARS,
  DISCOVERY_REPORT_MIN_FILLED_KEYS,
  DISCOVERY_REPORT_MAX_UNFILLED_KEYS
} from '../constants';

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

  private constructor(markdown: string) {
    this.markdown = markdown;
    this.proseMarkdown = markdown.replace(REGEX_MD_FENCED_CODE_BLOCK, '');
    this.keyBullets = partitionKeyBullets(this.proseMarkdown);
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
   * True when the document is long enough to be a real report AND enough
   * template placeholder keys carry content AND no more than a bounded number
   * were left blank.
   *
   * Fail-closed by design: if anything is ambiguous the park holds, and
   * `--skip-discovery` is the explicit, audited escape hatch. The blank-key
   * allowance is bounded (`DISCOVERY_REPORT_MAX_UNFILLED_KEYS`) rather than
   * zero — a hard zero rejected genuine reports and neutralised the gate.
   */
  public get isPopulated(): boolean {
    return (
      this.markdown.trim().length >= DISCOVERY_REPORT_MIN_CHARS &&
      this.filledKeyCount >= DISCOVERY_REPORT_MIN_FILLED_KEYS &&
      this.unfilledPlaceholderKeys.length <= DISCOVERY_REPORT_MAX_UNFILLED_KEYS
    );
  }
}

/**
 * Splits the document's `- **Key:**` bullets into inline-valued,
 * nested-valued and blank.
 *
 * One pass, in document order, so `filledKeyCount` and
 * `unfilledPlaceholderKeys` are two views of one partition rather than two
 * independently computed numbers that can disagree.
 *
 * Blank lines are skipped when looking for a nested value, and only a STRICTLY
 * deeper indent counts as a continuation: a sibling bullet (`- **Next Key:**`)
 * or any top-level line is the next section, not a continuation of this one.
 * That distinction is what keeps a pristine scaffold — ten sibling blank keys
 * and nothing indented — scored as unpopulated.
 */
function partitionKeyBullets(proseMarkdown: string): readonly KeyBullet[] {
  const lines = proseMarkdown.split('\n');
  const bullets: KeyBullet[] = [];

  for (let i = 0; i < lines.length; i++) {
    let kind: KeyBulletKind | null = null;
    if (REGEX_MD_FILLED_KEY_BULLET_LINE.test(lines[i])) {
      kind = 'inline';
    } else if (REGEX_MD_UNFILLED_KEY_BULLET_LINE.test(lines[i])) {
      kind = hasIndentedContinuation(lines, i) ? 'nested' : 'blank';
    }
    if (kind !== null) {
      bullets.push({ key: extractKey(lines[i]), kind });
    }
  }

  return bullets;
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
 */
function extractKey(line: string): string {
  const withoutBullet = line.trim().replace(REGEX_MD_BULLET_PREFIX, '');
  return REGEX_MD_BOLD_KEY.exec(withoutBullet)?.[1]?.trim() ?? withoutBullet;
}
