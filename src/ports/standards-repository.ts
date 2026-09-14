/**
 * agyloop - StandardsRepository Port Interface
 *
 * Inversion of control contract for discovering and loading repository-level
 * standards, guidelines, and quality rules.
 * Depends strictly on src/domain/ with zero direct I/O modules.
 */

export interface StandardsLoadOptions {
  readonly customPath?: string | null;
  readonly cwd?: string;
}

export interface StandardsRepository {
  /**
   * Discovers and loads repository-level standards text from disk.
   * Resolves candidate standards files in priority order:
   * 1. customPath (if provided)
   * 2. .github/ai-reviewer-standards.md
   * 3. AGENTS.md
   * 4. STANDARDS.md
   * 5. .github/CONTRIBUTING.md
   * 6. CONTRIBUTING.md
   * 7. docs/standards.md
   *
   * Returns file content string or null if no standards file is discovered.
   */
  loadStandards(options?: StandardsLoadOptions): string | null;

  /**
   * Resolves the detected path of the repository standards file, or null if none found.
   */
  findStandardsPath(options?: StandardsLoadOptions): string | null;
}
