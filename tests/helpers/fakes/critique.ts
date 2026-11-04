/**
 * agyloop - ONE canonical CritiquePort double (issue #544 / AC2)
 * Retires `CritiqueDouble` / `CritiqueDouble`.
 */

import type { CritiquePort, CritiqueOptions } from '../../../src/ports';

const { AiReviewReport } = require('../../../dist/domain');

interface FakeCritiqueOptions {
  /** `resolveReviewer` body. Default: an available mocked bogus path. */
  resolution?: Record<string, unknown>;
  /** `review` body; default the domain report's zero-finding parse. */
  report?: Record<string, unknown>;
  /** `getVersion` body; null = unresolvable. */
  version?: string | null;
  /** When set, review() throws (critique-failure fixtures). */
  reviewError?: Error;
}

class FakeCritique implements CritiquePort {
  public calls: Record<string, unknown[]> = { resolveReviewer: [], review: [], getVersion: [] };

  public resolution: Record<string, unknown>;
  public report: Record<string, unknown> | null;
  public version: string | null;
  public reviewError?: Error;
  /** What review() was invoked with (the staleness/staged fixtures assert this). */
  public reviewOptions: Array<CritiqueOptions | undefined> = [];

  constructor(options: FakeCritiqueOptions = {}) {
    this.resolution =
      options.resolution ??
      ({ source: 'bundled', path: '/mock/critique.js', isAvailable: true } as Record<string, unknown>);
    this.report = options.report ?? null;
    this.version = options.version === undefined ? '1.0.0' : options.version;
    this.reviewError = options.reviewError;
  }

  public async resolveReviewer(cwd?: string): Promise<never> {
    this.calls.resolveReviewer.push([cwd]);
    return this.resolution as never;
  }

  public async review(options?: CritiqueOptions): Promise<never> {
    this.calls.review.push([options]);
    this.reviewOptions.push(options);
    if (this.reviewError) {
      throw this.reviewError;
    }
    return (this.report ?? AiReviewReport.parse({ findings: [] })) as never;
  }

  public async getVersion(resolvedPath: string): Promise<string | null> {
    this.calls.getVersion.push([resolvedPath]);
    return this.version;
  }
}

module.exports = { FakeCritique };
