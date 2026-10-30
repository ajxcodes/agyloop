/**
 * agyloop - Plan Directory Grammar (Domain Layer)
 *
 * The ONE slug/directory/filename grammar shared by every producer of a plan
 * artifact (issue #283, bounded by #364): the scaffold
 * (`scaffoldPlanDirectory`), the discovery dispatch payload, the resolver, the
 * plan generator's two write legs and the `plan --dry-run` preview all derive
 * their names from THIS module.
 *
 * Why this exists: the scaffold slugified the issue title with
 * `/[^a-z0-9]+/g` while the discovery subagent invented its own slug from the
 * same title (`base's` became `bases`, not `base-s`). Two directories were
 * created for ONE issue, the RCA gate read the empty one, and the operator had
 * to copy the report and delete a directory by hand.
 *
 * Byte budgets (issue #364): a raw issue title is unbounded, so deriving a
 * folder/filename from it verbatim reaches `ENAMETOOLONG` (> 255 bytes) and
 * PLAN cannot start. Every derived name is therefore bounded here — the ONE
 * place the bound lives — and long titles are truncated at a word boundary and
 * stamped with a deterministic hash so two long titles never share a folder.
 *
 * Purity note: this module imports NOTHING external and no Node module — no
 * `node:path`, no `fs`, no `process` access, and deliberately no `node:crypto`
 * (the domain may not import it, and the hash must be identical across
 * runs/machines, so it is neither process- nor time-seeded). The only imports
 * are `../constants` and `../errors`, both inside `src/domain`. The
 * repository's architecture fitness test
 * (`tests/architecture/hexagonal-boundaries.test.ts`) forbids every external
 * import inside `src/domain`.
 */

import { VALIDATION_FIELD_PLAN_TITLE } from '../constants';
import { ValidationError } from '../errors';

/**
 * Byte budget for a derived plan FOLDER name.
 *
 * `NAME_MAX` is 255; 143 also stays under eCryptfs' 143-character filename
 * limit and leaves room for a `<name>.tmp` sibling without crossing 255.
 */
export const PLAN_DIR_NAME_MAX_BYTES = 143;

/** Byte budget for a derived plan artifact FILENAME (same rationale). */
export const PLAN_FILE_NAME_MAX_BYTES = 143;

/** The slug budget before the collision hash is appended. */
export const PLAN_SLUG_MAX_BYTES = 100;

/** Hex chars of the FNV-1a disambiguator appended when a slug is truncated. */
export const PLAN_NAME_HASH_HEX = 8;

/** The issue component is clamped too, so a pathological `--issue` is bounded. */
export const PLAN_ISSUE_MAX_BYTES = 16;

/** The prefix of the discovery artifact filename. */
export const PLAN_DISCOVERY_FILE_PREFIX = '[Discovery] - ' as const;

/** The prefix of the implementation artifact filename. */
export const PLAN_IMPLEMENTATION_FILE_PREFIX = '[Implementation] - ' as const;

/** The extension every plan artifact filename carries. */
export const PLAN_FILE_EXTENSION = '.md' as const;

/** The placeholder a sanitised title collapses to when nothing survives. */
export const PLAN_UNTITLED_TITLE = 'untitled' as const;

/**
 * The UTF-8 byte length of `text`.
 *
 * Counted by code point (no `Buffer`, no `TextEncoder`) so the domain stays
 * platform-independent and a lone surrogate is measured the way the filesystem
 * measures it (three bytes of replacement).
 *
 * @param text - The text to measure.
 * @returns Its UTF-8 byte length; `0` for empty/non-string input.
 */
export function planByteLength(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

/**
 * The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`.
 *
 * Iterates CODE POINTS, never code units, so a CJK title can never be cut
 * mid-sequence (no U+FFFD, no split surrogate pair).
 *
 * @param text - The text to truncate.
 * @param maxBytes - The byte budget.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (!text || typeof text !== 'string' || maxBytes <= 0) return '';
  let used = 0;
  let result = '';
  for (const char of text) {
    const size = planByteLength(char);
    if (used + size > maxBytes) break;
    used += size;
    result += char;
  }
  return result;
}

/** The UTF-8 bytes of `text`, computed without `Buffer`/`TextEncoder`. */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return bytes;
}

/**
 * FNV-1a (32-bit) over the UTF-8 bytes of `text`, as 8 lowercase hex chars.
 *
 * Deterministic by construction: no clock, PID, random seed or process salt, so
 * a re-entry re-derives the SAME folder for the same title (that is what makes
 * the scaffold's adoption branch work).
 */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of utf8Bytes(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(PLAN_NAME_HASH_HEX, '0');
}

/**
 * Lowercases and slugifies arbitrary text into the plan-directory component.
 *
 * This is the EXACT body of the historical `FilePlanGenerator.slugify`, moved
 * here so the two cannot diverge: that method now delegates to this function.
 * It is deliberately UNBOUNDED — `planSlugBounded` is the bounded form the
 * folder name uses, so every existing consumer keeps byte-identical output.
 *
 * @param text - The issue title (or any text to slugify).
 * @returns A lowercase, dash-separated slug; `''` for empty/non-string input.
 */
export function planSlug(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The bounded slug used inside a plan folder name (issue #364).
 *
 * A slug within {@link PLAN_SLUG_MAX_BYTES} is returned unchanged, so every
 * legacy folder name is byte-identical. A longer slug is cut at the last `-`
 * at or below the budget when that boundary keeps at least half the budget
 * (a word cut, which real issue titles get); otherwise it is hard-cut. Because
 * truncation alone would make `'x'.repeat(372)` and `'x'.repeat(371) + 'y'`
 * share a folder, a cut slug is stamped with `-<8 hex of FNV-1a over the FULL
 * raw title>`, which is deterministic and therefore adoptable on re-entry.
 *
 * @param text - The issue title.
 */
export function planSlugBounded(text: string): string {
  const slug = planSlug(text);
  if (planByteLength(slug) <= PLAN_SLUG_MAX_BYTES) return slug;

  const hashSuffix = `-${fnv1aHex(text)}`;
  const available = PLAN_SLUG_MAX_BYTES - planByteLength(hashSuffix);
  let head = truncateUtf8(slug, available);

  // A word boundary at or below the budget, when it keeps at least half the
  // budget, reads far better than a hard cut (`…-the-planner-can` not `…-the-p`).
  const boundary = head.lastIndexOf('-');
  if (boundary >= 0 && boundary >= PLAN_SLUG_MAX_BYTES / 2) {
    head = head.slice(0, boundary);
  }
  head = head.replace(/-+$/, '');
  if (head.length === 0) head = 'plan';
  return `${head}${hashSuffix}`;
}

/**
 * The issue component of a plan folder name, clamped and stripped to
 * `[A-Za-z0-9-]` (issue #364): `--issue` is documented as digits only, but
 * `ScaffoldParams.issue` is `number | string`, so a pathological value must not
 * be able to push the folder over its budget.
 *
 * Exported because {@link planDirectoryPrefix} MUST derive from the same
 * normalisation: `planFolderName(' 364', …)` is `'364-…'`, so a raw
 * `String(issue)` prefix would be `' 364-'` and adoption would never see the
 * folder its own producer created.
 */
export function planIssuePart(issue: number | string | null | undefined): string {
  if (issue === null || issue === undefined) return 'adhoc';
  const cleaned = String(issue).trim().replace(/[^A-Za-z0-9-]/g, '');
  if (cleaned.length === 0) return 'adhoc';
  const bounded = truncateUtf8(cleaned, PLAN_ISSUE_MAX_BYTES);
  return bounded.length > 0 ? bounded : 'adhoc';
}

/**
 * The canonical folder name for an issue's plan directory:
 * `<issue>-<slug>` (or `adhoc-<slug>` when no issue is known), bounded to
 * {@link PLAN_DIR_NAME_MAX_BYTES} bytes.
 *
 * @param issue - The issue number/string, or null/undefined for an ad-hoc run.
 * @param title - The issue title.
 */
export function planFolderName(
  issue: number | string | null | undefined,
  title: string
): string {
  return `${planIssuePart(issue)}-${planSlugBounded(title)}`;
}

/**
 * The directory-name prefix every candidate for `issue` starts with.
 *
 * Derived from the SAME {@link planIssuePart} as {@link planFolderName} (issue
 * #364 review): a padded/odd `issue` (`' 364'`) must not make the folder
 * `364-x` while adoption looks for ` 364-`, which silently shadowed every
 * pre-existing directory for that issue.
 *
 * @param issue - The issue number/string, or null/undefined for an ad-hoc run.
 */
export function planDirectoryPrefix(issue: number | string | null | undefined): string {
  return `${planIssuePart(issue)}-`;
}

/**
 * The filesystem-safe title body used in a plan artifact filename.
 *
 * This is the EXACT body of the historical `FilePlanGenerator.sanitizeFilename`
 * moved into the domain (issue #364), so the folder and the filename finally
 * share one module. It strips illegal characters, collapses whitespace and
 * trims; an empty result collapses to `untitled`.
 *
 * @param title - The raw plan title.
 */
export function sanitizePlanTitle(title: string): string {
  if (!title || typeof title !== 'string') return PLAN_UNTITLED_TITLE;
  const cleaned = title
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length === 0 ? PLAN_UNTITLED_TITLE : cleaned;
}

/**
 * The canonical artifact filename for a plan of `type`, bounded to
 * {@link PLAN_FILE_NAME_MAX_BYTES} bytes (issue #364).
 *
 * `'[Discovery] - '` / `'[Implementation] - '` + the sanitised title, truncated
 * on a code-point boundary to leave room for `.md`. A CJK title therefore
 * cannot die on `open … ENAMETOOLONG` after its folder was already created.
 *
 * @param type - The plan type.
 * @param title - The raw plan title.
 */
export function planArtifactFileName(
  type: 'discovery' | 'implementation',
  title: string
): string {
  const prefix =
    type === 'discovery' ? PLAN_DISCOVERY_FILE_PREFIX : PLAN_IMPLEMENTATION_FILE_PREFIX;
  const budget =
    PLAN_FILE_NAME_MAX_BYTES - planByteLength(prefix) - planByteLength(PLAN_FILE_EXTENSION);
  const head = truncateUtf8(sanitizePlanTitle(title), budget).trimEnd();
  const safeHead = head.length === 0 ? PLAN_UNTITLED_TITLE : head;
  return `${prefix}${safeHead}${PLAN_FILE_EXTENSION}`;
}

/**
 * Refuses a derived plan name that would not fit on disk (issue #364, AC-5).
 *
 * Throws a typed `ValidationError` naming the DERIVED folder/file, its byte
 * count, the documented limit and the remedy (`--title` / `--plan-dir`), so an
 * operator never sees a bare `ENAMETOOLONG`.
 *
 * The folder check applies ONLY to a name DERIVED by the current call: pass
 * `folderName` when this run computed the component. An ADOPTED directory is
 * omitted (see `GeneratePlanOptions.folderName`) because its name predates the
 * bound — every pre-#364 plan folder is 154–211 bytes, so re-entry must adopt
 * one rather than die on a budget it never had to satisfy.
 *
 * @param names - The derived folder and file names, plus the raw title.
 */
export function assertPlanNameWithinLimits(names: {
  readonly folderName?: string | null;
  readonly fileName: string;
  readonly title: string;
}): void {
  if (names.folderName) {
    const folderBytes = planByteLength(names.folderName);
    if (folderBytes > PLAN_DIR_NAME_MAX_BYTES) {
      throw new ValidationError(
        VALIDATION_FIELD_PLAN_TITLE,
        names.title,
        `the derived plan folder "${names.folderName}" is ${folderBytes} bytes, over the ${PLAN_DIR_NAME_MAX_BYTES}-byte limit; pass a shorter --title, or choose the folder with --plan-dir`
      );
    }
  }

  const fileBytes = planByteLength(names.fileName);
  if (fileBytes > PLAN_FILE_NAME_MAX_BYTES) {
    throw new ValidationError(
      VALIDATION_FIELD_PLAN_TITLE,
      names.title,
      `the derived plan file "${names.fileName}" is ${fileBytes} bytes, over the ${PLAN_FILE_NAME_MAX_BYTES}-byte limit; pass a shorter --title, or choose the folder with --plan-dir`
    );
  }
}
