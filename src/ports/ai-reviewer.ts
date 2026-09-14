/**
 * agyloop - AiReviewerPort Inversion of Control Interface
 *
 * Contract for resolving the AI reviewer executable and conducting pre-commit/PR reviews.
 * Depends strictly on src/domain/ with zero direct I/O modules.
 */

import { AiReviewReport } from '../domain/value-objects/ai-review-report';
import { ResolverSource } from '../domain/constants';

export interface AiReviewOptions {
  readonly cwd?: string;
  readonly staged?: boolean;
  readonly baseRef?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bypass?: boolean;
}

export interface AiReviewerResolution {
  readonly source: ResolverSource;
  readonly path: string | null;
  readonly isAvailable: boolean;
}

export interface AiReviewerPort {
  /**
   * Resolves the location and availability of the ai-reviewer executable using the hierarchy:
   * 1. Bundled bin/ai-reviewer.js (or launcher) in repository/plugin
   * 2. ~/.local/bin/ai-reviewer
   * 3. System $PATH
   *
   * @param cwd - Optional working directory context.
   * @returns Resolution record indicating source, path, and availability.
   */
  resolveReviewer(cwd?: string): Promise<AiReviewerResolution> | AiReviewerResolution;

  /**
   * Executes AI review on working diff (staged or unstaged) and returns the structured domain report.
   *
   * @param options - Execution options.
   * @returns Structured AiReviewReport.
   */
  review(options?: AiReviewOptions): Promise<AiReviewReport>;
}
