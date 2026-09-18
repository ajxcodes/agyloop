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
  REGEX_DIFF_FILE_HEADER,
  REGEX_BREAKING_CHANGE_FOOTER,
  REGEX_ISSUE_NUMBER_REF,
  REGEX_LEADING_CONVENTIONAL_PREFIX,
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
      const match = trimmed.match(/diff --git a\/(.+?) b\/(.+?)(?:\r?\n|$)/);
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
    const matches = diffText.matchAll(/diff --git a\/(.+?) b\/(.+?)(?:\r?\n|$)/g);
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
    if (!diffText || typeof diffText !== 'string') {
      return { additions: 0, deletions: 0 };
    }

    let additions = 0;
    let deletions = 0;
    const lines = diffText.split('\n');

    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) {
        continue;
      }
      if (line.startsWith('+')) {
        additions++;
      } else if (line.startsWith('-')) {
        deletions++;
      }
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

    return REGEX_BREAKING_CHANGE_FOOTER.test(diffText) || diffText.includes(TOKEN_BREAKING_CHANGE);
  }

  public static inferScope(files: readonly string[], explicitScope?: string | null): string | null {
    if (explicitScope && typeof explicitScope === 'string') {
      const clean = explicitScope.trim().toLowerCase().replace(/[^a-z0-9_.\-\/]/g, '');
      if (clean.length > 0) {
        return clean;
      }
    }

    if (files.length === 0) {
      return null;
    }

    const scopeScores = new Map<string, number>();

    const recordScore = (scopeName: string, weight = 1) => {
      scopeScores.set(scopeName, (scopeScores.get(scopeName) || 0) + weight);
    };

    for (const file of files) {
      const lower = file.toLowerCase();

      if (lower.includes('critique') || lower.includes('reviewer') || lower.includes('review')) {
        recordScore('reviewer', 3);
      } else if (lower.includes('quality-gate') || lower.includes('gate')) {
        recordScore('gate', 3);
      } else if (lower.includes('commit')) {
        recordScore('commit', 3);
      } else if (lower.includes('planner') || lower.includes('discovery')) {
        recordScore('planner', 3);
      } else if (lower.includes('implementer') || lower.includes('implementation')) {
        recordScore('implementer', 3);
      } else if (lower.includes('state-machine') || lower.includes('state-repository')) {
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
      } else if (lower.endsWith('.md') || lower.startsWith('docs/')) {
        recordScore('docs', 1);
      }
    }

    let topScope: string | null = null;
    let maxScore = 0;

    for (const [scope, score] of scopeScores.entries()) {
      if (score > maxScore) {
        maxScore = score;
        topScope = scope;
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

    const commitMessage = CommitMessage.create({
      type: inferredType,
      scope: inferredScope,
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
