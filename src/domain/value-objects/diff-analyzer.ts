/**
 * agyloop - DiffAnalyzer & Commit Drafter Engine
 *
 * Pure domain analysis engine for git working diffs and issue contexts.
 * Extracts modified files, computes change metrics, detects contract breaking changes,
 * infers conventional commit type and component scope, and drafts compliant CommitMessage.
 */

import {
  ConventionalCommitType,
  COMMIT_TYPE_FEAT,
  COMMIT_TYPE_FIX,
  COMMIT_TYPE_REFACTOR,
  COMMIT_TYPE_TEST,
  COMMIT_TYPE_CHORE,
  COMMIT_TYPE_PERF,
  COMMIT_TYPE_DOCS,
  COMMIT_TYPE_BUILD,
  COMMIT_TYPE_CI,
  CONVENTIONAL_COMMIT_TYPES,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  REGEX_DIFF_FILE_HEADER,
  REGEX_BREAKING_CHANGE_FOOTER,
  REGEX_ISSUE_NUMBER_REF,
  REGEX_LEADING_CONVENTIONAL_PREFIX,
  REGEX_MILESTONE_TAG,
  REGEX_KIND_TAG,
  TOKEN_BREAKING_CHANGE,
  DIFF_EXCLUDED_PATTERNS
} from '../constants';
import { CommitMessage } from './commit-message';

export interface DiffAnalysisContext {
  readonly issueNumber?: number | string | null;
  readonly issueTitle?: string | null;
  readonly userInstructions?: string | null;
  readonly explicitType?: string | null;
  readonly explicitScope?: string | null;
  readonly isBreaking?: boolean;
}

export interface DraftCommitPlan {
  readonly commitMessage: CommitMessage;
  readonly modifiedFiles: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly inferredType: ConventionalCommitType;
  readonly inferredScope: string | null;
  readonly isBreaking: boolean;
}

/**
 * The class of a diff line (#382, D1). A matcher over a patch must be able to
 * say WHICH class of line it matched, otherwise a token in a 3-line context
 * block or a hunk-header trailer is indistinguishable from a real change.
 */
type DiffLineKind =
  | 'meta' // diff --git, index, modes, rename/copy, Binary files, \ No newline, blank
  | 'file-header' // --- a/x and +++ b/x, seen BEFORE the first hunk of a file section
  | 'hunk-header' // @@ … @@ (including a trailing "BREAKING CHANGE:" trailer)
  | 'context' // leading space
  | 'content-add' // leading +
  | 'content-remove'; // leading -

interface ClassifiedDiffLine {
  readonly kind: DiffLineKind;
  /** The line WITHOUT its one-character diff marker for content/context lines. */
  readonly content: string;
}

/** `---`/`+++` file headers, but only before the first hunk of a section. */
const DIFF_FILE_HEADER = /^(?:---|\+\+\+)(?:[ \t]|$)/;

/** Patch metadata lines: never content, whatever they contain. */
const DIFF_META_LINE =
  /^(?:index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch|\\ No newline at end of file)/;

/**
 * Classifies a raw `git diff` into line kinds. The evaluation ORDER is the
 * specification (#382 §2.2.1):
 *
 * 1. `diff --git ` → meta; reset `inHunk`.
 * 2. `@@` → hunk-header; `inHunk = true`.
 * 3. Any `DIFF_META_LINE` → meta.
 * 4. `---`/`+++` only while `!inHunk` → file-header. After a hunk has begun
 *    they are content (a removed line whose text starts with `--`, an added
 *    line whose text starts with `++`).
 * 5. Leading `+` → content-add. 6. Leading `-` → content-remove.
 * 7. Leading space → context. 8. Anything else → meta.
 */
function* classifyDiffLines(diffText: string): Generator<ClassifiedDiffLine> {
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      yield { kind: 'meta', content: line };
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      yield { kind: 'hunk-header', content: line };
      continue;
    }
    if (DIFF_META_LINE.test(line)) {
      yield { kind: 'meta', content: line };
      continue;
    }
    if (!inHunk && DIFF_FILE_HEADER.test(line)) {
      yield { kind: 'file-header', content: line };
      continue;
    }
    if (line.startsWith('+')) {
      yield { kind: 'content-add', content: line.slice(1) };
      continue;
    }
    if (line.startsWith('-')) {
      yield { kind: 'content-remove', content: line.slice(1) };
      continue;
    }
    if (line.startsWith(' ')) {
      yield { kind: 'context', content: line.slice(1) };
      continue;
    }
    yield { kind: 'meta', content: line };
  }
}

export class DiffAnalyzer {
  public static isExcludedDiffPath(
    filePath: string,
    excludedPatterns: readonly string[] = DIFF_EXCLUDED_PATTERNS
  ): boolean {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }
    const cleanPath = filePath.trim();
    for (const pattern of excludedPatterns) {
      if (pattern.endsWith('/')) {
        const dir = pattern.slice(0, -1);
        if (
          cleanPath.startsWith(pattern) ||
          cleanPath.startsWith(`a/${pattern}`) ||
          cleanPath.startsWith(`b/${pattern}`) ||
          cleanPath.includes(`/${pattern}`) ||
          cleanPath === dir
        ) {
          return true;
        }
      } else {
        if (
          cleanPath === pattern ||
          cleanPath.endsWith(`/${pattern}`) ||
          cleanPath === `a/${pattern}` ||
          cleanPath === `b/${pattern}`
        ) {
          return true;
        }
      }
    }
    return false;
  }

  public static splitDiffIntoFiles(diffText: string): Array<{ file: string; content: string }> {
    if (!diffText || typeof diffText !== 'string') {
      return [];
    }

    const chunks: Array<{ file: string; content: string }> = [];
    const rawChunks = diffText.split(/(?=^diff --git )/m);

    for (const chunk of rawChunks) {
      const trimmed = chunk.trim();
      if (!trimmed) {
        continue;
      }
      let file = '';
      const match = trimmed.match(/^diff --git a\/(.+?) b\/(.+?)(?:\r?\n|$)/m);
      if (match) {
        file = match[2]?.trim() || match[1]?.trim() || '';
      } else {
        const plusMatch = trimmed.match(/^\+\+\+ b\/(.+?)(?:\r?\n|$)/m);
        if (plusMatch && plusMatch[1] && plusMatch[1] !== '/dev/null') {
          file = plusMatch[1].trim();
        }
      }
      chunks.push({ file, content: chunk });
    }

    return chunks;
  }

  public static filterDiff(
    diffText: string,
    excludedPatterns: readonly string[] = DIFF_EXCLUDED_PATTERNS
  ): string {
    if (!diffText || typeof diffText !== 'string') {
      return '';
    }

    const chunks = this.splitDiffIntoFiles(diffText);
    if (chunks.length === 0) {
      return diffText;
    }

    const retainedChunks: string[] = [];
    for (const { file, content } of chunks) {
      if (!file || !this.isExcludedDiffPath(file, excludedPatterns)) {
        retainedChunks.push(content);
      }
    }

    return retainedChunks.join('');
  }

  public static generateDiffStat(diffText: string): string {
    if (!diffText || typeof diffText !== 'string') {
      return '';
    }
    const chunks = this.splitDiffIntoFiles(diffText);
    if (chunks.length === 0) {
      const { additions, deletions } = this.calculateMetrics(diffText);
      if (additions > 0 || deletions > 0) {
        return ` working diff | ${additions + deletions} ${'+'.repeat(Math.min(additions, 20))}${'-'.repeat(Math.min(deletions, 20))}\n 1 file changed, ${additions} insertions(+), ${deletions} deletions(-)`;
      }
      return '';
    }

    const lines: string[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const { file, content } of chunks) {
      const { additions, deletions } = this.calculateMetrics(content);
      totalAdditions += additions;
      totalDeletions += deletions;
      const changes = additions + deletions;
      const pluses = '+'.repeat(Math.min(additions, 20));
      const minuses = '-'.repeat(Math.min(deletions, 20));
      const displayFile = file || 'unknown';
      lines.push(` ${displayFile.padEnd(40)} | ${String(changes).padStart(4)} ${pluses}${minuses}`);
    }

    const fileCount = chunks.length;
    lines.push(
      ` ${fileCount} file${fileCount === 1 ? '' : 's'} changed, ${totalAdditions} insertion${totalAdditions === 1 ? '' : 's'}(+), ${totalDeletions} deletion${totalDeletions === 1 ? '' : 's'}(-)`
    );

    return lines.join('\n');
  }

  public static extractModifiedFiles(diffText: string, filterExcluded = false): string[] {
    if (!diffText || typeof diffText !== 'string') {
      return [];
    }

    const files = new Set<string>();
    const matches = diffText.matchAll(/^diff --git a\/(.+?) b\/(.+?)(?:\r?\n|$)/gm);
    for (const match of matches) {
      const file = (match[2] || match[1] || '').trim();
      if (file) {
        if (!filterExcluded || !this.isExcludedDiffPath(file)) {
          files.add(file);
        }
      }
    }

    if (files.size === 0) {
      const plusMatches = diffText.matchAll(/^\+\+\+ b\/(.+?)(?:\r?\n|$)/gm);
      for (const match of plusMatches) {
        if (match[1] && match[1] !== '/dev/null') {
          const file = match[1].trim();
          if (!filterExcluded || !this.isExcludedDiffPath(file)) {
            files.add(file);
          }
        }
      }
    }

    return Array.from(files);
  }

  public static calculateMetrics(diffText: string): { additions: number; deletions: number } {
    // Which class a diff line belongs to has exactly ONE definition — the
    // module-level classifier above — so metrics and breaking-change detection
    // can never disagree about what a `+` means (#382, D1).
    if (!diffText || typeof diffText !== 'string') {
      return { additions: 0, deletions: 0 };
    }

    let additions = 0;
    let deletions = 0;

    for (const { kind } of classifyDiffLines(diffText)) {
      if (kind === 'content-add') additions++;
      else if (kind === 'content-remove') deletions++;
    }

    return { additions, deletions };
  }

  public static detectBreakingChanges(diffText: string, context?: DiffAnalysisContext): boolean {
    if (context?.isBreaking) {
      return true;
    }

    if (context?.issueTitle && /BREAKING[ -]CHANGE/i.test(context.issueTitle)) {
      return true;
    }

    if (context?.userInstructions && /BREAKING[ -]CHANGE/i.test(context.userInstructions)) {
      return true;
    }

    if (!diffText || typeof diffText !== 'string') {
      return false;
    }

    // #382 D1: match the token and the footer ONLY on a content line. A token
    // in a context block, a hunk-header trailer, a file-header path or a meta
    // line merely *appears*; it does not declare the change breaking. Both
    // tests survive (narrowed, never removed): the `includes` half catches the
    // bare `BREAKING CHANGE:` footer, which the `(.+)` footer regex cannot.
    for (const { kind, content } of classifyDiffLines(diffText)) {
      if (kind !== 'content-add' && kind !== 'content-remove') continue;
      if (content.includes(TOKEN_BREAKING_CHANGE)) return true;
      if (REGEX_BREAKING_CHANGE_FOOTER.test(content)) return true;
    }
    return false;
  }

  /**
   * Infers the conventional-commit SCOPE from the changed files (#345 in #339).
   *
   * A pure function of the SET of files: any permutation yields the same scope.
   * The rule, stated here because the AC requires the tie-break (including
   * keyword-before-directory precedence) to live in code, not folklore:
   *
   *  1. `explicitScope` wins (unchanged sanitisation).
   *  2. An empty file set is `null`.
   *  3. `allMarkdown` := every changed file ends in `.md`.
   *  4. Per file — ONE score, first match wins:
   *     a. keyword scopes, matched ONLY against files under `src/` — a test or
   *        docs filename can no longer out-vote a module (audit extra E3):
   *        critique|reviewer|review → `reviewer`(3); quality-gate|gate → `gate`(3);
   *        commit → `commit`(3); planner|discovery → `planner`(3);
   *        implementer|implementation → `implementer`(3);
   *        state-machine|state-repository → `state`(2).
   *        KEYWORD BEFORE DIRECTORY: `src/application/run-review.ts` scores
   *        `reviewer`, not `app`.
   *     b. directory scopes (still src/-gated): src/domain → `domain`(2),
   *        src/ports → `ports`(2), src/application → `app`(2),
   *        src/infrastructure → `infra`(2), src/presentation|bin → `cli`(2).
   *     c. `.github/` → `ci`(2).
   *     d. else, when EVERY changed file is markdown → `docs`(1): a
   *        documentation scope may only win a markdown-only diff (AC-4.1).
   *     e. else → no score: `docs` can never win a mixed diff.
   *  5. Selection: highest total score; ties broken by (i) the scope with the
   *     higher maximum per-file weight — keyword-backed beats directory-backed
   *     beats docs — then (ii) the lexicographically smallest scope name.
   *     Keys are iterated in sorted order: never "first to reach the maximum",
   *     so the result is independent of the order files appear in the diff.
   */
  public static inferScope(files: readonly string[], explicitScope?: string | null): string | null {
    if (explicitScope && typeof explicitScope === 'string') {
      // eslint-disable-next-line no-useless-escape
      const clean = explicitScope.trim().toLowerCase().replace(/[^a-z0-9_.\-\/]/g, '');
      if (clean.length > 0) {
        return clean;
      }
    }

    if (files.length === 0) {
      return null;
    }

    const allMarkdown = files.every((file) => file.toLowerCase().endsWith('.md'));

    // scope -> total score + the highest per-file weight that fed it.
    const scores = new Map<string, { total: number; maxWeight: number }>();
    const recordScore = (scopeName: string, weight: number): void => {
      const entry = scores.get(scopeName);
      if (entry) {
        entry.total += weight;
        if (weight > entry.maxWeight) {
          entry.maxWeight = weight;
        }
      } else {
        scores.set(scopeName, { total: weight, maxWeight: weight });
      }
    };

    for (const file of files) {
      const lower = file.toLowerCase();
      // Keyword scopes describe MODULES; they may only match src/ paths, never
      // the test/docs filenames that merely contain the word (audit extra E3).
      const underSrc = lower.startsWith('src/');

      if (underSrc && (lower.includes('critique') || lower.includes('reviewer') || lower.includes('review'))) {
        recordScore('reviewer', 3);
      } else if (underSrc && (lower.includes('quality-gate') || lower.includes('gate'))) {
        recordScore('gate', 3);
      } else if (underSrc && lower.includes('commit')) {
        recordScore('commit', 3);
      } else if (underSrc && (lower.includes('planner') || lower.includes('discovery'))) {
        recordScore('planner', 3);
      } else if (underSrc && (lower.includes('implementer') || lower.includes('implementation'))) {
        recordScore('implementer', 3);
      } else if (underSrc && (lower.includes('state-machine') || lower.includes('state-repository'))) {
        recordScore('state', 2);
      } else if (lower.startsWith('src/domain/')) {
        recordScore('domain', 2);
      } else if (lower.startsWith('src/ports/')) {
        recordScore('ports', 2);
      } else if (lower.startsWith('src/application/')) {
        recordScore('app', 2);
      } else if (lower.startsWith('src/infrastructure/')) {
        recordScore('infra', 2);
      } else if (lower.startsWith('src/presentation/') || lower.startsWith('bin/')) {
        recordScore('cli', 2);
      } else if (lower.startsWith('.github/')) {
        recordScore('ci', 2);
      } else if (allMarkdown) {
        // Markdown-only diffs only: `docs` never scores in a mixed diff.
        recordScore('docs', 1);
      }
    }

    if (scores.size === 0) {
      return null;
    }

    // Sorted iteration + strict improvement = the stated tie-break (weight
    // class, then lexicographic), never "first to reach the maximum".
    let topScope: string | null = null;
    let topTotal = -1;
    let topWeight = -1;
    for (const scope of [...scores.keys()].sort()) {
      const entry = scores.get(scope) as { total: number; maxWeight: number };
      if (entry.total > topTotal || (entry.total === topTotal && entry.maxWeight > topWeight)) {
        topScope = scope;
        topTotal = entry.total;
        topWeight = entry.maxWeight;
      }
    }

    return topScope;
  }

  public static inferType(
    files: readonly string[],
    context?: DiffAnalysisContext
  ): ConventionalCommitType {
    if (context?.explicitType && typeof context.explicitType === 'string') {
      const cand = context.explicitType.trim().toLowerCase();
      if (CONVENTIONAL_COMMIT_TYPES.includes(cand as ConventionalCommitType)) {
        return cand as ConventionalCommitType;
      }
    }

    const titleAndInstructions = `${context?.issueTitle || ''} ${context?.userInstructions || ''}`.toLowerCase();

    // Check file classifications first for dedicated areas
    if (files.length > 0) {
      const allTests = files.every(
        (f) => f.startsWith('tests/') || f.endsWith('.test.ts') || f.endsWith('.spec.ts')
      );
      if (allTests) {
        return COMMIT_TYPE_TEST;
      }

      const allDocs = files.every((f) => f.endsWith('.md') || f.startsWith('docs/'));
      if (allDocs) {
        return COMMIT_TYPE_DOCS;
      }

      const allCi = files.every((f) => f.startsWith('.github/'));
      if (allCi) {
        return COMMIT_TYPE_CI;
      }

      const allBuild = files.every(
        (f) =>
          f === 'package.json' ||
          f === 'package-lock.json' ||
          f.startsWith('tsconfig') ||
          f.endsWith('.lock')
      );
      if (allBuild) {
        return COMMIT_TYPE_BUILD;
      }
    }

    // Context analysis for bug / fix keywords
    if (
      titleAndInstructions.includes('[bug]') ||
      titleAndInstructions.includes(' fix ') ||
      titleAndInstructions.includes('fix:') ||
      titleAndInstructions.includes('fixing ') ||
      titleAndInstructions.includes('defect') ||
      titleAndInstructions.includes('patch') ||
      titleAndInstructions.includes('resolve ') ||
      titleAndInstructions.includes('crash')
    ) {
      return COMMIT_TYPE_FIX;
    }

    // Context analysis for performance
    if (
      titleAndInstructions.includes('[perf]') ||
      titleAndInstructions.includes('perf:') ||
      titleAndInstructions.includes('performance') ||
      titleAndInstructions.includes('optimize') ||
      titleAndInstructions.includes('speed')
    ) {
      return COMMIT_TYPE_PERF;
    }

    // Context analysis for refactor
    if (
      titleAndInstructions.includes('[refactor]') ||
      titleAndInstructions.includes('refactor:') ||
      titleAndInstructions.includes('refactoring') ||
      titleAndInstructions.includes('restructure') ||
      titleAndInstructions.includes('clean up')
    ) {
      return COMMIT_TYPE_REFACTOR;
    }

    // Context analysis for feature / task
    if (
      titleAndInstructions.includes('[task]') ||
      titleAndInstructions.includes('[feat]') ||
      titleAndInstructions.includes('[feature]') ||
      titleAndInstructions.includes('implement') ||
      titleAndInstructions.includes('add ') ||
      titleAndInstructions.includes('support ') ||
      titleAndInstructions.includes('introduce ')
    ) {
      return COMMIT_TYPE_FEAT;
    }

    // Default to feat if new non-test files are added, else chore
    const hasSourceChanges = files.some((f) => f.startsWith('src/'));
    return hasSourceChanges ? COMMIT_TYPE_FEAT : COMMIT_TYPE_CHORE;
  }

  public static cleanDescription(title: string | null | undefined, fallback: string): string {
    if (!title || typeof title !== 'string') {
      return fallback;
    }

    let cleaned = title.trim();

    // Strip [Task] Phase X:, [Bug], [Feature], etc.
    cleaned = cleaned.replace(REGEX_LEADING_CONVENTIONAL_PREFIX, '');

    // #345 in #339 (AC-4.3): milestone tags (`[Phase 6]`, `[Phase 5]`, …) and
    // kind tags (`[Bug]`, `[Feature]`, `[Enhancement]`, `[Refactor]`) are
    // stripped WHEREVER they appear — the anchored prefix strip above only
    // caught a leading form, so the tags survived mid-string and propagated
    // into the release notes `ajxcodes/auto-tag` builds from commit subjects.
    cleaned = cleaned.replace(REGEX_MILESTONE_TAG, ' ').replace(REGEX_KIND_TAG, ' ');

    // Collapse the gaps the global strips left behind.
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Strip trailing periods
    cleaned = cleaned.replace(/\.+$/, '').trim();

    if (cleaned.length === 0) {
      return fallback;
    }

    // Lowercase the first word/letter
    return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  }

  public static analyzeDiff(diffText: string, context?: DiffAnalysisContext): DraftCommitPlan {
    const modifiedFiles = Object.freeze(this.extractModifiedFiles(diffText));
    const { additions, deletions } = this.calculateMetrics(diffText);
    const isBreaking = this.detectBreakingChanges(diffText, context);
    const inferredType = this.inferType(modifiedFiles, context);
    const inferredScope = this.inferScope(modifiedFiles, context?.explicitScope);

    let issueNumber: number | null = null;
    if (context?.issueNumber !== undefined && context?.issueNumber !== null) {
      const num = Number(context.issueNumber);
      if (Number.isInteger(num) && num > 0) {
        issueNumber = num;
      }
    } else if (context?.issueTitle) {
      const match = context.issueTitle.match(REGEX_ISSUE_NUMBER_REF);
      if (match && match[1]) {
        issueNumber = parseInt(match[1], 10);
      }
    }

    const fallbackDescription = inferredScope
      ? `update ${inferredScope} components and verification`
      : 'update codebase implementation';

    const description = this.cleanDescription(context?.issueTitle, fallbackDescription);

    // #339 (audit extra E2): a markdown-only diff infers type `docs` AND scope
    // `docs`, which rendered `docs(docs): …`. The scope stays on the plan for
    // reporting, but the MESSAGE drops the duplicate.
    const messageScope =
      inferredType === COMMIT_TYPE_DOCS && inferredScope === 'docs' ? null : inferredScope;

    const commitMessage = CommitMessage.create({
      type: inferredType,
      scope: messageScope,
      description,
      isBreaking,
      issueNumber
    });

    return {
      commitMessage,
      modifiedFiles,
      additions,
      deletions,
      inferredType,
      inferredScope,
      isBreaking
    };
  }
}
