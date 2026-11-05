/**
 * codeloop - ProjectScaffolderPort Interface
 *
 * Inversion of control contract for filesystem concerns of `codeloop init`:
 * marker discovery, config persistence and .gitignore hygiene.
 */

import { VerificationConfig } from './config-repository';

export interface SubprojectMarkers {
  /** Repo-relative POSIX directory, e.g. 'apps/web'. */
  readonly path: string;
  /** Ecosystem types detected in that directory, priority-ordered. */
  readonly ecosystems: readonly string[];
  /** Local lockfile package manager, or null when only the root declares one. */
  readonly packageManager: string | null;
  /** That directory's own `package.json` scripts. */
  readonly scripts: Readonly<Record<string, string>>;
  readonly e2eTool: string | null;
  readonly migrationTool: string | null;
}

export interface ProjectMarkers {
  readonly monorepo: boolean;
  readonly dockerCompose: boolean;
  readonly migrationTool: string | null;
  /** Repo-relative directory the migration marker was found in (null at the root). */
  readonly migrationPath: string | null;
  readonly e2eTool: string | null;
  /** Repo-relative directory the E2E marker was found in (null at the root). */
  readonly e2ePath: string | null;
  /** Root lockfile package manager, else pnpm for a pnpm workspace, else null. */
  readonly packageManager: string | null;
  readonly hasBackendMarkers: boolean;
  readonly hasFrontendMarkers: boolean;
  readonly packageScripts: Readonly<Record<string, string>>;
  /** Discovered subprojects (#334); optional so existing doubles still type-check. */
  readonly subprojects?: readonly SubprojectMarkers[];
}

export interface LegacyLayout {
  readonly legacyConfigPath: string | null;
  readonly legacyStateDirExists: boolean;
}

export interface GitIgnoreChange {
  /** Rules newly appended (including negations that protect config files). */
  readonly added: string[];
  /** Pre-existing blanket lines that were replaced by granular rules. */
  readonly replaced: string[];
  /** Optional warnings when broad or indirect ignore rules might affect tracked config. */
  readonly warnings?: string[];
}

export interface ProjectScaffolderPort {
  /** Scans the workspace for fullstack/monorepo/service/migration/e2e markers. */
  detectMarkers(workspaceDir: string): Promise<ProjectMarkers>;

  /** Derives a multi-tier verification profile from detected markers and gate commands. */
  buildVerificationProfile(markers: ProjectMarkers, ecosystem: string, gateCommands: readonly { id: string; label: string; command: string }[]): VerificationConfig;

  /** Returns the existing config location (codeloop first, then legacy codeloop) or null. */
  findExistingConfig(workspaceDir: string): string | null;

  /** Absolute path of the canonical `.codeloop/config.json`. */
  getConfigPath(workspaceDir: string): string;

  /** Absolute paths of legacy codeloop config candidates. */
  getLegacyConfigPaths(workspaceDir: string): string[];

  /** Reports legacy .agyloop layout details. */
  detectLegacyLayout(workspaceDir: string): LegacyLayout;

  /** Atomically writes `.codeloop/config.json`; returns its absolute path. */
  writeConfig(workspaceDir: string, config: unknown): string;

  /** Reads a JSON config file or returns null when unreadable. */
  readConfig(configPath: string): Record<string, unknown> | null;

  /** Adds granular ignore rules and reconciles blanket ignores that hide config files. */
  updateGitIgnore(workspaceDir: string, rules: readonly string[]): GitIgnoreChange;

  /** Computes what updateGitIgnore would change, without writing anything. */
  previewGitIgnore(workspaceDir: string, rules: readonly string[]): GitIgnoreChange;
}
