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
  /**
   * The headline count: logical DELIVERABLES (the subject plus every bullet a
   * squash body carries), not commit objects (issue #257 / #315 AC-27).
   */
  readonly totalCommits: number;
  /** The git topology: one per commit object in the range. */
  readonly commitObjects: number;
  readonly featuresCount: number;
  readonly fixesCount: number;
  readonly breakingCount: number;
  readonly changelog: string;
  /** The parsed commit objects, one per git commit. */
  readonly commits: readonly ParsedCommitEntry[];
  /** The rendered deliverables: each subject plus each body bullet. */
  readonly deliverables: readonly ParsedCommitEntry[];
}

/**
 * A Markdown bullet at ANY indent depth (`-`, `*` or `+`).
 *
 * Issue #257 / R8: a squash body's secondary deliverables are bullet lines. The
 * real bodies on this branch use `-`, so a `*`-only matcher would pass its own
 * fixture and still drop every real deliverable.
 */
const REGEX_DELIVERABLE_BULLET = /^\s*[-*+]\s+(.+)$/;

/** A conventional-commit subject: `type(scope)!: description`. */
const REGEX_CONVENTIONAL_SUBJECT = REGEX_CONVENTIONAL_HEADER;

/**
 * A body line that ENDS a bullet's wrapped continuation: conventional footers,
 * a heading, or a horizontal rule. A real squash body wraps a bullet over
 * several indented lines, so a one-line-per-bullet reader truncated the entry
 * mid-sentence (issue #315 review, AC-26).
 */
const REGEX_BULLET_CONTINUATION_STOP =
  /^(?:-{3,}|\*{3,}|#{2,}\s|(?:Refs|Closes|Fixes|Resolves|Signed-off-by|Co-authored-by|BREAKING[ -]CHANGE)\b)/i;

/** A trailing issue/PR reference group, e.g. ` (#247) (#253)`. */
const REGEX_TRAILING_REF_GROUP = /(?:\s*\(#\d+\))+\s*$/;

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

    // Issue #257 / AC-26: a squash merge keeps every secondary deliverable in
    // the commit BODY (`%b` is already fetched), so the changelog and the
    // headline metrics are computed over deliverables, not over commit objects.
    const deliverables = SemVerCalculator.expandDeliverables(parsedEntries);

    for (const entry of deliverables) {
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

    const changelog = SemVerCalculator.buildChangelog(deliverables, {
      trackerRepo: options?.trackerRepo,
      milestoneTitle: options?.milestoneTitle,
      bump
    });

    return {
      bump,
      releaseLabel,
      totalCommits: deliverables.length,
      commitObjects: parsedEntries.length,
      featuresCount: featCount,
      fixesCount: fixCount,
      breakingCount,
      changelog,
      commits: parsedEntries,
      deliverables
    };
  }

  /**
   * Expands each commit object into its deliverables (issue #257 / AC-26).
   *
   * The subject is a deliverable only when it is a CONVENTIONAL commit: a merge
   * object (`Merge pull request #331 …`) or any other non-conventional subject
   * is git topology, not work, and counting it both inflated the headline and
   * printed four `Merge pull request` lines into the published changelog
   * (issue #315 review, AC-27).
   *
   * Every bullet a body carries — at any indent depth, with `-`, `*` or `+`,
   * including a bullet that WRAPS over several indented lines — is another
   * deliverable, parsed by the SAME conventional-header parser so it carries its
   * own scope and type. Continuation lines are joined, so an entry is never
   * truncated mid-sentence.
   *
   * Dedupe is global and keyed on the normalised description (trailing
   * `(#<n>)` reference groups stripped): a squash subject that echoes the first
   * body bullet, or a second commit restating the same work, is counted once.
   */
  private static expandDeliverables(
    entries: readonly ParsedCommitEntry[]
  ): ParsedCommitEntry[] {
    const deliverables: ParsedCommitEntry[] = [];
    const seen = new Set<string>();

    const push = (entry: ParsedCommitEntry): void => {
      const key = SemVerCalculator.deliverableKey(entry);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      deliverables.push(entry);
    };

    for (const entry of entries) {
      if (REGEX_CONVENTIONAL_SUBJECT.test(entry.header)) {
        push(entry);
      }
      if (!entry.body) {
        continue;
      }
      for (const bullet of SemVerCalculator.extractDeliverableBullets(entry.body)) {
        push(SemVerCalculator.parseCommit(bullet));
      }
    }
    return deliverables;
  }

  /**
   * The bullet texts a body carries, with each bullet's wrapped continuation
   * lines joined into one entry (issue #315 review, AC-26).
   *
   * A real squash body wraps long bullets: the first line starts with `-` and
   * the next lines are plain indented prose. Reading one line per bullet
   * published the first fragment and dropped the rest of the sentence.
   */
  private static extractDeliverableBullets(body: string): string[] {
    const bullets: string[] = [];
    let current: string[] | null = null;

    const flush = (): void => {
      if (!current) {
        return;
      }
      const joined = current.join(' ').replace(/\s+/g, ' ').trim();
      if (joined.length > 0) {
        bullets.push(joined);
      }
      current = null;
    };

    for (const line of body.split('\n')) {
      const bullet = REGEX_DELIVERABLE_BULLET.exec(line);
      if (bullet) {
        flush();
        current = [bullet[1].trim()];
        continue;
      }

      const trimmed = line.trim();
      if (trimmed.length === 0 || REGEX_BULLET_CONTINUATION_STOP.test(trimmed)) {
        flush();
        continue;
      }

      if (current) {
        current.push(trimmed);
      }
    }
    flush();
    return bullets;
  }

  /**
   * The dedupe key for a deliverable: its description with every trailing
   * `(#<n>)` reference group removed (issue #315 review, AC-27).
   *
   * The same work is referenced as `… (#247)` in one commit and `… (#247)
   * (#253)` in the squash that carries it; without normalising the refs those
   * are two different strings and the deliverable is counted twice.
   */
  private static deliverableKey(entry: ParsedCommitEntry): string {
    return entry.description
      .replace(REGEX_TRAILING_REF_GROUP, '')
      .replace(/\s+/g, ' ')
      .trim();
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
