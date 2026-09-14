/**
 * agyloop - CritiquePort Inversion of Control Interface
 *
 * Contract for resolving the critique CLI executable and conducting pre-commit/PR reviews.
 * Depends strictly on src/domain/ with zero direct I/O modules.
 */

import { AiReviewReport } from '../domain/value-objects/ai-review-report';
import { ResolverSource } from '../domain/constants';

export interface CritiqueOptions {
  readonly cwd?: string;
  readonly staged?: boolean;
  readonly baseRef?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly bypass?: boolean;
}

export interface CritiqueResolution {
  readonly source: ResolverSource;
  readonly path: string | null;
  readonly isAvailable: boolean;
}

export interface CritiquePort {
  /**
   * Resolves the location and availability of the critique executable using the hierarchy:
   * 1. Sibling ../critique
   * 2. Bundled bin/critique.js in repository
   * 3. User data tool directory (LOCALAPPDATA / Application Support / .local/share)
   * 4. User-local ~/.local/bin/critique
   * 5. System $PATH
   *
   * @param cwd - Optional working directory context.
   * @returns Resolution record indicating source, path, and availability.
   */
  resolveReviewer(cwd?: string): Promise<CritiqueResolution> | CritiqueResolution;

  /**
   * Executes critique review on working diff (staged or unstaged) and returns the structured domain report.
   *
   * @param options - Execution options.
   * @returns Structured AiReviewReport.
   */
  review(options?: CritiqueOptions): Promise<AiReviewReport>;
}

// Backwards compatibility aliases
export type AiReviewOptions = CritiqueOptions;
export type AiReviewerResolution = CritiqueResolution;
export type AiReviewerPort = CritiquePort;
