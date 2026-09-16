/**
 * agyloop - PublicSanitizer (Domain Layer)
 *
 * Pure domain sanitizer ensuring public commit messages, diff summaries,
 * and PR descriptions never leak internal/private tracker URLs or cross-repo references.
 *
 * Strict Hexagonal Boundary: Zero direct I/O, zero external dependencies.
 */

import { DEFAULT_TRACKER_REPO } from '../constants';

export interface PublicSanitizerOptions {
  readonly trackerRepo?: string; // e.g. 'ajxcodes/projects'
  readonly allowedRepo?: string; // current public repo
}

export class PublicSanitizer {
  /**
   * Sanitizes a single-line or multi-line commit message header/body.
   */
  public static sanitizeCommitMessage(
    rawMessage: string,
    options?: PublicSanitizerOptions
  ): string {
    if (!rawMessage || typeof rawMessage !== 'string') {
      return '';
    }

    const tracker = options?.trackerRepo || DEFAULT_TRACKER_REPO;
    const escapedTracker = tracker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let sanitized = rawMessage;

    // 1. Remove "Closes <tracker>#<id>" or "Fixes <tracker>#<id>"
    const closesRegex = new RegExp(
      `(?:closes|fixes|resolves)\\s+${escapedTracker}#(\\d+)`,
      'gi'
    );
    sanitized = sanitized.replace(closesRegex, 'resolves #$1');

    // 2. Full URL for tracker -> #id
    const fullUrlRegex = new RegExp(
      `https?:\\/\\/github\\.com\\/${escapedTracker}\\/issues\\/(\\d+)`,
      'gi'
    );
    sanitized = sanitized.replace(fullUrlRegex, '#$1');

    // 3. Strip tracker qualification: (ajxcodes/projects#88) -> (#88)
    sanitized = sanitized.replace(new RegExp(`\\(${escapedTracker}#(\\d+)\\)`, 'gi'), '(#$1)');

    // 4. Plain tracker reference: ajxcodes/projects#88 -> #88
    const trackerRefRegex = new RegExp(`${escapedTracker}#(\\d+)`, 'gi');
    sanitized = sanitized.replace(trackerRefRegex, '#$1');

    // 5. Generic private tracker URL suppression: transform any full issue URLs to bare issue hashes
    sanitized = sanitized.replace(
      /https?:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/issues\/(\d+)/g,
      '#$1'
    );

    return sanitized.trim();
  }

  /**
   * Sanitizes markdown PR descriptions and changelog bodies.
   */
  public static sanitizeMarkdown(
    markdown: string,
    options?: PublicSanitizerOptions
  ): string {
    if (!markdown || typeof markdown !== 'string') {
      return '';
    }

    const tracker = options?.trackerRepo || DEFAULT_TRACKER_REPO;
    const escaped = tracker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let result = markdown;

    // 1. [text](https://github.com/tracker/issues/123) -> text
    const linkRegex = new RegExp(
      `\\[([^\\]]+)\\]\\(https?:\\/\\/github\\.com\\/${escaped}\\/issues\\/\\d+\\)`,
      'gi'
    );
    result = result.replace(linkRegex, '$1');

    // 2. Direct URL references: https://github.com/tracker/issues/123 -> #123
    const rawUrlRegex = new RegExp(
      `https?:\\/\\/github\\.com\\/${escaped}\\/issues\\/(\\d+)`,
      'gi'
    );
    result = result.replace(rawUrlRegex, '#$1');

    // 3. Closes tracker#id -> resolves #id
    const closesTrackerRegex = new RegExp(
      `(?:closes|fixes|resolves)\\s+${escaped}#(\\d+)`,
      'gi'
    );
    result = result.replace(closesTrackerRegex, 'resolves #$1');

    // 4. Plain tracker reference: tracker#123 -> #123
    const trackerRefRegex = new RegExp(`${escaped}#(\\d+)`, 'gi');
    result = result.replace(trackerRefRegex, '#$1');

    // 5. Generic URL suppression: transform any full issue URLs to bare issue hashes
    result = result.replace(
      /https?:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/issues\/(\d+)/g,
      '#$1'
    );

    return result;
  }
}
