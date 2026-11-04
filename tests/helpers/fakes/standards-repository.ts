/**
 * agyloop - ONE canonical StandardsRepository double (issue #544 / AC2)
 * Retires the 6 `StandardsRepositoryDouble` copies.
 */

import type { StandardsRepository, StandardsLoadOptions } from '../../../src/ports';

class FakeStandardsRepository implements StandardsRepository {
  public calls: Record<string, unknown[]> = { loadStandards: [], findStandardsPath: [] };

  public standardsText: string | null;
  public standardsPath: string | null;

  constructor(standardsText?: string | null, standardsPath?: string | null) {
    this.standardsText = standardsText === undefined ? 'AGENTS.md standards' : standardsText;
    this.standardsPath = standardsPath === undefined ? 'AGENTS.md' : standardsPath;
  }

  public loadStandards(_options?: StandardsLoadOptions): string | null {
    this.calls.loadStandards.push([_options]);
    return this.standardsText;
  }

  public findStandardsPath(_options?: StandardsLoadOptions): string | null {
    this.calls.findStandardsPath.push([_options]);
    return this.standardsPath;
  }
}

module.exports = { FakeStandardsRepository };
