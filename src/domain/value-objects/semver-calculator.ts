/**
 * agyloop - SemVerCalculator (Domain Layer)
 *
 * Pure domain engine for evaluating commit streams between main and milestone branches:
 * 1. Predicts SemVer bump: MAJOR > MINOR > PATCH
 * 2. Maps to auto-tag@v1 PR labels (release:major, release:minor, release:patch)
 * 3. Compiles structured, categorized Markdown changelogs
 *
 * Strict Hexagonal Boundary: Zero direct I/O, zero external dependencies.
 */

import {
  RELEASE_BUMP_MAJOR,
  RELEASE_BUMP_MINOR,
  RELEASE_BUMP_PATCH,
  ReleaseBumpType,
  RELEASE_LABEL_MAJOR,
  RELEASE_LABEL_MINOR,
  RELEASE_LABEL_PATCH,
  ReleaseLabelName,
  TOKEN_BREAKING_CHANGE,
  REGEX_BREAKING_CHANGE_FOOTER,
  REGEX_CONVENTIONAL_HEADER
} from '../constants';
import { PublicSanitizer, PublicSanitizerOptions } from './public-sanitizer';

export interface ParsedCommitEntry {
  readonly hash?: string;
  readonly header: string;
  readonly body?: string | null;
  readonly type: string;
  readonly scope: string | null;
  readonly description: string;
  readonly isBreaking: boolean;
}

export interface SemVerEvaluationResult {
  readonly bump: ReleaseBumpType;
  readonly releaseLabel: ReleaseLabelName;
  readonly totalCommits: number;
  readonly featuresCount: number;
  readonly fixesCount: number;
  readonly breakingCount: number;
  readonly changelog: string;
  readonly commits: readonly ParsedCommitEntry[];
}

export class SemVerCalculator {
  /**
   * Parses raw git log lines into structured conventional commit entries.
   */
  public static parseCommit(rawHeader: string, rawBody?: string): ParsedCommitEntry {
    const trimmedHeader = (rawHeader || '').trim();
    const match = trimmedHeader.match(REGEX_CONVENTIONAL_HEADER);

    let isBreaking = false;
    let type = 'chore';
    let scope: string | null = null;
    let description = trimmedHeader;

    if (match && match.groups) {
      type = match.groups.type.toLowerCase();
      scope = match.groups.scope ? match.groups.scope.toLowerCase() : null;
      isBreaking = Boolean(match.groups.breaking);
      description = match.groups.description.trim();
    }

    const body = (rawBody || '').trim();
    if (body) {
      if (
        REGEX_BREAKING_CHANGE_FOOTER.test(body) ||
        body.includes(TOKEN_BREAKING_CHANGE) ||
        body.toLowerCase().includes('breaking change:')
      ) {
        isBreaking = true;
      }
    }

    return {
      header: trimmedHeader,
      body: body || null,
      type,
      scope,
      description,
      isBreaking
    };
  }

  /**
   * Alias for evaluate matching commit list signatures.
   */
  public static evaluateCommits(
    rawCommits: readonly string[],
    options?: { trackerRepo?: string; milestoneTitle?: string }
  ): SemVerEvaluationResult {
    return SemVerCalculator.evaluate(rawCommits, options);
  }

  /**
   * Evaluates a collection of commits to determine SemVer bump and generate changelog.
   */
  public static evaluate(
    rawCommits: readonly (string | { header: string; body?: string; hash?: string })[],
    options?: { trackerRepo?: string; milestoneTitle?: string }
  ): SemVerEvaluationResult {
    const parsedEntries: ParsedCommitEntry[] = [];

    for (const raw of rawCommits) {
      if (typeof raw === 'string') {
        // May contain header and optional body separated by newline
        const lines = raw.split('\n');
        const header = lines[0];
        const body = lines.slice(1).join('\n');
        parsedEntries.push(SemVerCalculator.parseCommit(header, body));
      } else {
        parsedEntries.push({
          ...SemVerCalculator.parseCommit(raw.header, raw.body),
          hash: raw.hash
        });
      }
    }

    let hasBreaking = false;
    let hasFeat = false;
    let featCount = 0;
    let fixCount = 0;
    let breakingCount = 0;

    for (const entry of parsedEntries) {
      if (entry.isBreaking) {
        hasBreaking = true;
        breakingCount++;
      }
      if (entry.type === 'feat') {
        hasFeat = true;
        featCount++;
      } else if (entry.type === 'fix') {
        fixCount++;
      }
    }

    // Determine SemVer bump by strict precedence: MAJOR > MINOR > PATCH
    let bump: ReleaseBumpType = RELEASE_BUMP_PATCH;
    let releaseLabel: ReleaseLabelName = RELEASE_LABEL_PATCH;

    if (hasBreaking) {
      bump = RELEASE_BUMP_MAJOR;
      releaseLabel = RELEASE_LABEL_MAJOR;
    } else if (hasFeat) {
      bump = RELEASE_BUMP_MINOR;
      releaseLabel = RELEASE_LABEL_MINOR;
    }

    const changelog = SemVerCalculator.buildChangelog(parsedEntries, {
      trackerRepo: options?.trackerRepo,
      milestoneTitle: options?.milestoneTitle,
      bump
    });

    return {
      bump,
      releaseLabel,
      totalCommits: parsedEntries.length,
      featuresCount: featCount,
      fixesCount: fixCount,
      breakingCount,
      changelog,
      commits: parsedEntries
    };
  }

  /**
   * Builds structured, categorized Markdown changelog.
   */
  public static buildChangelog(
    commits: readonly ParsedCommitEntry[],
    options?: { trackerRepo?: string; milestoneTitle?: string; bump?: ReleaseBumpType }
  ): string {
    const features: string[] = [];
    const bugFixes: string[] = [];
    const performance: string[] = [];
    const maintenance: string[] = [];
    const breaking: string[] = [];

    const sanitizerOpts: PublicSanitizerOptions = {
      trackerRepo: options?.trackerRepo
    };

    for (const c of commits) {
      const scopeTag = c.scope ? `**${c.scope}:** ` : '';
      const sanitizedDesc = PublicSanitizer.sanitizeCommitMessage(c.description, sanitizerOpts);
      const entryText = `- ${scopeTag}${sanitizedDesc}`;

      if (c.isBreaking) {
        breaking.push(entryText);
      }

      switch (c.type) {
        case 'feat':
          features.push(entryText);
          break;
        case 'fix':
          bugFixes.push(entryText);
          break;
        case 'perf':
          performance.push(entryText);
          break;
        default:
          maintenance.push(entryText);
          break;
      }
    }

    const sections: string[] = [];

    if (options?.milestoneTitle) {
      sections.push(`## ${options.milestoneTitle}`);
    } else {
      sections.push(`## Milestone Release Notes`);
    }

    if (breaking.length > 0) {
      sections.push(`### ⚠️ Breaking Changes\n${breaking.join('\n')}`);
    }

    if (features.length > 0) {
      sections.push(`### Features\n${features.join('\n')}`);
    }

    if (bugFixes.length > 0) {
      sections.push(`### Bug Fixes\n${bugFixes.join('\n')}`);
    }

    if (performance.length > 0) {
      sections.push(`### Performance Improvements\n${performance.join('\n')}`);
    }

    if (maintenance.length > 0) {
      sections.push(`### Maintenance & Refactoring\n${maintenance.join('\n')}`);
    }

    if (commits.length === 0) {
      sections.push('*No constituent task commits found for this release.*');
    }

    return sections.join('\n\n');
  }
}
